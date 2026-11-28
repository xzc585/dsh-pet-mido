import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../runtime/electron-helper/sprite/playback.js', import.meta.url), 'utf8');

class Video extends EventTarget {
  readyState = 0;
  classList = { add() {}, remove() {} };
  style = {};
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  play = () => Promise.resolve();
  load() {}
  pause() {}
}

function harness() {
  const timers = new Map<number, () => void>();
  let timerSequence = 0;
  class Sprite {
    videoA = new Video();
    videoB = new Video();
    front = 0;
    gen = 0;
    anim = 'idle';
    pet = { id: 'mido' };
    dragState = { active: false };
    animations = { idle: ['idle'], turn: [], drag: [], clicks: [] };
    reports: string[] = [];
    stopMove() {}
    reportPlayback(id: string, status: string) {
      this.reports.push(id + ':' + status);
    }
    declare switchTo: (next: string, once: boolean, playbackId: string, url: string) => void;
  }
  runInNewContext(source, {
    PetSprite: Sprite,
    console: { warn() {} },
    S: {
      isEventAnim: () => false,
      rollKind: () => 'idle',
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
