/**
 * 独立入口连接状态的纯函数测试。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { createDshConnect, localSession, lookLikeDshProcess, type RetargetSession } from './dsh-connect.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';
import { buildDiscovery, discoveryPath, HOST_DISCOVERY_FILE, HOST_KIND } from '../shared/mido-attach.ts';

describe('lookLikeDshProcess', () => {
  test('能从任务列表里认出 DeepSeek Harness', () => {
    assert.equal(lookLikeDshProcess('DeepSeek Harness.exe'), true);
    assert.equal(lookLikeDshProcess('C:\\Program Files\\deepseek\\DeepSeek Harness.exe'), true);
    assert.equal(lookLikeDshProcess('chrome.exe\nnode.exe'), false);
  });
});

describe('localSession', () => {
  test('独立运行指向本机设置页与插件路由', () => {
    const session = localSession({
      localOrigin: () => 'http://127.0.0.1:3456',
      localToken: () => 'token',
      localSiteUrl: () => 'http://127.0.0.1:3456/standalone-ai/#token=x',
    });
    assert.equal(session.connected, false);
    assert.equal(session.openTarget, 'standalone');
    assert.equal(session.configUrl, `http://127.0.0.1:3456${ROUTE_SEGMENT}/config`);
    assert.equal(session.token, 'token');
  });
});

async function listenHost() {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/mido-attach/health') {
      response.end(JSON.stringify({ kind: HOST_KIND }));
      return;
    }
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    response.end(
      JSON.stringify({
        ok: true,
        openTarget: 'desktop',
        configUrl: origin + ROUTE_SEGMENT + '/config',
        siteUrl: origin,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connectionHarness(t: import('node:test').TestContext) {
  const dshHome = mkdtempSync(join(tmpdir(), 'mido-connect-test-'));
  const first = await listenHost();
  const second = await listenHost();
  const applied: RetargetSession[] = [];
  const connector = createDshConnect({
    dshHome,
    localOrigin: () => 'http://127.0.0.1:12345',
    localToken: () => 'local-token',
    localSiteUrl: () => 'http://127.0.0.1:12345/standalone-ai/',
    version: '0.0.0',
    log: () => {},
    retarget: async (session) => {
      applied.push(session);
    },
  });
  const path = discoveryPath(dshHome, HOST_DISCOVERY_FILE);
  t.after(async () => {
    connector.dispose();
    await Promise.all([first.close(), second.close()]);
    rmSync(dshHome, { recursive: true, force: true });
  });
  connector.start();
  const publish = (origin: string, token: string, configRevision?: number) => {
    writeFileSync(
      path,
      JSON.stringify({ ...buildDiscovery({ kind: HOST_KIND, pid: process.pid, origin, token }), configRevision }),
    );
  };
  publish(first.origin, 'a'.repeat(43));
  assert.equal((await connector.bootSession()).connected, true);
  connector.markHelperReady();
  return {
    connector,
    applied,
    replaceHost: () => publish(second.origin, 'b'.repeat(43)),
    publishRevision: (revision?: number) => publish(first.origin, 'a'.repeat(43), revision),
    second,
  };
}

test('发现记录换成新的端口和令牌时重新连接当前宿主', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { connector, applied, replaceHost, second } = await connectionHarness(t);
  replaceHost();
  t.mock.timers.tick(2000);
  for (let i = 0; i < 50 && applied.length === 0; i += 1) await delay(10);
  assert.equal(connector.currentSession().configUrl, second.origin + ROUTE_SEGMENT + '/config');
  assert.deepEqual(
    applied.map(({ token }) => token),
    ['b'.repeat(43)],
  );
});

test('手动断开保持独立模式，直到主动重新连接', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { connector, applied } = await connectionHarness(t);
  await connector.disconnect();
  t.mock.timers.tick(2000);
  await delay(50);
  assert.equal(connector.status().mode, 'standalone');
  assert.deepEqual(
    applied.map(({ connected }) => connected),
    [false],
  );
  assert.equal((await connector.connect()).ok, true);
  assert.equal(connector.status().mode, 'dsh');
});

test('已连接时只在宿主配置版本变化后刷新窗口', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { applied, publishRevision } = await connectionHarness(t);
  publishRevision();
  t.mock.timers.tick(2000);
  assert.equal(applied.length, 0);
  publishRevision(1);
  t.mock.timers.tick(2000);
  for (let i = 0; i < 100 && applied.length === 0; i += 1) await delay(10);
  assert.deepEqual(
    applied.map(({ connected }) => connected),
    [true],
  );
  publishRevision(1);
  t.mock.timers.tick(2000);
  await delay(50);
  assert.equal(applied.length, 1);
});
