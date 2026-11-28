/**
 * 独立入口连接 / 断开 DeepSeek Harness。
 *
 * 依据是插件写下的本机发现文件与接入服务（见 shared/mido-attach、host/plugin/desktop/attach-host），
 * 不是虚构的 DSH 官方 attach API。连上后把桌面 Helper 的配置地址切到插件接入服务，
 * 同一只宠物即可使用宿主的聊天、任务状态和配图；断开后回到本机独立服务。
 * 连接失败必须给出中文原因，不得静默失败。
 * @module dsh-pet/src/app/dsh-connect
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  ATTACH_TOKEN_HEADER,
  HOST_DISCOVERY_FILE,
  HOST_KIND,
  STANDALONE_DISCOVERY_FILE,
  STANDALONE_KIND,
  buildDiscovery,
  discoveryPath,
  readLiveDiscovery,
  type DiscoveryRecord,
} from '../shared/mido-attach.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';

/** 一次连接或断开的结果，给菜单、设置页和日志用。 */
export interface ConnectResult {
  /** 是否成功。 */
  readonly ok: boolean;
  /** 给用户看的中文说明。 */
  readonly message: string;
}

/** 当前连接状态。 */
export interface ConnectStatus {
  /** standalone = 仅本机运行；dsh = 已接到 DeepSeek Harness。 */
  readonly mode: 'standalone' | 'dsh';
  /** 给设置页 / 托盘看的中文状态。 */
  readonly message: string;
  /** 现在能否发起手动连接。 */
  readonly canConnect: boolean;
  /** 现在能否断开。 */
  readonly canDisconnect: boolean;
  /** 最近一次失败原因（没有则为空串）。 */
  readonly lastError: string;
}

/** 交给桌面 Helper 的切换参数。 */
export interface RetargetSession {
  /** 宠物配置地址。 */
  readonly configUrl: string;
  /** 菜单「打开」用的已鉴权入口；独立模式为本机设置页。 */
  readonly siteUrl: string;
  /** 菜单首项去向。 */
  readonly openTarget: 'desktop' | 'standalone' | 'web';
  /** 访问配置地址时要带的令牌。 */
  readonly token: string;
  /** 是否已接到 DSH。 */
  readonly connected: boolean;
  /** 宿主配置中显示在桌面的宠物，旧版本可以省略。 */
  readonly pets?: Array<{ id: string; size: number }>;
}

/** 连接器依赖。 */
export interface DshConnectOptions {
  /** `$DSH_HOME`。 */
  dshHome: string;
  /** 本机独立服务 origin。 */
  localOrigin: () => string;
  /** 本机独立服务令牌。 */
  localToken: () => string;
  /** 本机设置页的已鉴权地址。 */
  localSiteUrl: () => string;
  /** 包版本，写入发现记录。 */
  version: string;
  /** 写日志（不得包含令牌或 siteUrl）。 */
  log(message: string): void;
  /** 把桌面 Helper 切到新的配置地址；窗口可以重建，但不要再拉起第二只进程。 */
  retarget(session: RetargetSession): Promise<void>;
}

/** 插件 session 接口的最小形状。 */
interface HostSession {
  ok?: boolean;
  openTarget?: string;
  configUrl?: string;
  siteUrl?: string;
  pets?: RetargetSession['pets'];
}

const CONNECT_TIMEOUT_MS = 2500;
// 宿主需要先退出旧 Helper（3 秒超时及 1 秒强制退出宽限）。
const HANDOFF_TIMEOUT_MS = 5000;

