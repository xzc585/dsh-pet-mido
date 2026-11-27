/**
 * 独立入口连接状态的纯函数测试。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { localSession, lookLikeDshProcess } from './dsh-connect.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';

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
