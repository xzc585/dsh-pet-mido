import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = () => readFileSync(new URL('../../runtime/electron-helper/system-memory.js', import.meta.url), 'utf8');

function pollingFixture() {
  const readings: Array<number | null> = [];
  const requests: Array<{ url: string; init: RequestInit; complete: (result: Response | Error) => void }> = [];
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  let close: (() => void) | undefined;
  const events = readFileSync(new URL('../../runtime/electron-helper/events.js', import.meta.url), 'utf8');
  const { start, startLoops } = runInNewContext(
    source() + '\n' + events + '\n({ start: startSystemMemoryPolling, startLoops });',
    {
      PetSprite: function PetSprite() {},
      loopsStarted: false,
      STATE_URL: '/state',
      S: { fetchState: async () => null, subscribeVoiceState() {}, subscribeVoiceUtterance() {} },
      BASE: 'dsh-pet-bridge://dsh-pet/dsh-pet-7340',
      sprites: [{ setMemoryUsage: (value: number | null) => readings.push(value) }],
      window: {
        addEventListener: (name: string, listener: () => void) => {
          assert.equal(name, 'pagehide');
          close = listener;
        },
      },
      AbortSignal,
      AbortController,
      fetch: (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          requests.push({
            url,
            init,
            complete: (result) => (result instanceof Error ? reject(result) : resolve(result)),
          });
        }),
      setTimeout: (callback: () => void, delay: number) => {
        const id = ++nextTimer;
        scheduled.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id: number) => scheduled.delete(id),
    },
  ) as { start(): void; startLoops(): void };
  return {
    start,
    startLoops,
    readings,
    requests,
    scheduled,
    close: () => close?.(),
    async respond(result: Response | Error) {
      requests[requests.length - 1]?.complete(result);
      await setImmediate();
    },
    tick() {
      const [id, next] = scheduled.entries().next().value!;
      scheduled.delete(id);
      next.callback();
    },
  };
}

const enabled = { ok: true, available: true, config: { showUsage: true }, totalBytes: 100, usedPercent: 92.9 };

test('桌面内存只在当前状态可读且开启时显示，失败与旧宿主清掉上次读数', async () => {
  const fixture = pollingFixture();
  fixture.start();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0]?.url, 'dsh-pet-bridge://dsh-pet/dsh-pet-7340/system-memory');
  assert.equal(fixture.requests[0]?.init.cache, 'no-store');
  assert.equal(fixture.scheduled.size, 0, '请求尚未结束时不排下一次');
  await fixture.respond(Response.json(enabled));
  assert.deepEqual(fixture.readings, [92.9]);
  assert.equal(fixture.scheduled.values().next().value?.delay, 4000);

  const failures = [
    Response.json({ ...enabled, config: { showUsage: false } }),
    Response.json({ ...enabled, config: {} }),
    Response.json({ ...enabled, available: false }),
    Response.json({ ...enabled, ok: false }),
    Response.json({ ...enabled, totalBytes: 0, usedPercent: 0 }),
    Response.json({ ...enabled, totalBytes: -1 }),
    Response.json({ ...enabled, totalBytes: '100' }),
    Response.json({ ...enabled, usedPercent: '92.9' }),
    new Response('old host', { status: 404 }),
    new Error('renderer disconnected'),
  ];
  for (const failure of failures) {
    fixture.tick();
    assert.equal(fixture.scheduled.size, 0);
    await fixture.respond(failure);
    assert.equal(fixture.readings[fixture.readings.length - 1], null);
  }
  fixture.tick();
  await fixture.respond(Response.json({ ...enabled, usedPercent: 0 }));
  assert.equal(fixture.readings[fixture.readings.length - 1], 0, '读取成功的 0% 是有效值');
  fixture.close();
  assert.equal(fixture.scheduled.size, 0);
});

test('窗口重复启动通用循环时只启动一个内存读取', () => {
  const fixture = pollingFixture();
  fixture.startLoops();
  fixture.startLoops();
  assert.equal(fixture.requests.length, 1);
  fixture.close();
});

test('窗口退出会取消进行中的读取，迟到的响应不重开轮询', async () => {
  const fixture = pollingFixture();
  fixture.start();
  fixture.close();
  assert.ok(fixture.requests[0]?.init.signal?.aborted);
  await fixture.respond(Response.json(enabled));
  assert.deepEqual(fixture.readings, []);
  assert.equal(fixture.scheduled.size, 0);
});

test('内存读数优先在头顶，靠屏幕上沿时翻到脚下，隐藏后释放窗口余量', () => {
  const classes = new Set<string>();
  let dimensionReads = 0;
  const badge = {
    className: '',
    textContent: '',
    get offsetWidth() {
      dimensionReads++;
      return 89;
    },
    get offsetHeight() {
      dimensionReads++;
      return 22;
    },
    style: { left: '', top: '' },
    classList: {
      toggle: (name: string, value: boolean) => (value ? classes.add(name) : classes.delete(name)),
    },
    remove: () => {
      removed = true;
    },
  };
  let removed = false;
  let mounted = false;
  let recalculations = 0;
  const area = { x: 48, y: 14, w: 124, h: 180 };
  function PetSprite() {}
  runInNewContext(source(), { PetSprite, document: { createElement: () => badge } });
  const sprite = Object.assign(Object.create(PetSprite.prototype), {
    el: { appendChild: () => (mounted = true) },
    halfW: 40,
    bottomPad: 4,
    winH: 49,
    winOffset: { x: 30, y: 80 },
    visibleClampRect: () => area,
    refreshPopupBounds: () => {
      recalculations++;
      if (sprite.memoryBadge) sprite.layoutMemoryUsage();
    },
  }) as unknown as {
    memoryBadge?: typeof badge | null;
    setMemoryUsage(value: number | null): void;
    layoutMemoryUsage(): void;
    winOffset: { x: number; y: number };
  };

  sprite.setMemoryUsage(92.9);
  assert.equal(badge.textContent, '内存 92.9%');
  assert.equal(badge.className, 'pet-memory-usage');
  assert.ok(mounted);
  assert.ok(classes.has('is-placed'));
  const top = () => sprite.winOffset.y + Number.parseFloat(badge.style.top);
  const left = () => sprite.winOffset.x + Number.parseFloat(badge.style.left);
  assert.ok(top() + badge.offsetHeight < sprite.winOffset.y + 4);
  assert.ok(left() >= area.x && left() + badge.offsetWidth <= area.x + area.w);

  const initialReads = dimensionReads;
  sprite.winOffset.y = 16;
  sprite.layoutMemoryUsage();
  assert.equal(dimensionReads, initialReads, '逐帧移动用缓存尺寸，不同步触发布局');
  assert.ok(top() > sprite.winOffset.y + 49);
  sprite.setMemoryUsage(93.1);
  assert.equal(badge.textContent, '内存 93.1%');
  assert.equal(recalculations, 1, '数值变化不重置窗口');
  sprite.setMemoryUsage(null);
  assert.ok(removed);
  assert.equal(recalculations, 2);
});
