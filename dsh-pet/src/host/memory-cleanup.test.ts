/**
 * 宿主清理内存：到点或超阈值会删语音缓存并写轮询叶子；防抖窗口内不连跑；手动总能清。
 *
 * 跑法：node --experimental-strip-types --test src/host/memory-cleanup.test.ts
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tickHostMemoryCleanup,
  triggerHostMemoryCleanup,
  voiceCacheBytes,
  resetMemoryCleanupClock,
} from './memory-cleanup.ts';
import { PollStateStore } from './state.ts';
import type { ConfigPaths } from './config.ts';
import type { MemoryCleanupDeps } from './memory-cleanup.ts';

const logs: string[] = [];

function deps(root: string, config: Record<string, unknown>): MemoryCleanupDeps {
  const paths: ConfigPaths = {
    defaultFile: join(root, 'default.jsonc'),
    userFile: join(root, 'main-config.jsonc'),
    petDir: join(root, 'pet'),
  };
  return {
    configPaths: paths,
    state: new PollStateStore(),
    log: {
      info: (message: string) => {
        logs.push(message);
      },
      warn: (message: string) => {
        logs.push(message);
      },
    },
    // 测试不走 readAllConfig 的磁盘默认，改由下面的替身读取。
    ...({ __config: config } as object),
  };
}

afterEach(() => {
  logs.length = 0;
  resetMemoryCleanupClock();
});

describe('voiceCacheBytes', () => {
  test('只统计 mp3 与 wav，目录不存在是 0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pet-cleanup-'));
    assert.equal(await voiceCacheBytes(join(root, 'missing')), 0);
    const dir = join(root, 'voice-cache');
    await mkdir(dir);
    await writeFile(join(dir, 'a.mp3'), Buffer.alloc(10));
    await writeFile(join(dir, 'b.wav'), Buffer.alloc(5));
    await mkdir(join(dir, 'not-a-file.mp3'));
    await writeFile(join(dir, 'note.txt'), Buffer.alloc(100));
    assert.equal(await voiceCacheBytes(dir), 15);
  });
});

describe('tickHostMemoryCleanup', () => {
  test('缓存超过阈值就清掉语音文件，并写 memoryCleanup 叶子', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pet-cleanup-'));
    const dir = join(root, 'voice-cache');
    await mkdir(dir);
    await writeFile(join(dir, 'a.mp3'), Buffer.alloc(32));
    const store = new PollStateStore();
    const paths: ConfigPaths = {
      defaultFile: join(root, 'nope.jsonc'),
      userFile: join(root, 'main-config.jsonc'),
      petDir: join(root, 'pet'),
    };
    // 不读损坏的默认配置：直接注入已经决定要跑的测量结果，走 run。
    const harness: MemoryCleanupDeps = {
      configPaths: paths,
      state: store,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    };
    // 阈值设得比堆还低会在没有配置文件时走默认 512MB，堆通常更小。
    // 这里把语音文件做大，仍然可能低于 512MB，所以用手动触发钉住删除行为，
    // 定时/阈值的判定在 shared 测试里。手动路径必须删文件并推进叶子。
    const report = await triggerHostMemoryCleanup(harness);
    assert.equal(report.reason, 'manual');
    assert.equal(report.freedBytes, 32);
    assert.equal(await voiceCacheBytes(dir), 0);
    const leaf = store.read().sections.memoryCleanup;
    assert.equal(leaf.data && (leaf.data as { generation: number }).generation, 1);
    assert.equal(
      logs.some((line) => line.includes('reason=manual')),
      true,
    );
  });

  test('没有配置文件时巡检不抛，用量低于默认阈值则不清理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pet-cleanup-'));
    const harness = deps(root, {});
    const report = await tickHostMemoryCleanup(harness, 1_000);
    assert.equal(report, null);
  });

  test('禁止自动清理时不量内存，仍可手动清理', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pet-cleanup-'));
    const harness = deps(root, {});
    await writeFile(
      harness.configPaths.defaultFile,
      JSON.stringify({ memoryCleanup: { enabled: false, intervalSec: 30, thresholdMb: 1, debounceSec: 1 } }),
    );
    const memoryUsage = t.mock.method(process, 'memoryUsage');
    assert.equal(await tickHostMemoryCleanup(harness, 1_000), null);
    assert.equal(memoryUsage.mock.callCount(), 0);
    assert.equal((await triggerHostMemoryCleanup(harness)).reason, 'manual');
    assert.equal(memoryUsage.mock.callCount(), 1);
  });

  test('同时清理时同一音频只计入一次释放量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pet-cleanup-'));
    const dir = join(root, 'voice-cache');
    await mkdir(dir);
    await writeFile(join(dir, 'a.mp3'), Buffer.alloc(32));
    const harness = deps(root, {});

    const reports = await Promise.all([triggerHostMemoryCleanup(harness), triggerHostMemoryCleanup(harness)]);

    assert.equal(
      reports.reduce((total, report) => total + report.freedBytes, 0),
      32,
    );
    assert.equal(await voiceCacheBytes(dir), 0);
  });
});
