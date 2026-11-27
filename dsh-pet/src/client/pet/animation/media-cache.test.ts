/**
 * 动画素材缓存：没人播的 blob 会被清掉，前台还指着的留下；后台视频由登记的槽位松开。
 *
 * 跑法：node --experimental-strip-types --test src/client/pet/animation/media-cache.test.ts
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  animationCacheBytes,
  bindObjectUrl,
  cachedBlob,
  evictUnretainedBlobs,
  registerAnimationSlot,
  releaseDetachedAnimationMedia,
  rememberBlob,
  resetAnimationMediaCache,
  unbindObjectUrl,
} from './media-cache.ts';

afterEach(() => resetAnimationMediaCache());

describe('animation media cache', () => {
  test('记住之后能取回，重复记住不替换', () => {
    const first = new Blob(['aaaa']);
    const second = new Blob(['bbbbbbbb']);
    rememberBlob('http://pet/a.webm', first);
    rememberBlob('http://pet/a.webm', second);
    assert.equal(cachedBlob('http://pet/a.webm'), first);
    assert.equal(animationCacheBytes(), first.size);
  });

  test('还有 object URL 指着时不淘汰，松开后才丢掉', () => {
    const blob = new Blob(['0123456789']);
    rememberBlob('http://pet/a.webm', blob);
    bindObjectUrl('blob:1', 'http://pet/a.webm');
    assert.equal(evictUnretainedBlobs(), 0);
    assert.equal(cachedBlob('http://pet/a.webm'), blob);
    unbindObjectUrl('blob:1');
    assert.equal(evictUnretainedBlobs(), blob.size);
    assert.equal(cachedBlob('http://pet/a.webm'), undefined);
    assert.equal(animationCacheBytes(), 0);
  });

  test('清理会先松开后台视频，再丢掉没人用的字节', () => {
    const live = new Blob(['live']);
    const stale = new Blob(['stale-bytes']);
    rememberBlob('http://pet/live.webm', live);
    rememberBlob('http://pet/stale.webm', stale);
    bindObjectUrl('blob:live', 'http://pet/live.webm');
    bindObjectUrl('blob:stale', 'http://pet/stale.webm');
    let released = 0;
    const unregister = registerAnimationSlot({
      releaseBack: () => {
        released += 1;
        unbindObjectUrl('blob:stale');
        return 1;
      },
    });
    const report = releaseDetachedAnimationMedia();
    assert.equal(released, 1);
    assert.equal(report.videos, 1);
    assert.equal(report.bytes, stale.size);
    assert.equal(cachedBlob('http://pet/live.webm'), live);
    assert.equal(cachedBlob('http://pet/stale.webm'), undefined);
    unregister();
    assert.equal(releaseDetachedAnimationMedia().videos, 0);
  });
});
