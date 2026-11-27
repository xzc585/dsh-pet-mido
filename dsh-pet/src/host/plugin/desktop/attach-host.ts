/**
 * DSH 插件侧的本机接入服务：给已经在桌面上的米豆入口提供同一套宠物路由。
 *
 * 不走 DSH webServer 的浏览器访问闸门（2.0.3+ 会拦插件自拉进程的裸 HTTP），
 * 而是在插件进程里另开一个只绑 127.0.0.1 的端口，把请求交给同一份 handlePetRoute。
 * 发现文件只写 origin 与本机令牌，不含 DSH 站点入口。
 * 独立应用模式（DSH_PET_APP_MODE / IN_PROCESS）不得启动本服务，避免自己接自己。
 * @module dsh-pet/src/host/plugin/desktop/attach-host
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';

import {
  ATTACH_TOKEN_HEADER,
  HOST_DISCOVERY_FILE,
  HOST_KIND,
  STANDALONE_DISCOVERY_FILE,
  STANDALONE_KIND,
  buildDiscovery,
  discoveryPath,
  readLiveDiscovery,
  type DiscoveryRecord,
} from '../../../shared/mido-attach.ts';
import { ROUTE_SEGMENT } from '../../../shared/constants.ts';
import { dshHomeDir } from '../../helper-process.ts';
import { readBody, sendFile, sendJson, sendText, type RouteResult } from '../../http.ts';
import { failureBody } from '../../routes/result.ts';
import { resolveDesktopSiteUrl } from './site-url.ts';
import { resolveOpenTarget, type OpenTarget } from './spawn.ts';
import type { DesktopHelperDeps } from './types.ts';
import type { DesktopPets } from './pets.ts';

/** 接入服务的依赖。 */
export type AttachHostInput = Pick<DesktopHelperDeps, 'ctx' | 'getHandlePetRoute' | 'log'> &
  Pick<DesktopPets, 'desktopPetList'> & {
    /** 停掉本插件拉起的桌面 Helper，把桌面窗口让给独立入口。 */
    stopHelper(reason: string): void;
  };

/** 进程是否为独立应用，此时禁止开通接入服务。 */
export function isStandaloneAppProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_PET_APP_MODE === '1' || env.DSH_PET_IN_PROCESS === '1';
}

/** 比较请求头里的令牌；长度不同时直接拒绝，避免 timingSafeEqual 抛错。 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 取出接入令牌：优先专用头，其次复用桌面鉴权注入的 X-DSH-Pet-Token。 */
function readAttachToken(req: IncomingMessage): string {
  const dedicated = req.headers[ATTACH_TOKEN_HEADER];
  const reused = req.headers['x-dsh-pet-token'];
  const raw = dedicated ?? reused;
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : '';
}

/**
 * 创建插件侧接入服务。
 * @param deps - 路由、日志与停 Helper 的句柄。
 */
