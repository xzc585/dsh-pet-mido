/**
 * 系统内存清理帮手：定位、拉起、停掉，以及把本地 HTTP API 转给设置页。
 *
 * 清的是整机物理内存（EmptyWorkingSet / 待机列表），和插件自己的 `memoryCleanup`
 *（动画 / 语音 / 天气缓存）不是一回事。帮手是无窗口的 mido-ram-cleaner.exe，
 * 配置仍落在 %APPDATA%/mido-ram-cleaner/config.json。
 * 只在 Windows 上启动；其它平台直接回报不可用。
 * @module dsh-pet/src/host/system-memory
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { PACKAGE_ROOT } from './paths.ts';

/** 帮手在本机监听的地址。只绑 127.0.0.1。 */
export const SYSTEM_MEMORY_LISTEN = '127.0.0.1:17341';

/** 帮手 HTTP 根地址。 */
export const SYSTEM_MEMORY_BASE = 'http://127.0.0.1:17341';

/** 发布版帮手文件名。 */
export const SYSTEM_MEMORY_EXE = 'mido-ram-cleaner.exe';

const SYSTEM_MEMORY_CONFIG_VERSION = 2;

/** 为什么帮手当前不可用。 */
export type SystemMemoryUnavailable = 'not-windows' | 'helper-missing' | 'helper-failed';

/** 帮手里保存的自动清理设置。 */
export interface SystemMemoryConfig {
  autoClean: boolean;
  intervalSec: number;
  thresholdPercent: number;
  debounceSec: number;
  showUsage?: boolean;
  notifyOnClean?: boolean;
}

/** 一次内存快照。 */
export interface SystemMemorySnap {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
}

/** 一次清理报告。 */
export interface SystemMemoryCleanReport extends Partial<SystemMemorySnap> {
  at?: string;
  trigger?: 'auto' | 'manual' | 'elevated';
  isAdmin?: boolean;
  workingSetsOK?: boolean;
  standbyCleared?: boolean;
  standbySkipped?: string;
  processesTrimmed?: number;
  processesFailed?: number;
  before?: SystemMemorySnap;
  after?: SystemMemorySnap;
  error?: string;
}

/** 设置页使用的状态。 */
export interface SystemMemoryStatus extends Partial<SystemMemorySnap> {
  ok: boolean;
  available: boolean;
  reason?: SystemMemoryUnavailable;
  message?: string;
  isAdmin?: boolean;
  config?: SystemMemoryConfig;
  lastClean?: SystemMemoryCleanReport;
}

/** 可替换的运行期依赖，方便单测，不在生产路径里改。 */
export interface SystemMemoryRuntime {
  platform: string;
  packageRoot: string;
  exists: (path: string) => boolean;
  fetch: typeof fetch;
  spawn: typeof spawn;
  sleep: (ms: number) => Promise<void>;
}

