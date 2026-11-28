/**
 * 系统内存帮手路径解析与 API 转接的契约。
 *
 * 跑法：node --experimental-strip-types --test src/host/system-memory.test.ts
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bundledSystemMemoryExe,
  ensureSystemMemoryHelper,
  readSystemMemoryStatus,
  resetSystemMemoryHelperForTest,
  setSystemMemoryRuntime,
  SYSTEM_MEMORY_EXE,
  writeSystemMemoryConfig,
} from './system-memory.ts';

afterEach(() => {
  resetSystemMemoryHelperForTest();
  setSystemMemoryRuntime();
});

describe('bundledSystemMemoryExe', () => {
  test('包根 assets/tools 优先；完整仓库的 tools/dist 也能找到', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pet-sysmem-'));
    const assetsDir = join(root, 'assets', 'tools');
    await mkdir(assetsDir, { recursive: true });
    const assetExe = join(assetsDir, SYSTEM_MEMORY_EXE);
    await writeFile(assetExe, 'fake');
    setSystemMemoryRuntime({ packageRoot: root, exists: (path) => path === assetExe });
    assert.equal(bundledSystemMemoryExe(root), assetExe);

    const repo = await mkdtemp(join(tmpdir(), 'dsh-pet-sysmem-repo-'));
    const distExe = join(repo, 'tools', 'mido-ram-cleaner', 'dist', SYSTEM_MEMORY_EXE);
    setSystemMemoryRuntime({
      packageRoot: join(repo, 'dsh-pet'),
      exists: (path) => path === distExe,
    });
    assert.equal(bundledSystemMemoryExe(join(repo, 'dsh-pet')), distExe);
  });

  test('从 src/ 加载时能看到上一级 assets/tools', async () => {
    const pkg = await mkdtemp(join(tmpdir(), 'dsh-pet-sysmem-src-'));
    const exe = join(pkg, 'assets', 'tools', SYSTEM_MEMORY_EXE);
    setSystemMemoryRuntime({
      packageRoot: join(pkg, 'src'),
      exists: (path) => path === exe,
    });
    assert.equal(bundledSystemMemoryExe(join(pkg, 'src')), exe);
  });

  test('Windows 解包版从 app.asar 外部找到可执行帮手', async () => {
    const resources = await mkdtemp(join(tmpdir(), 'dsh-pet-sysmem-resources-'));
    const packageRoot = join(resources, 'app.asar');
    const exe = join(resources, 'tools', SYSTEM_MEMORY_EXE);
    setSystemMemoryRuntime({ packageRoot, exists: (path) => path === exe });
    assert.equal(bundledSystemMemoryExe(), exe);
  });

  test('找不到就返回 undefined', () => {
    setSystemMemoryRuntime({ packageRoot: '/nope', exists: () => false });
    assert.equal(bundledSystemMemoryExe('/nope'), undefined);
  });
});

describe('ensureSystemMemoryHelper', () => {
  test('非 Windows 直接不可用，不尝试拉起', async () => {
    let spawned = false;
    setSystemMemoryRuntime({
      platform: 'linux',
      spawn: (() => {
        spawned = true;
        throw new Error('should not spawn');
      }) as typeof import('node:child_process').spawn,
    });
    const status = await ensureSystemMemoryHelper();
    assert.equal(status.available, false);
    assert.equal(status.reason, 'not-windows');
    assert.equal(spawned, false);
  });

  test('Windows 上找不到 exe → helper-missing', async () => {
    setSystemMemoryRuntime({
      platform: 'win32',
      packageRoot: '/nope',
      exists: () => false,
      fetch: async () => {
        throw new Error('down');
      },
    });
    const status = await ensureSystemMemoryHelper();
    assert.equal(status.available, false);
    assert.equal(status.reason, 'helper-missing');
  });

  test('帮手已在跑 → 不重复拉起', async () => {
    let spawned = false;
    setSystemMemoryRuntime({
      platform: 'win32',
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true, app: 'mido-ram-cleaner', configVersion: 2 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error('unexpected ' + url);
      },
      spawn: (() => {
        spawned = true;
        throw new Error('should not spawn');
      }) as typeof import('node:child_process').spawn,
    });
    const status = await ensureSystemMemoryHelper();
    assert.equal(status.available, true);
    assert.equal(spawned, false);
  });

  test('识别并替换仍在运行的旧版帮手，并发入口只升级一次', async () => {
    const order: string[] = [];
    let version: number | undefined = 1;
    setSystemMemoryRuntime({
      platform: 'win32',
      packageRoot: 'test',
      exists: () => true,
      sleep: async () => {},
      fetch: async (input, init) => {
        if (String(input).endsWith('/api/health')) {
          return version === undefined
            ? new Response(null, { status: 503 })
            : Response.json({ ok: true, app: 'mido-ram-cleaner', configVersion: version === 1 ? undefined : version });
        }
        assert.ok(String(input).endsWith('/api/quit'));
        assert.equal(init?.method, 'POST');
        order.push('quit');
        version = undefined;
        return Response.json({ ok: true });
      },
      spawn: (() => {
        assert.equal(version, undefined);
        order.push('spawn');
        version = 2;
        return new EventEmitter() as ChildProcess;
      }) as typeof spawn,
    });
    const results = await Promise.all([ensureSystemMemoryHelper(), ensureSystemMemoryHelper()]);
    assert.deepEqual(order, ['quit', 'spawn']);
    assert.ok(results.every((result) => result.available));
  });
});

describe('read / write system memory API', () => {
  test('把帮手的 status 规范成设置页能用的形状', async () => {
    setSystemMemoryRuntime({
      platform: 'win32',
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/health')) {
          return Response.json({ ok: true, app: 'mido-ram-cleaner', configVersion: 2 });
        }
        if (url.endsWith('/api/status') && (init?.method ?? 'GET') === 'GET') {
          return new Response(
            JSON.stringify({
              totalBytes: 16 * 1024 * 1024 * 1024,
              availableBytes: 8 * 1024 * 1024 * 1024,
              usedBytes: 8 * 1024 * 1024 * 1024,
              usedPercent: 50,
              isAdmin: false,
              config: {
                autoClean: true,
                intervalSec: 1800,
                thresholdPercent: 85,
                debounceSec: 120,
                showUsage: false,
                notifyOnClean: true,
              },
              lastClean: { at: '2026-11-28T15:00:00+08:00', trigger: 'auto' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error('unexpected ' + url);
      },
    });
    const status = await readSystemMemoryStatus();
    assert.equal(status.ok, true);
    assert.equal(status.available, true);
    assert.equal(status.usedPercent, 50);
    assert.equal(status.config?.thresholdPercent, 85);
    assert.equal(status.config?.showUsage, false);
    assert.equal(status.config?.notifyOnClean, true);
    assert.equal(status.lastClean?.trigger, 'auto');
  });

  test('帮手拒绝非法配置时把 error 带回给设置页', async () => {
    setSystemMemoryRuntime({
      platform: 'win32',
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/health')) {
          return Response.json({ ok: true, app: 'mido-ram-cleaner', configVersion: 2 });
        }
        if (url.endsWith('/api/config') && init?.method === 'POST') {
          return new Response(JSON.stringify({ error: '占用阈值须在 50% 到 99% 之间' }), { status: 400 });
        }
        throw new Error('unexpected ' + url);
      },
    });
    const status = await writeSystemMemoryConfig({
      autoClean: true,
      intervalSec: 1800,
      thresholdPercent: 10,
      debounceSec: 120,
    });
    assert.equal(status.ok, false);
    assert.equal(status.available, true);
    assert.equal(status.message, '占用阈值须在 50% 到 99% 之间');
  });
});
