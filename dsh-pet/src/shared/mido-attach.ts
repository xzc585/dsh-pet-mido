/**
 * 米豆独立入口与 DSH 插件之间的本机发现协议。
 *
 * 不是 DSH 官方 attach API：官方没有把外部进程接进已运行宿主的接口。
 * 本协议只在 127.0.0.1 上交换发现记录与本机令牌，把已在桌面上的那只米豆
 * 接到插件自己的路由（聊天、任务状态、配图等），并避免再拉起第二只桌面宠物。
 * 发现文件里不写入 DSH 站点令牌。
 * @module dsh-pet/src/shared/mido-attach
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 独立入口写下的发现文件名（位于 `$DSH_HOME/dsh-pet/`）。 */
export const STANDALONE_DISCOVERY_FILE = 'mido-standalone.json';

/** DSH 内插件写下的发现文件名（位于 `$DSH_HOME/dsh-pet/`）。 */
export const HOST_DISCOVERY_FILE = 'mido-dsh-host.json';

/** 独立入口在发现记录里的 kind。 */
export const STANDALONE_KIND = 'mido-standalone';

/** DSH 插件发现记录里的 kind。 */
export const HOST_KIND = 'mido-dsh-host';

/** 插件接入服务要求的请求头（也接受 X-DSH-Pet-Token，便于复用桌面鉴权注入）。 */
export const ATTACH_TOKEN_HEADER = 'x-mido-attach-token';

/** 令牌的固定形状：32 字节 base64url。 */
export const ATTACH_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** 一次本机发现记录。`token` 只给本机回环请求用，禁止写入日志。 */
export interface DiscoveryRecord {
  /** 记录类型。 */
  readonly kind: typeof STANDALONE_KIND | typeof HOST_KIND;
  /** 写下该记录的进程 pid，用于存活判定。 */
  readonly pid: number;
  /** 本机回环 origin，形如 `http://127.0.0.1:12345`。 */
  readonly origin: string;
  /** 本机接入令牌。 */
  readonly token: string;
  /** 可选版本号，仅供排查。 */
  readonly version?: string;
  /** 宿主桌面配置变更后递增，心跳不修改。 */
  readonly configRevision?: number;
  /** 最近一次心跳时间（ISO 8601）。 */
  readonly updatedAt: string;
}

/**
 * 发现文件的绝对路径。
 * @param dshHome - `$DSH_HOME`。
 * @param file - 文件名。
 */
export function discoveryPath(dshHome: string, file: string): string {
  return join(dshHome, 'dsh-pet', file);
}

/**
 * 进程是否还在。信号 0 只探测，不投递；ESRCH / 无权限都视为不在。
 * @param pid - 候选 pid。
 */
export function isLivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 是否为本机回环 HTTP origin（只接受 127.0.0.1 或 localhost）。
 * @param origin - 候选 origin。
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      (url.pathname === '' || url.pathname === '/') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * 从文本解析发现记录；形状不对时返回 undefined，不抛。
 * @param raw - 文件内容。
 * @param expectedKind - 期望的 kind。
 */
export function parseDiscovery(raw: string, expectedKind: DiscoveryRecord['kind']): DiscoveryRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  if (rec.kind !== expectedKind) return undefined;
  if (typeof rec.pid !== 'number' || !Number.isInteger(rec.pid) || rec.pid <= 0) return undefined;
  if (typeof rec.origin !== 'string' || !isLoopbackOrigin(rec.origin)) return undefined;
  if (typeof rec.token !== 'string' || !ATTACH_TOKEN_SHAPE.test(rec.token)) return undefined;
  if (typeof rec.updatedAt !== 'string' || rec.updatedAt.length === 0) return undefined;
  const version = typeof rec.version === 'string' && rec.version ? rec.version : undefined;
  const revision = rec.configRevision;
  return {
    kind: expectedKind,
    pid: rec.pid,
    origin: rec.origin,
    token: rec.token,
    ...(version ? { version } : {}),
    ...(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
      ? { configRevision: revision }
      : {}),
    updatedAt: rec.updatedAt,
  };
}

/**
 * 读盘并校验发现记录：文件存在、形状正确、进程仍在。健康检查由调用方再补 HTTP。
 * @param dshHome - `$DSH_HOME`。
 * @param file - 文件名。
 * @param expectedKind - 期望的 kind。
 */
export function readLiveDiscovery(
  dshHome: string,
  file: string,
  expectedKind: DiscoveryRecord['kind'],
): DiscoveryRecord | undefined {
  const path = discoveryPath(dshHome, file);
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const record = parseDiscovery(raw, expectedKind);
  if (!record || !isLivePid(record.pid)) return undefined;
  return record;
}

/**
 * 组装要写入的发现记录（不含站点令牌）。
 * @param input - 记录字段。
 */
export function buildDiscovery(input: {
  kind: DiscoveryRecord['kind'];
  pid: number;
  origin: string;
  token: string;
  version?: string;
  configRevision?: number;
}): DiscoveryRecord {
  return {
    kind: input.kind,
    pid: input.pid,
    origin: input.origin,
    token: input.token,
    ...(input.version ? { version: input.version } : {}),
    ...(input.configRevision === undefined ? {} : { configRevision: input.configRevision }),
    updatedAt: new Date().toISOString(),
  };
}
