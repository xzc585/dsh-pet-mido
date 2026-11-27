/**
 * `/memory-cleanup` 的路由契约：GET 看状态，POST 立刻清，方法错回 405，其它路径不认领。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/memory-cleanup.test.ts
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMemoryCleanupClock } from '../memory-cleanup.ts';
import { PollStateStore } from '../state.ts';
import { handleMemoryCleanupRoutes } from './memory-cleanup.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

afterEach(() => resetMemoryCleanupClock());

function input(method: string): RouteInput {
  return { url: new URL('http://127.0.0.1/memory-cleanup'), rest: 'memory-cleanup', method };
}

describe('handleMemoryCleanupRoutes', () => {
  test('POST 清掉语音缓存并回执；GET 能看到序号', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pet-cleanup-route-'));
    const dir = join(root, 'voice-cache');
    await mkdir(dir);
    await writeFile(join(dir, 'a.mp3'), Buffer.alloc(8));
    const deps = {
      configPaths: {
        defaultFile: join(root, 'default.jsonc'),
        userFile: join(root, 'main-config.jsonc'),
        petDir: join(root, 'pet'),
      },
      state: new PollStateStore(),
      log: { info: () => undefined, warn: () => undefined },
    } as unknown as PetRouteDeps;

    const posted = await handleMemoryCleanupRoutes(deps, input('POST'));
    assert.equal(posted?.kind, 'json');
    const body = (posted as { obj: { ok: boolean; reason: string; freedBytes: number; generation: number } }).obj;
    assert.equal(body.ok, true);
    assert.equal(body.reason, 'manual');
    assert.equal(body.freedBytes, 8);
    assert.equal(body.generation, 1);

    const got = await handleMemoryCleanupRoutes(deps, input('GET'));
    const status = (got as { obj: { generation: number; lastRunAt: number | null } }).obj;
    assert.equal(status.generation, 1);
    assert.equal(typeof status.lastRunAt, 'number');
  });

  test('方法不对 → 405；别的路径不认领', async () => {
    const deps = {
      configPaths: { defaultFile: '/nope', userFile: '/nope/main-config.jsonc', petDir: '/nope/pet' },
      state: new PollStateStore(),
      log: { info: () => undefined, warn: () => undefined },
    } as unknown as PetRouteDeps;
    const denied = await handleMemoryCleanupRoutes(deps, input('PUT'));
    assert.equal((denied as { status: number }).status, 405);
    assert.equal(
      await handleMemoryCleanupRoutes(deps, { ...input('GET'), rest: 'memory/providers' }),
      undefined,
    );
  });
});
