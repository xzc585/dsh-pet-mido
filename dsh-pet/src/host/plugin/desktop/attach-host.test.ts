/**
 * 插件侧接入服务的进程形态判定。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAttachHost, isStandaloneAppProcess, type AttachHostInput } from './attach-host.ts';
import {
  ATTACH_TOKEN_HEADER,
  buildDiscovery,
  discoveryPath,
  HOST_DISCOVERY_FILE,
  HOST_KIND,
  readLiveDiscovery,
  STANDALONE_DISCOVERY_FILE,
  STANDALONE_KIND,
} from '../../../shared/mido-attach.ts';

describe('isStandaloneAppProcess', () => {
  test('独立应用或同进程 Helper 时不开放插件接入服务', () => {
    assert.equal(isStandaloneAppProcess({}), false);
    assert.equal(isStandaloneAppProcess({ DSH_PET_APP_MODE: '1' }), true);
    assert.equal(isStandaloneAppProcess({ DSH_PET_IN_PROCESS: '1' }), true);
    assert.equal(isStandaloneAppProcess({ DSH_PET_APP_MODE: '0' }), false);
  });
});

test('独立入口拿到接入会话前等待插件桌宠让位', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mido-handoff-test-'));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let hostStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    hostStarted = resolve;
  });
  let stopStarted!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopStarted = resolve;
  });
  let allowStop!: () => void;
  const finished = new Promise<void>((resolve) => {
    allowStop = resolve;
  });
  let resumed = 0;
  const attach = createAttachHost({
    ctx: { emit() {} } as AttachHostInput['ctx'],
    getHandlePetRoute: () => async () => ({ kind: 'none' }),
    desktopPetList: () => [],
    log: { info: hostStarted, warn() {} },
    stopHelper: async () => {
      stopStarted();
      await finished;
    },
    resumeHelper: () => {
      resumed += 1;
    },
  });
  t.after(() => {
    allowStop();
    attach.stop();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  attach.start();
  await ready;
  const host = readLiveDiscovery(home, HOST_DISCOVERY_FILE, HOST_KIND);
  assert.ok(host);
  assert.equal(host.configRevision, 0);
  attach.notifyConfigChanged();
  assert.equal(readLiveDiscovery(home, HOST_DISCOVERY_FILE, HOST_KIND)?.configRevision, 1);
  const standalone = buildDiscovery({
    kind: STANDALONE_KIND,
    pid: process.pid,
    token: 'a'.repeat(43),
    origin: 'http://127.0.0.1:12001',
  });
  const standalonePath = discoveryPath(home, STANDALONE_DISCOVERY_FILE);
  writeFileSync(standalonePath, JSON.stringify(standalone));
  let responseReceived = false;
  const response = fetch(host.origin + '/mido-attach/session', {
    headers: { [ATTACH_TOKEN_HEADER]: host.token, connection: 'close' },
    signal: AbortSignal.timeout(2000),
  }).then(async (result) => {
    await result.text();
    responseReceived = true;
    return result;
  });
  await Promise.race([stopping, response]);
  assert.equal(responseReceived, false);
  allowStop();
  assert.equal((await response).status, 200);
  unlinkSync(standalonePath);
  t.mock.timers.tick(1500);
  assert.equal(resumed, 1);
});
