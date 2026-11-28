/**
 * 进程与素材缓存的定时清理：和对话「长期记忆」不是一回事。
 *
 * 长期记忆是 `memory` / `chatMemoryRounds`，管的是聊天历史该带几轮。
 * 这里只管动画 blob、语音缓存和进程堆占用到点或超阈值时该不该释放。
 * 纯函数，不读配置文件、不碰 DOM。
 * @module dsh-pet/src/shared/memory-cleanup
 */

/** 清理内存的配置（config.jsonc 顶层 `memoryCleanup`，只读 main 条目）。 */
export interface MemoryCleanupConfig {
  /** 总开关。关掉后定时与阈值都不跑；设置页的「立即清理」仍然可用。 */
  enabled: boolean;
  /** 定时清理间隔（秒）。从上次清理（或本次进程启动）起算。 */
  intervalSec: number;
  /** 触发阈值（MB）。进程堆或本插件缓存任一达到就提前清理。 */
  thresholdMb: number;
  /** 两次自动清理的最短间隔（秒）。必须 ≤ intervalSec，避免阈值一直超标时连着跑。 */
  debounceSec: number;
}

/** 内置默认：每 30 分钟一次，堆或缓存达到 512MB 提前清，两次至少隔 2 分钟。 */
export const DEFAULT_MEMORY_CLEANUP: MemoryCleanupConfig = {
  enabled: true,
  intervalSec: 1800,
  thresholdMb: 512,
  debounceSec: 120,
};

/** 为什么这次要清。manual 只来自人手触发，不看开关与防抖。 */
export type CleanupReason = 'schedule' | 'threshold' | 'manual';

/** 一次「要不要清」的输入。字节都是调用方量好的，本函数不读进程。 */
export interface CleanupDecisionInput {
  enabled: boolean;
  /** 当前时刻（ms）。 */
  now: number;
  /** 上次清理时刻；null = 还没清过。 */
  lastRunAt: number | null;
  /** 计时起点：还没清过时，定时从这里起算，避免一启动就清。 */
  startedAt: number;
  intervalSec: number;
  debounceSec: number;
  /** 进程堆占用（字节）。浏览器没有 performance.memory 时传 0。 */
  processBytes: number;
  /** 本插件自己的缓存占用（字节）：动画 blob、语音文件等。 */
  cacheBytes: number;
  thresholdMb: number;
  /** 人手触发：忽略开关、间隔与防抖。 */
  force?: boolean;
}

/** 判定结论。run 为 false 时 reason 为 null。 */
export interface CleanupDecision {
  run: boolean;
  reason: CleanupReason | null;
}

const MB = 1024 * 1024;

/**
 * `memoryCleanup` 整段是否合法。
 *
 * 整段替换：形状不对就整段回默认，不逐项补。
 * debounce 长于 interval 会让定时永远被防抖挡住，直接判非法。
 */
export function memoryCleanupValid(value: unknown): value is MemoryCleanupConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== 'boolean') return false;
  const intervalSec = Number(raw.intervalSec);
  const thresholdMb = Number(raw.thresholdMb);
  const debounceSec = Number(raw.debounceSec);
  if (!Number.isFinite(intervalSec) || intervalSec < 1 || intervalSec > 31_536_000) return false;
  if (!Number.isFinite(thresholdMb) || thresholdMb <= 0 || thresholdMb > 1_048_576) return false;
  if (!Number.isFinite(debounceSec) || debounceSec < 1 || debounceSec > intervalSec) return false;
  return true;
}

/**
 * 读一段配置。非法或缺失时回内置默认，不抛。
 *
 * @param value - 配置里的原始值。
 * @returns 填满的配置。
 */
export function readMemoryCleanup(value: unknown): MemoryCleanupConfig {
  if (!memoryCleanupValid(value)) return { ...DEFAULT_MEMORY_CLEANUP };
  return {
    enabled: value.enabled,
    intervalSec: Number(value.intervalSec),
    thresholdMb: Number(value.thresholdMb),
    debounceSec: Number(value.debounceSec),
  };
}

/** 只有开启并过了防抖窗口，自动巡检才测量进程和缓存。 */
export function canCheckMemoryCleanup({
  enabled,
  debounceSec,
  lastRunAt,
  now,
}: Pick<CleanupDecisionInput, 'enabled' | 'debounceSec' | 'lastRunAt' | 'now'>): boolean {
  return enabled && (lastRunAt === null || now - lastRunAt >= debounceSec * 1000);
}

/**
 * 决定这一拍要不要清理。
 *
 * 顺序：手动优先；关着就不自动跑；防抖窗口内不跑；
 * 堆或缓存任一到阈值就清；否则等到间隔点。谁先到用谁。
 *
 * @param input - 时钟、用量与配置。
 * @returns 是否执行，以及原因。
 */
export function decideMemoryCleanup(input: CleanupDecisionInput): CleanupDecision {
  if (input.force === true) return { run: true, reason: 'manual' };
  if (!canCheckMemoryCleanup(input)) return { run: false, reason: null };
  const thresholdBytes = input.thresholdMb * MB;
  if (input.processBytes >= thresholdBytes || input.cacheBytes >= thresholdBytes) {
    return { run: true, reason: 'threshold' };
  }
  const anchor = input.lastRunAt ?? input.startedAt;
  if (input.now - anchor >= input.intervalSec * 1000) {
    return { run: true, reason: 'schedule' };
  }
  return { run: false, reason: null };
}
