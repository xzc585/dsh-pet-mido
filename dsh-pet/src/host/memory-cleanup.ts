/**
 * 宿主侧的清理内存：按配置定时，或在进程堆 / 语音缓存超阈值时提前跑。
 *
 * 清的是本进程拿得回来的东西：语音合成缓存文件、天气查询的内存缓存。
 * 不碰对话记忆文件，也不改 `memory` 配置。浏览器里的动画 blob 由客户端自己放，
 * 这里只在跑完后写一条 `sections.memoryCleanup`，让页面把后台视频松开。
 * @module dsh-pet/src/host/memory-cleanup
 */
import { dirname, join } from 'node:path';
import { readAllConfig, type ConfigPaths } from './config.ts';
import { resetUapiCache } from './uapi.ts';
import { pruneScannedCache, scanVoiceCache } from './voice/cache.ts';
import type { PollStateStore } from './state.ts';
import type { FileLogger } from './log-file.ts';
import {
  canCheckMemoryCleanup,
  decideMemoryCleanup,
  readMemoryCleanup,
  type CleanupReason,
  type MemoryCleanupConfig,
} from '../shared/memory-cleanup.ts';

/** 巡检间隔（ms）：比配置里的定时更密，阈值才能在两次定时之间被看见。 */
const CHECK_MS = 15_000;

/** 一次清理的结果，同时写进轮询状态。 */
export interface MemoryCleanupReport {
  /** 递增序号。页面用它判断「又清了一次」，不看原因。 */
  generation: number;
  reason: CleanupReason;
  /** 清理时刻（ms）。 */
  at: number;
  /** 清掉的语音缓存字节。动画字节在浏览器里，不进这个数。 */
  freedBytes: number;
  /** 清理前的进程堆（字节）。 */
  processBytes: number;
  /** 清理前的语音缓存（字节）。 */
  cacheBytes: number;
}

/** 跑清理需要的宿主对象。 */
export interface MemoryCleanupDeps {
  configPaths: ConfigPaths;
  state: PollStateStore;
  log: Pick<FileLogger, 'info' | 'warn'>;
}

/** 本进程的计时。启动时刻在第一次巡检时记下，避免模块加载就算「到点」。 */
let startedAt = 0;
let clockReady = false;
let lastRunAt: number | null = null;
let generation = 0;

/** 记下计时起点。now 可以是 0，所以不能靠 startedAt === 0 判断。 */
function ensureClock(now: number): void {
  if (clockReady) return;
  startedAt = now;
  clockReady = true;
}

/** 测试用：把计时和序号归零。 */
export function resetMemoryCleanupClock(): void {
  startedAt = 0;
  clockReady = false;
  lastRunAt = null;
  generation = 0;
}

/**
 * 语音缓存目录一共多少字节。目录不存在当 0。
 *
 * @param dir - `voice-cache` 目录。
 */
export async function voiceCacheBytes(dir: string): Promise<number> {
  return (await scanVoiceCache(dir)).bytes;
}

function voiceCacheDir(paths: ConfigPaths): string {
  return join(dirname(paths.userFile), 'voice-cache');
}

/**
 * 量一次宿主侧占用。
 *
 * 进程用 heapUsed（本进程堆），缓存用语音文件体积。两者任一到阈值都算到。
 */
export async function measureHostMemory(paths: ConfigPaths): Promise<{ processBytes: number; cacheBytes: number }> {
  const cacheBytes = await voiceCacheBytes(voiceCacheDir(paths));
  return { processBytes: process.memoryUsage().heapUsed, cacheBytes };
}

/**
 * 真的清一次：删掉全部语音缓存（下次合成会重建），并丢掉天气内存缓存。
 *
 * @param deps - 配置、状态与日志。
 * @param reason - 调用方已经决定的原因。
 * @param now - 当前时刻。
 */
export async function runHostMemoryCleanup(
  deps: MemoryCleanupDeps,
  reason: CleanupReason,
  now = Date.now(),
): Promise<MemoryCleanupReport> {
  const cache = await scanVoiceCache(voiceCacheDir(deps.configPaths));
  return clearMeasuredCache(deps, reason, now, cache, process.memoryUsage().heapUsed);
}