const defaultRuntime = (): SystemMemoryRuntime => ({
  platform: process.platform,
  packageRoot: PACKAGE_ROOT,
  exists: existsSync,
  fetch: globalThis.fetch.bind(globalThis),
  spawn,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

let runtime: SystemMemoryRuntime = defaultRuntime();
let child: ChildProcess | undefined;
let starting: Promise<SystemMemoryStatus> | undefined;

/**
 * 测试用：替换平台、找文件、拉起与 fetch。
 * @param patch - 要覆盖的字段；不传则恢复默认。
 */
export function setSystemMemoryRuntime(patch?: Partial<SystemMemoryRuntime>): void {
  runtime = patch ? { ...runtime, ...patch } : defaultRuntime();
}

/** 测试用：丢掉已记录的子进程句柄，不向帮手发退出请求。 */
export function resetSystemMemoryHelperForTest(): void {
  child = undefined;
  starting = undefined;
}

/**
 * 在包内或仓库里找出发布版帮手 exe。
 *
 * 构建后 PACKAGE_ROOT 是包根；从 `src/host` 加载时是 `src/`，所以同时看上一级。
 * 完整仓库里还能在兄弟目录 `tools/mido-ram-cleaner/dist/` 找到同一份发布版。
 *
 * @param packageRoot - 默认用 {@link PACKAGE_ROOT}。
 * @returns 找到的绝对路径；找不到则 undefined。
 */
export function bundledSystemMemoryExe(packageRoot = runtime.packageRoot): string | undefined {
  const exists = runtime.exists;
  const candidates = [
    ...(basename(packageRoot) === 'app.asar' ? [join(packageRoot, '..', 'tools', SYSTEM_MEMORY_EXE)] : []),
    join(packageRoot, 'assets', 'tools', SYSTEM_MEMORY_EXE),
    join(packageRoot, '..', 'assets', 'tools', SYSTEM_MEMORY_EXE),
    join(packageRoot, '..', 'tools', 'mido-ram-cleaner', 'dist', SYSTEM_MEMORY_EXE),
    join(packageRoot, '..', '..', 'tools', 'mido-ram-cleaner', 'dist', SYSTEM_MEMORY_EXE),
  ];
  return candidates.find((path) => exists(path));
}

function unavailable(reason: SystemMemoryUnavailable, message: string): SystemMemoryStatus {
  return { ok: false, available: false, reason, message };
}

async function readHelperVersion(): Promise<number | undefined> {
  try {
    const response = await runtime.fetch(SYSTEM_MEMORY_BASE + '/api/health', {
      method: 'GET',
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { ok?: unknown; app?: unknown; configVersion?: unknown };
    if (body.ok !== true || body.app !== 'mido-ram-cleaner') return undefined;
    return asNumber(body.configVersion) ?? 1;
  } catch {
    return undefined;
  }
}

function hasMemoryPreferences(version: number | undefined): boolean {
  return version !== undefined && version >= SYSTEM_MEMORY_CONFIG_VERSION;
}

async function waitForHelper(predicate: (version: number | undefined) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate(await readHelperVersion())) return true;
    await runtime.sleep(200);
  } while (Date.now() < deadline);
  return false;
}

async function spawnAndWait(exe: string): Promise<boolean> {
  try {
    const version = await readHelperVersion();
    if (hasMemoryPreferences(version)) return true;
    if (version !== undefined) {
      const stopped = await runtime.fetch(SYSTEM_MEMORY_BASE + '/api/quit', {
        method: 'POST',
        signal: AbortSignal.timeout(1500),
      });
      if (
        !stopped.ok ||
        !(await waitForHelper((current) => current === undefined || hasMemoryPreferences(current), 2500))
      ) {
        return false;
      }
      if (hasMemoryPreferences(await readHelperVersion())) return true;
    }
    const spawned = runtime.spawn(exe, [], {
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
    child = spawned;
    spawned.on('error', () => {
      if (child === spawned) child = undefined;
    });
    spawned.on('exit', () => {
      if (child === spawned) child = undefined;
    });
    return await waitForHelper(hasMemoryPreferences, 8000);
  } catch {
    return false;
  }
}

/**
 * 确保帮手已在本机监听 API。已在跑就复用；否则按固定路径拉起。
 * @returns 可用与否，以及找不到/拉不起时的原因。
 */
export async function ensureSystemMemoryHelper(): Promise<SystemMemoryStatus> {
  if (runtime.platform !== 'win32') {
    return unavailable('not-windows', '系统内存清理只在 Windows 上可用。');
  }
  if (hasMemoryPreferences(await readHelperVersion())) {
    return { ok: true, available: true };
  }
  const exe = bundledSystemMemoryExe();
  if (!exe) {
    return unavailable('helper-missing', '没有找到系统内存清理帮手，请确认插件目录里有这份工具。');
  }
  if (!starting) {
    starting = (async () => {
      const ok = await spawnAndWait(exe);
      return ok ? { ok: true, available: true } : unavailable('helper-failed', '暂时无法连接到系统内存清理帮手。');
    })().finally(() => {
      starting = undefined;
    });
  }
  return starting;
}

/**
 * 请帮手退出。插件卸载时调用，避免留下无窗口进程。
 * 已在跑的旧版（托盘版）也会被请退出，好换成无窗口帮手。
 */
export async function stopSystemMemoryHelper(): Promise<void> {
  try {
    await runtime.fetch(SYSTEM_MEMORY_BASE + '/api/quit', {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* 帮手本来就没在跑，或已经退出。 */
  }
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* 进程可能已经自己退出。 */
    }
  }
  child = undefined;
  starting = undefined;
}

async function readHelperJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asSnap(value: unknown): SystemMemorySnap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const totalBytes = asNumber(raw.totalBytes);
  const availableBytes = asNumber(raw.availableBytes);
  const usedBytes = asNumber(raw.usedBytes);
  const usedPercent = asNumber(raw.usedPercent);
  if (
    totalBytes === undefined ||
    availableBytes === undefined ||
    usedBytes === undefined ||
    usedPercent === undefined
  ) {
    return undefined;
  }
  return { totalBytes, availableBytes, usedBytes, usedPercent };
}

function asConfig(value: unknown): SystemMemoryConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const intervalSec = asNumber(raw.intervalSec);
  const thresholdPercent = asNumber(raw.thresholdPercent);
  const debounceSec = asNumber(raw.debounceSec);
  if (
    typeof raw.autoClean !== 'boolean' ||
    intervalSec === undefined ||
    thresholdPercent === undefined ||
    debounceSec === undefined
  ) {
    return undefined;
  }
  return {
    autoClean: raw.autoClean,
    intervalSec,
    thresholdPercent,
    debounceSec,
    showUsage: raw.showUsage !== false,
    notifyOnClean: raw.notifyOnClean === true,
  };
}

function asCleanReport(value: unknown): SystemMemoryCleanReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const trigger = raw.trigger;
  return {
    at: typeof raw.at === 'string' ? raw.at : undefined,
    trigger: trigger === 'auto' || trigger === 'manual' || trigger === 'elevated' ? trigger : undefined,
    isAdmin: typeof raw.isAdmin === 'boolean' ? raw.isAdmin : undefined,
    workingSetsOK: typeof raw.workingSetsOK === 'boolean' ? raw.workingSetsOK : undefined,
    standbyCleared: typeof raw.standbyCleared === 'boolean' ? raw.standbyCleared : undefined,
    standbySkipped: typeof raw.standbySkipped === 'string' ? raw.standbySkipped : undefined,
    processesTrimmed: asNumber(raw.processesTrimmed),
    processesFailed: asNumber(raw.processesFailed),
    before: asSnap(raw.before),
    after: asSnap(raw.after),
    error: typeof raw.error === 'string' ? raw.error : undefined,
  };
}

function statusFromHelper(body: unknown, fallbackMessage: string): SystemMemoryStatus {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return unavailable('helper-failed', fallbackMessage);
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.error === 'string' && raw.error.trim() !== '') {
    return { ok: false, available: true, message: raw.error };
  }
  const snap = asSnap(raw);
  const config = asConfig(raw.config);
  return {
    ok: true,
    available: true,
    message: typeof raw.message === 'string' ? raw.message : undefined,
    totalBytes: snap?.totalBytes,
    availableBytes: snap?.availableBytes,
    usedBytes: snap?.usedBytes,
    usedPercent: snap?.usedPercent,
    isAdmin: typeof raw.isAdmin === 'boolean' ? raw.isAdmin : undefined,
    config,
    lastClean: asCleanReport(raw.lastClean),
  };
}

