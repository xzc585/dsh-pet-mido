/**
 * 插件侧接入服务的进程形态判定。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isStandaloneAppProcess } from './attach-host.ts';

describe('isStandaloneAppProcess', () => {
  test('独立应用或同进程 Helper 时不开放插件接入服务', () => {
    assert.equal(isStandaloneAppProcess({}), false);
    assert.equal(isStandaloneAppProcess({ DSH_PET_APP_MODE: '1' }), true);
    assert.equal(isStandaloneAppProcess({ DSH_PET_IN_PROCESS: '1' }), true);
    assert.equal(isStandaloneAppProcess({ DSH_PET_APP_MODE: '0' }), false);
  });
});
