import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../runtime/electron-helper/sprite/playback.js', import.meta.url), 'utf8');

class Video extends EventTarget {
  readyState = 0;
  ended = false;
  currentTime = 0;
  src = '';
  buffered = { length: 1, start: () => 0 };
  loadCount = 0;
  classList = { add() {}, remove() {} };
  style = { transform: '' };
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  play = () => Promise.resolve();
  get currentSrc() {
    return this.src;
  }
  load() {
    this.loadCount += 1;
  }
  pause() {}
}

function harness(rollKind = () => 'idle') {
  const timers = new Map<number, () => void>();
  let timerSequence = 0;
  class Sprite {
    videoA = new Video();
    videoB = new Video();
    front = 0;
    gen = 0;
    anim = 'idle';
    assetBase = 'http://example.test/animations/';
    frozen = false;
    facing = 'left';
    pet = { id: 'mido' };
    dragState = { active: false };
    animations = { idle: ['idle'], turn: [] as string[], drag: [], clicks: [] };
    reports: string[] = [];
    stopMove() {}
    reportPlayback(id: string, status: string) {
      this.reports.push(id + ':' + status);
    }
    declare switchTo: (next: string, once: boolean, playbackId: string, url: string) => void;
    declare playIdle: () => void;
  }
  runInNewContext(source, {
    PetSprite: Sprite,
    console: { warn() {} },
    S: {
      isEventAnim: () => false,
      rollKind,
      pick: (animations: string[]) => animations[0],
    },
    window: {
      setTimeout(fn: () => void) {
        timers.set(++timerSequence, fn);
        return timerSequence;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
  });
  return { sprite: new Sprite(), timers };
}

function finishIdle(sprite: ReturnType<typeof harness>['sprite']) {
  const video = sprite.videoB;
  video.ended = true;
  video.currentTime = 2;
  video.onended?.();
}

test('随机再次选中已缓冲的同一待机片时原地重播，下一轮仍可选中其它动作', () => {
  const picks = ['idle', 'idle', 'turn'];
  const { sprite, timers } = harness(() => picks.shift() ?? 'idle');
  sprite.animations.turn = ['turn'];
  sprite.playIdle();
  sprite.videoB.readyState = 2;
  sprite.videoB.dispatchEvent(new Event('loadeddata'));

  sprite.facing = 'right';
  finishIdle(sprite);
  assert.equal(sprite.videoB.currentTime, 0);
  assert.equal(sprite.videoB.style.transform, 'scaleX(-1)');
  assert.equal(sprite.videoB.loadCount, 1);
  assert.equal(sprite.videoA.loadCount, 0);
  assert.equal(timers.size, 0);

  finishIdle(sprite);
  assert.equal(sprite.videoA.loadCount, 1);
  assert.equal(sprite.videoA.src, sprite.assetBase + 'turn.webm');
});

test('同一待机片未缓冲片头时保留原有换源流程', () => {
  const { sprite } = harness();
  sprite.playIdle();
  sprite.videoB.readyState = 2;
  sprite.videoB.buffered = { length: 1, start: () => 1 };
  sprite.videoB.dispatchEvent(new Event('loadeddata'));

  finishIdle(sprite);
  assert.equal(sprite.videoB.currentTime, 2);
  assert.equal(sprite.videoA.loadCount, 1);
});

test('同源待机片显式点播依然有完整播放回执', async () => {
  const { sprite } = harness();
  sprite.playIdle();
  sprite.videoB.readyState = 2;
  sprite.videoB.dispatchEvent(new Event('loadeddata'));

  sprite.switchTo('idle', true, 'action', sprite.assetBase + 'idle.webm');
  assert.equal(sprite.videoA.loadCount, 1);
  sprite.videoA.readyState = 2;
  sprite.videoA.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  sprite.videoA.onended?.();
  assert.deepEqual(sprite.reports, ['action:playing', 'action:ended']);
});

test('原地重播失败时使用原有换源流程', async () => {
  const { sprite } = harness();
  sprite.playIdle();
  sprite.videoB.readyState = 2;
  sprite.videoB.dispatchEvent(new Event('loadeddata'));
  sprite.videoB.play = () => Promise.reject(new Error('cannot restart playback'));

  finishIdle(sprite);
  assert.equal(sprite.videoA.loadCount, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sprite.videoA.loadCount, 1);
  assert.equal(sprite.videoA.src, sprite.assetBase + 'idle.webm');
});

test('原地重播的失败回调不会顶掉后续点播或解除锁定', async () => {
  for (const replace of [true, false]) {
    let rejectReplay: ((reason: Error) => void) | undefined;
    const { sprite } = harness();
    sprite.playIdle();
    sprite.videoB.readyState = 2;
    sprite.videoB.dispatchEvent(new Event('loadeddata'));
    sprite.videoB.play = () =>
      new Promise<void>((_resolve, reject) => {
        rejectReplay = reject;
      });
    finishIdle(sprite);
    assert.ok(rejectReplay, '应先原地重播再测试失败回调');

    if (replace) sprite.switchTo('turn', true, 'new-action', sprite.assetBase + 'turn.webm');
    else sprite.frozen = true;
    rejectReplay(new Error('cannot restart playback'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sprite.videoA.loadCount, replace ? 1 : 0);
    assert.equal(sprite.videoA.src, replace ? sprite.assetBase + 'turn.webm' : '');
  }
});

test('桌面动画超时后迟到的帧不切换前台', async () => {
  const { sprite, timers } = harness();
  sprite.switchTo('slow', true, 'one', 'http://example.test/slow.webm');
  for (const expire of timers.values()) expire();
  sprite.videoB.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  assert.equal(sprite.front, 0);
  assert.deepEqual(sprite.reports, ['one:failed']);
});

test('快速换动画会取消旧请求和计时器，并保留新请求的错误处理', () => {
  const { sprite, timers } = harness();
  sprite.switchTo('first', true, 'one', 'http://example.test/first.webm');
  sprite.switchTo('second', true, 'two', 'http://example.test/second.webm');
  assert.equal(timers.size, 1);
  sprite.videoB.onerror?.();
  assert.equal(timers.size, 0);
  sprite.videoB.dispatchEvent(new Event('loadeddata'));
  assert.equal(sprite.front, 0);
  assert.deepEqual(sprite.reports, ['one:cancelled', 'two:failed']);
});

test('被顶掉动画的 play 兑现后不再上报播放', async () => {
  const { sprite } = harness();
  let resolveFirstPlay!: () => void;
  const firstPlay = new Promise<void>((resolve) => {
    resolveFirstPlay = resolve;
  });
  sprite.videoB.play = () => firstPlay;
  sprite.switchTo('first', true, 'one', 'http://example.test/first.webm');
  sprite.videoB.dispatchEvent(new Event('loadeddata'));
  sprite.switchTo('second', true, 'two', 'http://example.test/second.webm');
  sprite.videoA.dispatchEvent(new Event('loadeddata'));
  resolveFirstPlay();
  await Promise.resolve();
  assert.deepEqual(sprite.reports, ['one:cancelled', 'two:playing']);
});

test('旧的前台动画播完时保留正在加载的新请求', async () => {
  const { sprite } = harness();
  sprite.switchTo('first', true, 'one', 'http://example.test/first.webm');
  sprite.videoB.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  sprite.switchTo('second', true, 'two', 'http://example.test/second.webm');
  sprite.videoB.onended?.();
  assert.deepEqual(sprite.reports, ['one:playing', 'one:ended']);

  sprite.videoA.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  assert.equal(sprite.anim, 'second');
  assert.deepEqual(sprite.reports, ['one:playing', 'one:ended', 'two:playing']);
});

test('前台已播完且新请求加载失败时恢复待机动画', async () => {
  const { sprite } = harness();
  sprite.switchTo('first', true, 'one', 'http://example.test/first.webm');
  sprite.videoB.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  sprite.switchTo('second', true, 'two', 'http://example.test/second.webm');
  sprite.videoB.onended?.();
  sprite.videoA.onerror?.();
  sprite.videoA.dispatchEvent(new Event('loadeddata'));
  assert.equal(sprite.anim, 'idle');
  assert.deepEqual(sprite.reports, ['one:playing', 'one:ended', 'two:failed']);
});

test('前台已播完且新动画无法开始播放时恢复待机动画', async () => {
  const { sprite } = harness();
  sprite.switchTo('first', true, 'one', 'http://example.test/first.webm');
  sprite.videoB.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  sprite.switchTo('second', true, 'two', 'http://example.test/second.webm');
  sprite.videoB.onended?.();

  sprite.videoA.play = () => Promise.reject(new Error('cannot start playback'));
  sprite.videoA.dispatchEvent(new Event('loadeddata'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  sprite.videoB.dispatchEvent(new Event('loadeddata'));
  assert.equal(sprite.anim, 'idle');
  assert.deepEqual(sprite.reports, ['one:playing', 'one:ended', 'two:failed']);
});
