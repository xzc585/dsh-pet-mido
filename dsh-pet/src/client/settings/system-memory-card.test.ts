/**
 * 系统内存清理卡的纯函数契约：容量格式化。
 *
 * 跑法：node --experimental-strip-types --test src/client/settings/system-memory-card.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMemoryBytes } from './system-memory-card.ts';

describe('formatMemoryBytes', () => {
  test('按大小写成 GB 或 MB', () => {
    assert.equal(formatMemoryBytes(8 * 1024 * 1024 * 1024), '8 GB');
    assert.equal(formatMemoryBytes(8.25 * 1024 * 1024 * 1024), '8.3 GB');
    assert.equal(formatMemoryBytes(512 * 1024 * 1024), '512 MB');
    assert.equal(formatMemoryBytes(-1), '—');
  });
});