async function clearMeasuredCache(
  deps: MemoryCleanupDeps,
  reason: CleanupReason,
  now: number,
  cache: Awaited<ReturnType<typeof scanVoiceCache>>,
  processBytes: number,
): Promise<MemoryCleanupReport> {
  const removed = await pruneScannedCache(cache, { maxBytes: 0, maxFiles: 0 });
  resetUapiCache();
  generation += 1;
  lastRunAt = Math.max(lastRunAt ?? now, now);
  const report: MemoryCleanupReport = {
    generation,
    reason,
    at: now,
    freedBytes: removed.bytes,
    processBytes,
    cacheBytes: cache.bytes,
  };
  deps.state.writeSection('memoryCleanup', report);
  deps.log.info(
    '[dsh-pet] 清理内存 reason=' +
      reason +
      ' freedBytes=' +
      String(removed.bytes) +
      ' voiceFiles=' +
      String(removed.files) +
      ' heap=' +
      String(processBytes),
  );
  return report;
}

/** 读 main 条目的清理配置；读不到按默认。 */
export function hostCleanupConfig(paths: ConfigPaths): MemoryCleanupConfig {
  try {
    const main = readAllConfig(paths).main;
    return readMemoryCleanup(main?.memoryCleanup);
  } catch {
    return readMemoryCleanup(undefined);
  }
}

/**
 * 巡检一拍。没到点、被防抖挡住、或开关关着时返回 null。
 *
 * @param deps - 配置、状态与日志。
 * @param now - 当前时刻，测试注入。
 */
export async function tickHostMemoryCleanup(
  deps: MemoryCleanupDeps,
  now = Date.now(),
): Promise<MemoryCleanupReport | null> {
  ensureClock(now);
  const config = hostCleanupConfig(deps.configPaths);
  if (!canCheckMemoryCleanup({ ...config, now, lastRunAt })) return null;
  const cache = await scanVoiceCache(voiceCacheDir(deps.configPaths));
  const processBytes = process.memoryUsage().heapUsed;
  const decision = decideMemoryCleanup({
    ...config,
    now,
    lastRunAt,
    startedAt,
    processBytes,
    cacheBytes: cache.bytes,
  });
  if (!decision.run || decision.reason === null) return null;
  return clearMeasuredCache(deps, decision.reason, now, cache, processBytes);
}

/**
 * 人手触发：不看开关和防抖。
 *
 * @param deps - 配置、状态与日志。
 */
export function triggerHostMemoryCleanup(deps: MemoryCleanupDeps): Promise<MemoryCleanupReport> {
  const now = Date.now();
  ensureClock(now);
  return runHostMemoryCleanup(deps, 'manual', now);
}

/**
 * 当前状态，给设置页看「上次清了没有」。
 */
export async function memoryCleanupStatus(paths: ConfigPaths): Promise<{
  config: MemoryCleanupConfig;
  lastRunAt: number | null;
  generation: number;
  processBytes: number;
  cacheBytes: number;
}> {
  const measured = await measureHostMemory(paths);
  return { config: hostCleanupConfig(paths), lastRunAt, generation, ...measured };
}

/**
 * 挂上巡检定时器，随插件卸载停下。
 *
 * @param deps - 宿主上下文加上清理依赖。ctx 只用来登记 effect。
 */
export function registerMemoryCleanupLoop(
  deps: MemoryCleanupDeps & { ctx: { effect: (setup: () => void, label: string) => void } },
): void {
  const { ctx, ...rest } = deps;
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      if (disposed) return;
      timer = setTimeout(() => {
        void tickHostMemoryCleanup(rest)
          .catch((error: unknown) => {
            rest.log.warn('[dsh-pet] 清理内存巡检失败：' + (error instanceof Error ? error.message : String(error)));
          })
          .finally(arm);
      }, CHECK_MS);
    };
    arm();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: memory cleanup');
}
