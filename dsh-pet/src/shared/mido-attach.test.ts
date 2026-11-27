/**
 * 本机发现协议的形状与存活校验。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ATTACH_TOKEN_SHAPE,
  HOST_DISCOVERY_FILE,
  HOST_KIND,
  STANDALONE_KIND,
  buildDiscovery,
  discoveryPath,
  isLivePid,
  isLoopbackOrigin,
  parseDiscovery,
  readLiveDiscovery,
} from './mido-attach.ts';

const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12'; // 43 chars, valid shape

describe('mido-attach', () => {
  test('token 形状是 32 字节 base64url', () => {
    assert.equal(token.length, 43);
    assert.equal(ATTACH_TOKEN_SHAPE.test(token), true);
    assert.equal(ATTACH_TOKEN_SHAPE.test('short'), false);
  });

  test('只接受本机回环 HTTP origin', () => {
    assert.equal(isLoopbackOrigin('http://127.0.0.1:3080'), true);
    assert.equal(isLoopbackOrigin('http://localhost:9'), true);
    assert.equal(isLoopbackOrigin('http://0.0.0.0:3080'), false);
    assert.equal(isLoopbackOrigin('https://127.0.0.1:3080'), false);
    assert.equal(isLoopbackOrigin('http://127.0.0.1:3080/path'), false);
    assert.equal(isLoopbackOrigin('http://example.com:3080'), false);
  });

  test('解析合法记录，拒绝 kind / token / origin 不对的内容', () => {
    const raw = JSON.stringify(
      buildDiscovery({ kind: HOST_KIND, pid: process.pid, origin: 'http://127.0.0.1:9', token }),
    );
    const ok = parseDiscovery(raw, HOST_KIND);
    assert.ok(ok);
    assert.equal(ok?.pid, process.pid);
    assert.equal(parseDiscovery(raw, STANDALONE_KIND), undefined);
    assert.equal(parseDiscovery('{', HOST_KIND), undefined);
    assert.equal(
      parseDiscovery(
        JSON.stringify({ kind: HOST_KIND, pid: 1, origin: 'http://8.8.8.8:9', token, updatedAt: 't' }),
        HOST_KIND,
      ),
      undefined,
    );
  });

  test('当前进程 pid 视为存活，明显无效的 pid 不是', () => {
    assert.equal(isLivePid(process.pid), true);
    assert.equal(isLivePid(0), false);
    assert.equal(isLivePid(-1), false);
  });

  test('读盘时进程已不在则忽略过期文件', () => {
    const home = mkdtempSync(join(tmpdir(), 'mido-attach-'));
    mkdirSync(join(home, 'dsh-pet'));
    const path = discoveryPath(home, HOST_DISCOVERY_FILE);
    writeFileSync(
      path,
      JSON.stringify({
        kind: HOST_KIND,
        pid: 1,
        origin: 'http://127.0.0.1:9',
        token,
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    // pid 1 在部分环境存在（init）。若它活着，这条只验证形状；用一个几乎不可能存活的 pid。
    writeFileSync(
      path,
      JSON.stringify({
        kind: HOST_KIND,
        pid: 2_147_483_647,
        origin: 'http://127.0.0.1:9',
        token,
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    assert.equal(readLiveDiscovery(home, HOST_DISCOVERY_FILE, HOST_KIND), undefined);

    writeFileSync(
      path,
      JSON.stringify(buildDiscovery({ kind: HOST_KIND, pid: process.pid, origin: 'http://127.0.0.1:9', token })),
    );
    const live = readLiveDiscovery(home, HOST_DISCOVERY_FILE, HOST_KIND);
    assert.ok(live);
    assert.equal(live?.pid, process.pid);
  });
});
