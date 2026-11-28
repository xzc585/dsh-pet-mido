/**
 * 清理内存判定的契约：定时与阈值谁先到用谁，防抖挡住连跑，手动不受开关限制。
 *
 * 跑法：node --experimental-strip-types --test src/shared/memory-cleanup.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MEMORY_CLEANUP,
  decideMemoryCleanup,
  memoryCleanupValid,
  readMemoryCleanup,
  type CleanupDecisionInput,
} from './memory-cleanup.ts';

const MB = 1024 * 1024;

/** 一份安静的输入：刚启动、用量很低、用内置默认。 */
function input(over: Partial<CleanupDecisionInput> = {}): CleanupDecisionInput {
  return {
    enabled: true,
    now: 10_000,
    lastRunAt: null,
    startedAt: 10_000,
    intervalSec: 1800,
    debounceSec: 120,
    processBytes: 0,
    cacheBytes: 0,
    thresholdMb: 512,
    ...over,
  };
}

describe('memoryCleanupValid / readMemoryCleanup', () => {
  test('内置默认合法，缺失时读回同一份', () => {
    assert.equal(memoryCleanupValid(DEFAULT_MEMORY_CLEANUP), true);
    assert.deepEqual(readMemoryCleanup(undefined), DEFAULT_MEMORY_CLEANUP);
    assert.deepEqual(readMemoryCleanup(null), DEFAULT_MEMORY_CLEANUP);
  });

  test('合法段原样读出', () => {
    const raw = { enabled: false, intervalSec: 60, thresholdMb: 128, debounceSec: 30 };
    assert.equal(memoryCleanupValid(raw), true);
    assert.deepEqual(readMemoryCleanup(raw), raw);
  });

  test('防抖长于间隔、非正数、缺开关都整段非法', () => {
    assert.equal(memoryCleanupValid({ enabled: true, intervalSec: 60, thresholdMb: 10, debounceSec: 61 }), false);
    assert.equal(memoryCleanupValid({ enabled: true, intervalSec: 0, thresholdMb: 10, debounceSec: 1 }), false);
    assert.equal(memoryCleanupValid({ enabled: true, intervalSec: 60, thresholdMb: 0, debounceSec: 1 }), false);
    assert.equal(memoryCleanupValid({ intervalSec: 60, thresholdMb: 10, debounceSec: 30 }), false);
    assert.deepEqual(readMemoryCleanup({ enabled: 'yes' }), DEFAULT_MEMORY_CLEANUP);
  });
});

describe('decideMemoryCleanup', () => {
  test('刚启动且低于阈值：不清理', () => {
    assert.deepEqual(decideMemoryCleanup(input()), { run: false, reason: null });
  });

  test('到了间隔就按定时清理', () => {
    const decision = decideMemoryCleanup(input({ now: 10_000 + 1800 * 1000 }));
    assert.deepEqual(decision, { run: true, reason: 'schedule' });
  });

  test('阈值先到就提前清理，不必等间隔', () => {
    const decision = decideMemoryCleanup(input({ now: 20_000, processBytes: 512 * MB }));
    assert.deepEqual(decision, { run: true, reason: 'threshold' });
    const byCache = decideMemoryCleanup(input({ now: 20_000, cacheBytes: 512 * MB, processBytes: 1 }));
    assert.deepEqual(byCache, { run: true, reason: 'threshold' });
  });

  test('清理后的防抖窗口内，阈值仍超标也不连跑', () => {
    const decision = decideMemoryCleanup(
      input({ now: 50_000, lastRunAt: 40_000, processBytes: 900 * MB, debounceSec: 120 }),
    );
    assert.deepEqual(decision, { run: false, reason: null });
  });

  test('防抖过后阈值仍超标，再次按阈值清理', () => {
    const decision = decideMemoryCleanup(
      input({ now: 40_000 + 120 * 1000, lastRunAt: 40_000, processBytes: 900 * MB }),
    );
    assert.deepEqual(decision, { run: true, reason: 'threshold' });
  });

  test('关掉之后定时和阈值都不跑', () => {
    assert.deepEqual(decideMemoryCleanup(input({ enabled: false, now: 9_999_999, processBytes: 9999 * MB })), {
      run: false,
      reason: null,
    });
  });

  test('手动触发无视开关、间隔和防抖', () => {
    const decision = decideMemoryCleanup(
      input({ enabled: false, force: true, lastRunAt: 9_000, now: 9_500, debounceSec: 120 }),
    );
    assert.deepEqual(decision, { run: true, reason: 'manual' });
  });
});
