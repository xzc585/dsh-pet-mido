/**
 * 单段 HTTP Range 解析（runtime/electron-helper/range.js）的单测。
 *
 * 与宿主侧 src/host/http.ts 的 parseRange 同语义，边界矩阵保持一致；两侧各测一份是因为运行环境
 * 与构建边界不同（bridge 是 Electron 主进程的 CJS，宿主是 TS）。
 * 跑法：node --test scripts/tests/range.test.mjs（npm run test:ui 会带上）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { parseRange } = require('../../runtime/electron-helper/range.js');
const { createBridge } = require('../../runtime/electron-helper/main/bridge.js');

describe('parseRange —— bridge 素材应答的 Range 解析', () => {
  test('完整请求：bytes=0- → 整个文件', () => {
    assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  });

  test('显式区间：bytes=262144- → 从该偏移到末尾', () => {
    assert.deepEqual(parseRange('bytes=262144-', 1000000), { start: 262144, end: 999999 });
  });

  test('后缀形式：bytes=-200 → 末尾 200 字节', () => {
    assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 });
  });

  test('后缀超过文件长度：bytes=-5000 → 整份', () => {
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  });

  test('起点越界：bytes=1000- → unsatisfiable（回 416）', () => {
    assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  });

  test('起点大于终点：bytes=200-100 → unsatisfiable（回 416）', () => {
    assert.equal(parseRange('bytes=200-100', 1000), 'unsatisfiable');
  });

  test('多段请求：bytes=0-99,200-299 → 忽略（回整份）', () => {
    assert.equal(parseRange('bytes=0-99,200-299', 1000), null);
  });

  test('没有 Range 头：null → 忽略', () => {
    assert.equal(parseRange(null, 1000), null);
  });

  test('文件长度为 0：bytes=0- → 忽略', () => {
    assert.equal(parseRange('bytes=0-', 0), null);
  });
});

test('bridge streams the selected range, handles 416 and falls back to a full response', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dsh-pet-bridge-'));
  const file = join(dir, 'test.webm');
  await fs.writeFile(file, '0123456789');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const wholeFileRead = t.mock.method(fs, 'readFile');
  const prefix = 'TEST_BRIDGE_REQUEST ';
  const bridge = createBridge({ isBridge: true, prefix, origin: '' });
  const server = bridge.startCallback();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  let reply;
  const originalWrite = process.stdout.write;
  t.mock.method(process.stdout, 'write', function (chunk, ...args) {
    if (!String(chunk).startsWith(prefix)) return originalWrite.call(this, chunk, ...args);
    const { id, cb } = JSON.parse(String(chunk).slice(prefix.length));
    reply = fetch(cb, { method: 'POST', body: JSON.stringify({ id, status: 200, contentType: 'video/webm', file }) });
    return true;
  });
  const handle = async (range) => {
    const request = new Request('dsh-pet-bridge://dsh-pet/thumb/test.webm', { headers: { range } });
    const response = await bridge.handle(request);
    assert.equal(await (await reply).text(), 'ok');
    return response;
  };

  const partial = await handle('bytes=3-5');
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 3-5/10');
  assert.equal(partial.headers.get('content-length'), '3');
  assert.equal(await partial.text(), '345');

  const unsatisfiable = await handle('bytes=10-');
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10');
  assert.equal(await unsatisfiable.text(), '');

  const whole = await handle('bytes=0-1,3-4');
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), '0123456789');
  assert.equal(wholeFileRead.mock.callCount(), 0);
});
