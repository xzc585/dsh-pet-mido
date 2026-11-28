/**
 * `/system-memory` 的路由契约：按路径分发，方法错回 405，其它路径不认领。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/system-memory.test.ts
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetSystemMemoryHelperForTest, setSystemMemoryRuntime } from '../system-memory.ts';
import { handleSystemMemoryRoutes } from './system-memory.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

afterEach(() => {
  resetSystemMemoryHelperForTest();
  setSystemMemoryRuntime();
});

const deps = {} as PetRouteDeps;

function input(method: string, rest = 'system-memory', body?: string): RouteInput {
  return { url: new URL('http://127.0.0.1/' + rest), rest, method, body };
}

describe('handleSystemMemoryRoutes', () => {
  test('非 Windows 的 GET 回 available: false，不认领其它路径', async () => {
    setSystemMemoryRuntime({ platform: 'linux' });
    const got = await handleSystemMemoryRoutes(deps, input('GET'));
    assert.equal(got?.kind, 'json');
    const body = (got as { obj: { available: boolean; reason: string } }).obj;
    assert.equal(body.available, false);
    assert.equal(body.reason, 'not-windows');
    assert.equal(await handleSystemMemoryRoutes(deps, input('GET', 'memory-cleanup')), undefined);
  });

  test('方法不对 → 405；坏 JSON → 400', async () => {
    const denied = await handleSystemMemoryRoutes(deps, input('PUT'));
    assert.equal((denied as { status: number }).status, 405);
    const bad = await handleSystemMemoryRoutes(deps, input('POST', 'system-memory/config', '{'));
    assert.equal((bad as { status: number }).status, 400);
  });

  test('POST /system-memory 转给帮手的立即清理', async () => {
    setSystemMemoryRuntime({
      platform: 'win32',
      fetch: async (inputUrl, init) => {
        const url = String(inputUrl);
        if (url.endsWith('/api/health')) {
          return Response.json({ ok: true, app: 'mido-ram-cleaner', configVersion: 2 });
        }
        if (url.endsWith('/api/clean') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              totalBytes: 8,
              availableBytes: 5,
              usedBytes: 3,
              usedPercent: 37.5,
              isAdmin: false,
              config: { autoClean: false, intervalSec: 1800, thresholdPercent: 85, debounceSec: 120 },
            }),
            { status: 200 },
          );
        }
        throw new Error('unexpected ' + url);
      },
    });
    const posted = await handleSystemMemoryRoutes(deps, input('POST'));
    const body = (posted as { obj: { ok: boolean; usedPercent: number } }).obj;
    assert.equal(body.ok, true);
    assert.equal(body.usedPercent, 37.5);
  });

  test('保存占用显示和通知选项，也接受省略这两项的旧版请求', async () => {
    const base = { autoClean: true, intervalSec: 1800, thresholdPercent: 85, debounceSec: 120 };
    const picked = { ...base, showUsage: false, notifyOnClean: true };
    const sent: unknown[] = [];
    setSystemMemoryRuntime({
      platform: 'win32',
      fetch: async (inputUrl, init) => {
        if (String(inputUrl).endsWith('/api/health'))
          return Response.json({ ok: true, app: 'mido-ram-cleaner', configVersion: 2 });
        assert.ok(String(inputUrl).endsWith('/api/config'));
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ config: picked });
      },
    });
    for (const config of [picked, base]) {
      const result = await handleSystemMemoryRoutes(
        deps,
        input('POST', 'system-memory/config', JSON.stringify(config)),
      );
      assert.deepEqual((result as { obj: { config: unknown } }).obj.config, picked);
    }
    assert.deepEqual(sent, [picked, base]);
    const invalid = await handleSystemMemoryRoutes(
      deps,
      input('POST', 'system-memory/config', JSON.stringify({ ...base, notifyOnClean: 'true' })),
    );
    assert.equal((invalid as { status: number }).status, 400);
    assert.equal(sent.length, 2);
  });
});
