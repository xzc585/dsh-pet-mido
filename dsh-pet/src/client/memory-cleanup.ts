/**
 * 浏览器侧的清理内存巡检。
 *
 * 量的是动画 blob 缓存，以及 Chrome 才有的 `performance.memory` 堆。
 * 到点或超阈值时松开后台视频、丢掉没人播的 blob。
 * 宿主清完也会写 `sections.memoryCleanup`，这里接到信号再清一次本地缓存，并把防抖对齐到同一次。
 * 不读对话记忆。
 * @module dsh-pet/src/client/memory-cleanup
 */
import { animationCacheBytes, releaseDetachedAnimationMedia } from './pet/animation/media-cache.ts';
import {
  decideMemoryCleanup,
  readMemoryCleanup,
  type CleanupReason,
  type MemoryCleanupConfig,
} from '../shared/memory-cleanup.ts';

/** 与宿主同一拍巡检，阈值不必干等到整段间隔。 */
const CHECK_MS = 15_000;

/** 页面上一次已经处理过的宿主序号。0 = 还没见过。 */
let seenGeneration = 0;
let startedAt = 0;
/** 是否已经记下计时起点。不能用 startedAt===0 判断：测试和时钟都可能正好是 0。 */
let clockReady = false;
let lastRunAt: number | null = null;
let config: MemoryCleanupConfig = readMemoryCleanup(undefined);
let timer: ReturnType<typeof setInterval> | number | null = null;

/** 测试用。 */
export function resetClientMemoryCleanup(): void {
  seenGeneration = 0;
  startedAt = 0;
  clockReady = false;
  lastRunAt = null;
  config = readMemoryCleanup(undefined);
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 换成配置里的那一份。成品聚合每次拉到 main 条目时调用。
 *
 * @param raw - `memoryCleanup` 原始值。
 */
export function setClientMemoryCleanupConfig(raw: unknown): void {
  config = readMemoryCleanup(raw);
}

/** 当前页面能看到的堆。没有 performance.memory 时当 0，只靠缓存字节和定时。 */
export function clientProcessBytes(): number {
  const memory = (performance as { memory?: { usedJSHeapSize?: number } }).memory;
  const used = memory?.usedJSHeapSize;
  return typeof used === 'number' && Number.isFinite(used) ? used : 0;
}

/**
 * 按已经决定的原因清一次本地动画缓存。
 *
 * @param reason - 定时、阈值或宿主信号。
 * @param now - 记进防抖的时刻。
 */
export function runClientMemoryCleanup(reason: CleanupReason, now = Date.now()): { videos: number; bytes: number; reason: CleanupReason } {
  const released = releaseDetachedAnimationMedia();
  lastRunAt = now;
  return { ...released, reason };
}

/**
 * 巡检一拍。没到点返回 null。
 *
 * @param now - 当前时刻。
 */
export function tickClientMemoryCleanup(now = Date.now()): { videos: number; bytes: number; reason: CleanupReason } | null {
  if (!clockReady) {
    startedAt = now;
    clockReady = true;
  }
  const decision = decideMemoryCleanup({
    ...config,
    now,
    lastRunAt,
    startedAt,
    processBytes: clientProcessBytes(),
    cacheBytes: animationCacheBytes(),
  });
  if (!decision.run || decision.reason === null) return null;
  return runClientMemoryCleanup(decision.reason, now);
}

/**
 * 宿主叶子里的清理信号。序号没变就忽略，避免轮询把同一次又放一遍。
 *
 * @param data - `sections.memoryCleanup` 的 data。
 * @returns 这次是否真的清了本地缓存。
 */
export function applyHostMemoryCleanup(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const generation = (data as { generation?: unknown }).generation;
  const at = (data as { at?: unknown }).at;
  if (typeof generation !== 'number' || !Number.isFinite(generation)) return false;
  if (generation === seenGeneration) return false;
  seenGeneration = generation;
  const now = typeof at === 'number' && Number.isFinite(at) ? at : Date.now();
  runClientMemoryCleanup('manual', now);
  return true;
}

/**
 * 启动巡检。重复调用不会再挂一个定时器。
 * 浏览器才有 window；测试里不调用它，直接 tick。
 */
export function startClientMemoryCleanup(): void {
  if (timer !== null) return;
  if (typeof window === 'undefined') return;
  if (!clockReady) {
    startedAt = Date.now();
    clockReady = true;
  }
  timer = window.setInterval(() => {
    tickClientMemoryCleanup();
  }, CHECK_MS);
}