/**
 * 带超时的本机 fetch；失败时抛中文错误。
 */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: ac.signal, cache: 'no-store' });
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
      throw new Error(err || `接入服务返回 HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('连接超时，DeepSeek Harness 没有在限定时间内应答', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把进程列表文本判断成「像 DeepSeek Harness 正在运行」。
 * 只作补充提示，不能单靠它断定插件已就绪。
 * @param listing - 任务列表或类似文本。
 */
export function lookLikeDshProcess(listing: string): boolean {
  const text = listing.toLowerCase();
  return text.includes('deepseek harness') || text.includes('deepseek-harness') || /\bdeepseekharness\b/.test(text);
}

/**
 * 本机独立运行时应注入 Helper 的会话。
 */
export function localSession(
  opts: Pick<DshConnectOptions, 'localOrigin' | 'localToken' | 'localSiteUrl'>,
): RetargetSession {
  return {
    configUrl: `${opts.localOrigin()}${ROUTE_SEGMENT}/config`,
    siteUrl: opts.localSiteUrl(),
    openTarget: 'standalone',
    token: opts.localToken(),
    connected: false,
  };
}

function sameHost(left: DiscoveryRecord | undefined, right: DiscoveryRecord): boolean {
  return left?.pid === right.pid && left.origin === right.origin && left.token === right.token;
}

function sameHostConfig(left: DiscoveryRecord | undefined, right: DiscoveryRecord): boolean {
  return sameHost(left, right) && left?.configRevision === right.configRevision;
}

/**
 * 创建独立入口的连接器。
 */
export function createDshConnect(opts: DshConnectOptions) {
  const standaloneFile = discoveryPath(opts.dshHome, STANDALONE_DISCOVERY_FILE);
  let mode: 'standalone' | 'dsh' = 'standalone';
  let lastError = '';
  let disposed = false;
  let helperReady = false;
  let watchTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let connecting = false;
  let watching = false;
  let autoConnectEnabled = true;
  let connectionGeneration = 0;
  let activeHost: DiscoveryRecord | undefined;
  let lastSession: RetargetSession = localSession(opts);
  let retargetQueue = Promise.resolve();

  const writeStandaloneFile = (): void => {
    const origin = opts.localOrigin();
    if (!origin) return;
    mkdirSync(dirname(standaloneFile), { recursive: true });
    const record = buildDiscovery({
      kind: STANDALONE_KIND,
      pid: process.pid,
      origin,
      token: opts.localToken(),
      version: opts.version,
    });
    writeFileSync(standaloneFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  };

  const removeStandaloneFile = (): void => {
    try {
      unlinkSync(standaloneFile);
    } catch {
      /* 忽略 */
    }
  };

  const currentHost = (): DiscoveryRecord | undefined =>
    readLiveDiscovery(opts.dshHome, HOST_DISCOVERY_FILE, HOST_KIND);

  const status = (): ConnectStatus => {
    if (mode === 'dsh') {
      return {
        mode,
        message: '已连接到 DeepSeek Harness。聊天、任务状态和配图会走宿主；右键「打开软件」可打开 DSH。',
        canConnect: false,
        canDisconnect: true,
        lastError,
      };
    }
    if (!autoConnectEnabled) {
      return {
        mode,
        message: '已手动断开 DeepSeek Harness。需要时可重新连接。',
        canConnect: true,
        canDisconnect: false,
        lastError,
      };
    }
    if (currentHost()) {
      return {
        mode,
        message: '检测到 DeepSeek Harness 中的米豆插件已就绪，可以连接。也可以点「连接 DeepSeek Harness」。',
        canConnect: true,
        canDisconnect: false,
        lastError,
      };
    }
    return {
      mode,
      message:
        lastError || '当前是独立运行。打开 DeepSeek Harness（desktop 配置）后会自动连接；也可以在菜单里手动连接。',
      canConnect: true,
      canDisconnect: false,
      lastError,
    };
  };

  const applySession = async (
    session: RetargetSession,
    host: DiscoveryRecord | undefined,
    generation: number,
  ): Promise<boolean> => {
    const apply = async (): Promise<boolean> => {
      if (disposed || generation !== connectionGeneration || (host && !sameHostConfig(currentHost(), host)))
        return false;
      if (helperReady) await opts.retarget(session);
      if (disposed || generation !== connectionGeneration) return false;
      lastSession = session;
      activeHost = host;
      mode = session.connected ? 'dsh' : 'standalone';
      return true;
    };
    if (!helperReady) return apply();
    // 窗口重建串行，避免早先的切换在后一次操作完成后生效。
    const result = retargetQueue.then(apply);
    retargetQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const readHostSession = async (host: DiscoveryRecord): Promise<RetargetSession> => {
    const health = await fetchJson(`${host.origin}/mido-attach/health`, {});
    if (!health || typeof health !== 'object' || (health as { kind?: string }).kind !== HOST_KIND) {
      throw new Error('找到了本机接入端口，但那不是米豆插件的接入服务');
    }
    const session = (await fetchJson(
      `${host.origin}/mido-attach/session`,
      { [ATTACH_TOKEN_HEADER]: host.token },
      HANDOFF_TIMEOUT_MS,
    )) as HostSession;
    if (
      !session ||
      session.ok !== true ||
      typeof session.configUrl !== 'string' ||
      typeof session.siteUrl !== 'string'
    ) {
      throw new Error('米豆插件已就绪，但没有返回可用的会话信息');
    }
    if (new URL(session.configUrl).origin !== new URL(host.origin).origin) {
      throw new Error('米豆插件返回的配置地址与接入端口不一致');
    }
    const openTarget =
      session.openTarget === 'web' || session.openTarget === 'standalone' ? session.openTarget : 'desktop';
    const pets = Array.isArray(session.pets)
      ? session.pets.filter((pet) => typeof pet?.id === 'string' && Number.isFinite(pet.size) && pet.size > 0)
      : undefined;
    return {
      configUrl: session.configUrl,
      siteUrl: session.siteUrl,
      openTarget,
      token: host.token,
      connected: true,
      pets,
    };
  };

  const connectHost = async (host: DiscoveryRecord): Promise<ConnectResult> => {
    connecting = true;
    const generation = connectionGeneration;
    try {
      const session = await readHostSession(host);
      if (!(await applySession(session, host, generation))) {
        return { ok: false, message: '接入状态已变化，请重新连接。' };
      }
      lastError = '';
      opts.log('已连接到 DeepSeek Harness，桌面上仍是这一只米豆');
      return { ok: true, message: '已连接到 DeepSeek Harness。聊天、任务状态和配图现在走宿主。' };
    } catch (error) {
      if (generation !== connectionGeneration || disposed) {
        return { ok: false, message: '接入状态已变化，请重新连接。' };
      }
      lastError = `未能连接 DeepSeek Harness：${error instanceof Error ? error.message : String(error)}`;
      opts.log(lastError);
      return { ok: false, message: lastError };
    } finally {
      connecting = false;
    }
  };

  const connect = async (): Promise<ConnectResult> => {
    if (connecting) return { ok: false, message: '正在连接，请稍候。' };
    const host = currentHost();
    if (host) {
      if (sameHost(activeHost, host)) return { ok: true, message: '已经连接到 DeepSeek Harness。' };
      const generation = ++connectionGeneration;
      const result = await connectHost(host);
      if (result.ok && generation === connectionGeneration) autoConnectEnabled = true;
      return result;
    }
    lastError =
      '没有找到 DeepSeek Harness 里的米豆插件。请先启动 DeepSeek Harness（desktop 配置），并确认已安装本仓库的 dsh-pet 插件。';
    opts.log('手动连接失败：未发现插件接入服务');
    return { ok: false, message: lastError };
  };

  const returnToLocal = async (generation: number): Promise<ConnectResult> => {
    try {
      if (!(await applySession(localSession(opts), undefined, generation))) {
        return { ok: false, message: '接入状态已变化，请重试。' };
      }
      lastError = '';
      opts.log('已断开 DeepSeek Harness，米豆继续在桌面上独立运行');
      return { ok: true, message: '已断开 DeepSeek Harness。米豆仍在桌面上，可继续待机、走动和打开设置。' };
    } catch (error) {
      lastError = `断开时出错：${error instanceof Error ? error.message : String(error)}`;
      return { ok: false, message: lastError };
    }
  };

  const disconnect = async (): Promise<ConnectResult> => {
    autoConnectEnabled = false;
    const generation = ++connectionGeneration;
    if (mode === 'standalone' && !connecting) return { ok: true, message: '当前已经独立运行。' };
    return returnToLocal(generation);
  };

  const watch = async (): Promise<void> => {
    if (disposed || !helperReady || !autoConnectEnabled || connecting || watching) return;
    watching = true;
    const generation = connectionGeneration;
    try {
      const host = currentHost();
      if (host) {
        if (sameHostConfig(activeHost, host)) return;
        if ((await connectHost(host)).ok) return;
        // 同一宿主的配置刷新失败时保留当前窗口，下次巡检重试。
        if (sameHost(activeHost, host)) return;
      }
      if (activeHost && generation === connectionGeneration && !disposed) {
        opts.log('DeepSeek Harness 已退出或会话已失效，米豆改回独立运行');
        await returnToLocal(generation);
      }
    } finally {
      watching = false;
    }
  };

  const start = (): void => {
    writeStandaloneFile();
    heartbeatTimer = setInterval(() => {
      if (!disposed) writeStandaloneFile();
    }, 30_000);
    heartbeatTimer.unref?.();
    watchTimer = setInterval(() => void watch(), 2000);
    watchTimer.unref?.();
  };

  /**
   * 启动 Helper 之前调用：若插件已在，返回应注入环境变量的会话，不再调用 retarget。
   * Helper 起来之后请再调用 {@link markHelperReady}。
   */
  const bootSession = async (): Promise<RetargetSession> => {
    const host = currentHost();
    if (host && (await connectHost(host)).ok) return lastSession;
    lastSession = localSession(opts);
    return lastSession;
  };

  const markHelperReady = (): void => {
    helperReady = true;
  };

  const dispose = (): void => {
    disposed = true;
    if (watchTimer) clearInterval(watchTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    watchTimer = undefined;
    heartbeatTimer = undefined;
    removeStandaloneFile();
  };

  return {
    start,
    dispose,
    status,
    connect,
    disconnect,
    bootSession,
    markHelperReady,
    writeStandaloneFile,
    currentSession: () => lastSession,
  };
}

/** 连接器产出。 */
export type DshConnect = ReturnType<typeof createDshConnect>;
