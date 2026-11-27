/**
 * 清理内存的 HTTP 口：`GET /memory-cleanup` 看状态，`POST /memory-cleanup` 立刻清一次。
 *
 * 和 `/memory/providers` 不是一条线。那边列的是对话长期记忆的实现，这边释放的是
 * 语音缓存、天气缓存，并通知页面松开没在播的动画。
 * @module dsh-pet/src/host/routes/memory-cleanup
 */
import type { RouteResult } from '../http.ts';
import { memoryCleanupStatus, triggerHostMemoryCleanup } from '../memory-cleanup.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { methodNotAllowed, okResult } from './result.ts';

/** 清理内存：未命中返回 undefined。 */
export async function handleMemoryCleanupRoutes(
  deps: PetRouteDeps,
  input: RouteInput,
): Promise<RouteResult | undefined> {
  if (input.rest !== 'memory-cleanup') return undefined;
  if (input.method === 'GET') {
    return okResult(await memoryCleanupStatus(deps.configPaths));
  }
  if (input.method === 'POST') {
    const report = await triggerHostMemoryCleanup(deps);
    return okResult({ ok: true, ...report });
  }
  return methodNotAllowed();
}
