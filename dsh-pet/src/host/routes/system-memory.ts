/**
 * 系统内存清理的 HTTP 口：给设置页用，不直接把 127.0.0.1:17341 暴露给页面。
 *
 * GET  /system-memory              看占用与配置（会按需拉起帮手）
 * POST /system-memory              立即清理一次
 * POST /system-memory/config       保存自动清理设置
 * POST /system-memory/clean-elevated  请求管理员权限后完整清理一次
 *
 * 和 `/memory-cleanup` 不是一条线。那边清的是插件缓存。
 * @module dsh-pet/src/host/routes/system-memory
 */
import {
  readSystemMemoryStatus,
  triggerSystemMemoryClean,
  triggerSystemMemoryCleanElevated,
  writeSystemMemoryConfig,
  type SystemMemoryConfig,
} from '../system-memory.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { invalidJson, methodNotAllowed, okResult } from './result.ts';

function isSystemMemoryPath(rest: string): boolean {
  return rest === 'system-memory' || rest.startsWith('system-memory/');
}

function asConfig(value: unknown): SystemMemoryConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.autoClean !== 'boolean') return undefined;
  const intervalSec = Number(raw.intervalSec);
  const thresholdPercent = Number(raw.thresholdPercent);
  const debounceSec = Number(raw.debounceSec);
  if (!Number.isFinite(intervalSec) || !Number.isFinite(thresholdPercent) || !Number.isFinite(debounceSec)) {
    return undefined;
  }
  return {
    autoClean: raw.autoClean,
    intervalSec,
    thresholdPercent,
    debounceSec,
  };
}

/** 系统内存清理：未命中返回 undefined。 */
export async function handleSystemMemoryRoutes(
  _deps: PetRouteDeps,
  input: RouteInput,
): Promise<RouteResult | undefined> {
  if (!isSystemMemoryPath(input.rest)) return undefined;
  if (input.rest === 'system-memory' && input.method === 'GET') {
    return okResult(await readSystemMemoryStatus());
  }
  if (input.rest === 'system-memory' && input.method === 'POST') {
    return okResult(await triggerSystemMemoryClean());
  }
  if (input.rest === 'system-memory/config' && input.method === 'POST') {
    let parsed: unknown;
    try {
      parsed = input.body ? JSON.parse(input.body) : null;
    } catch {
      return invalidJson();
    }
    const config = asConfig(parsed);
    if (!config) return invalidJson('系统内存清理设置格式无效');
    return okResult(await writeSystemMemoryConfig(config));
  }
  if (input.rest === 'system-memory/clean-elevated' && input.method === 'POST') {
    return okResult(await triggerSystemMemoryCleanElevated());
  }
  return methodNotAllowed();
}