export function createAttachHost(deps: AttachHostInput) {
  const { ctx, getHandlePetRoute, log, desktopPetList, stopHelper } = deps;
  const dshHome = dshHomeDir();
  const hostFile = discoveryPath(dshHome, HOST_DISCOVERY_FILE);
  const token = randomBytes(32).toString('base64url');
  let server: ReturnType<typeof createServer> | undefined;
  let origin = '';
  let disposed = false;
  let watchTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let standaloneAnnounced = false;

  const isDesktopHost = (): boolean => Boolean(process.versions.electron);

  const writeHostFile = (): void => {
    if (!origin) return;
    mkdirSync(dirname(hostFile), { recursive: true });
    const record = buildDiscovery({
      kind: HOST_KIND,
      pid: process.pid,
      origin,
      token,
    });
    writeFileSync(hostFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  };

  const removeHostFile = (): void => {
    try {
      unlinkSync(hostFile);
    } catch {
      /* 文件本来就不在 */
    }
  };

  const currentStandalone = (): DiscoveryRecord | undefined =>
    readLiveDiscovery(dshHome, STANDALONE_DISCOVERY_FILE, STANDALONE_KIND);

  const hasLiveStandalone = (): boolean => currentStandalone() !== undefined;

  const openTarget = (): OpenTarget => {
    let siteOrigin = 'http://127.0.0.1';
    try {
      if (ctx.webServer && typeof ctx.webServer.getOrigin === 'function') siteOrigin = ctx.webServer.getOrigin();
    } catch {
      const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
      if (port > 0) siteOrigin = `http://127.0.0.1:${port}`;
    }
    return resolveOpenTarget(resolveDesktopSiteUrl(ctx, siteOrigin), isDesktopHost());
  };

  const siteUrl = (): string => {
    let siteOrigin = 'http://127.0.0.1';
    try {
      if (ctx.webServer && typeof ctx.webServer.getOrigin === 'function') siteOrigin = ctx.webServer.getOrigin();
    } catch {
      const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
      if (port > 0) siteOrigin = `http://127.0.0.1:${port}`;
    }
    return resolveDesktopSiteUrl(ctx, siteOrigin);
  };

  const writeRouteResult = (req: IncomingMessage, res: ServerResponse, result: RouteResult): void => {
    if (result.kind === 'json') sendJson(res, result.status, result.obj, result.headers);
    else if (result.kind === 'text') sendText(res, result.status, result.body);
    else if (result.kind === 'none') {
      /* 调用方已断开 */
    } else sendFile(req, res, result.file, result.contentType);
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'x-mido-attach-token, x-dsh-pet-token, content-type');
    res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, failureBody('bad-request', '请求地址无效'));
      return;
    }
    if (url.pathname === '/mido-attach/health' && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, { ok: true, kind: HOST_KIND, pid: process.pid });
      return;
    }
    if (!tokenMatches(readAttachToken(req), token)) {
      sendJson(res, 403, { error: '接入令牌无效' });
      return;
    }
    if (url.pathname === '/mido-attach/session' && (method === 'GET' || method === 'HEAD')) {
      // siteUrl 含 DSH 入口令牌：只在已鉴权的本机响应里给出，不写进发现文件、不打日志。
      sendJson(res, 200, {
        ok: true,
        kind: HOST_KIND,
        openTarget: openTarget(),
        pets: desktopPetList(),
        configUrl: `${origin}${ROUTE_SEGMENT}/config`,
        siteUrl: siteUrl(),
      });
      return;
    }
    if (!url.pathname.startsWith(`${ROUTE_SEGMENT}/`) && url.pathname !== ROUTE_SEGMENT) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.on('close', onClose);
    try {
      const readsBody = method === 'PUT' || method === 'POST' || method === 'PATCH';
      const body = readsBody ? await readBody(req) : undefined;
      const result = await getHandlePetRoute()(req.url ?? '/', method, body, abort.signal);
      res.off('close', onClose);
      writeRouteResult(req, res, result);
    } catch (error) {
      res.off('close', onClose);
      if (!res.destroyed && !res.writableEnded) {
        const code = (error as { code?: string }).code;
        if (code === 'body-too-large') sendJson(res, 413, failureBody('payload-too-large', 'request body too large'));
        else if (code !== 'client-aborted') {
          log.warn?.(`[dsh-pet] attach route failed: ${error instanceof Error ? error.message : String(error)}`);
          sendJson(res, 500, failureBody('internal-error', 'dsh-pet: internal error'));
        }
      }
    }
  };

  const watchStandalone = (): void => {
    if (disposed) return;
    const live = hasLiveStandalone();
    if (live && !standaloneAnnounced) {
      standaloneAnnounced = true;
      log.info('[dsh-pet] 检测到米豆独立入口正在运行，停止本插件的桌面 Helper，避免同时出现两只宠物');
      stopHelper('standalone-attached');
    } else if (!live) {
      standaloneAnnounced = false;
    }
  };

  const start = (): void => {
    if (disposed || server || isStandaloneAppProcess()) return;
    server = createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address() as AddressInfo | undefined;
      if (!address || typeof address.port !== 'number') {
        log.warn('[dsh-pet] 接入服务没有拿到本机端口，独立入口将无法连接 DSH');
        return;
      }
      origin = `http://127.0.0.1:${address.port}`;
      writeHostFile();
      log.info(`[dsh-pet] 已在本机开放米豆接入服务（独立入口可连接到 DSH）`);
    });
    server.on('error', (error) => {
      log.warn(`[dsh-pet] 接入服务启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
    heartbeatTimer = setInterval(() => {
      if (!disposed) writeHostFile();
    }, 30_000);
    heartbeatTimer.unref?.();
    watchTimer = setInterval(watchStandalone, 1500);
    watchTimer.unref?.();
    watchStandalone();
  };

  const stop = (): void => {
    disposed = true;
    if (watchTimer) clearInterval(watchTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    watchTimer = undefined;
    heartbeatTimer = undefined;
    removeHostFile();
    const current = server;
    server = undefined;
    origin = '';
    if (!current) return;
    current.close();
  };

  return { start, stop, hasLiveStandalone, isStandaloneAppProcess: isStandaloneAppProcess() };
}

/** 接入服务的产出。 */
export type AttachHost = ReturnType<typeof createAttachHost>;

