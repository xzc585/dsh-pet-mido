/**
 * 浏览器侧清理：定时/阈值走同一套判定；宿主信号只对新序号生效。
 *
 * 跑法：node --experimental-strip-types --test src/client/memory-cleanup.test.ts
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { rememberBlob, resetAnimationMediaCache } from './pet/animation/media-cache.ts';
import {
  applyHostMemoryCleanup,
  resetClientMemoryCleanup,
  setClientMemoryCleanupConfig,
  tickClientMemoryCleanup,
} from './memory-cleanup.ts';

afterEach(() => {
  resetClientMemoryCleanup();
  resetAnimationMediaCache();
});

describe('tickClientMemoryCleanup', () => {
  test('缓存超过阈值就丢掉没人引用的 blob', () => {
    setClientMemoryCleanupConfig({ enabled: true, intervalSec: 10_000, thresholdMb: 0.000001, debounceSec: 1 });
    rememberBlob('http://pet/stale.webm', new Blob(['0123456789']));
    const report = tickClientMemoryCleanup(5_000);
    assert.equal(report?.reason, 'threshold');
    assert.ok((report?.bytes ?? 0) > 0);
    const again = tickClientMemoryCleanup(5_100);
    assert.equal(again, null, '防抖窗口内不能连着清');
  });

  test('关掉之后即使缓存很大也不清', () => {
    setClientMemoryCleanupConfig({ enabled: false, intervalSec: 30, thresholdMb: 0.000001, debounceSec: 1 });
    rememberBlob('http://pet/stale.webm', new Blob(['0123456789']));
    assert.equal(tickClientMemoryCleanup(99_000), null);
  });

  test('到间隔按定时清理', () => {
    setClientMemoryCleanupConfig({ enabled: true, intervalSec: 30, thresholdMb: 10_000, debounceSec: 1 });
    const first = tickClientMemoryCleanup(0);
    assert.equal(first, null, '起点那一拍不算到时');
    const report = tickClientMemoryCleanup(30_000);
    assert.equal(report?.reason, 'schedule');
  });
});

describe('applyHostMemoryCleanup', () => {
  test('新序号清一次，同一序号再来不再清', () => {
    rememberBlob('http://pet/stale.webm', new Blob(['abc']));
    assert.equal(applyHostMemoryCleanup({ generation: 2, at: 100 }), true);
    assert.equal(applyHostMemoryCleanup({ generation: 2, at: 100 }), false);
    assert.equal(applyHostMemoryCleanup({}), false);
  });
});