/**
 * 先确保帮手在跑，再转发到它的 API。
 *
 * @param path - 以 `/api/` 开头的帮手路径。
 * @param init - fetch 初始化参数。
 * @returns 规范化后的状态；帮手不可用时 available 为 false。
 */
export async function callSystemMemoryApi(path: string, init?: RequestInit): Promise<SystemMemoryStatus> {
  const ensured = await ensureSystemMemoryHelper();
  if (!ensured.available) return ensured;
  try {
    const response = await runtime.fetch(SYSTEM_MEMORY_BASE + path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
    const body = await readHelperJson(response);
    if (!response.ok) {
      const message =
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : '暂时无法连接到系统内存清理帮手。';
      return { ok: false, available: true, message };
    }
    return statusFromHelper(body, '暂时无法连接到系统内存清理帮手。');
  } catch {
    return unavailable('helper-failed', '暂时无法连接到系统内存清理帮手。');
  }
}

/** 读取当前占用与配置。 */
export function readSystemMemoryStatus(): Promise<SystemMemoryStatus> {
  return callSystemMemoryApi('/api/status', { method: 'GET' });
}

/** 立刻清理一次（不需要管理员）。 */
export function triggerSystemMemoryClean(): Promise<SystemMemoryStatus> {
  return callSystemMemoryApi('/api/clean', { method: 'POST' });
}

/** 请求管理员权限后做一次完整清理。 */
export function triggerSystemMemoryCleanElevated(): Promise<SystemMemoryStatus> {
  return callSystemMemoryApi('/api/clean-elevated', { method: 'POST' });
}

/** 把自动清理设置写进帮手（并落盘到 %APPDATA%/mido-ram-cleaner/config.json）。 */
export function writeSystemMemoryConfig(config: SystemMemoryConfig): Promise<SystemMemoryStatus> {
  return callSystemMemoryApi('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}
