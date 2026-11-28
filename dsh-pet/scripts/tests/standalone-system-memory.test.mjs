import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

const GB = 1024 ** 3;
const config = { autoClean: true, intervalSec: 1800, thresholdPercent: 85, debounceSec: 120 };
const reading = {
  ok: true,
  available: true,
  config,
  usedPercent: 62.5,
  usedBytes: 10 * GB,
  availableBytes: 6 * GB,
  totalBytes: 16 * GB,
};
let browser, server, origin;

before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./standalone-system-memory.fixture.js', import.meta.url)),
    platform: 'browser',
  });
  const { output } = await bundle.generate({ format: 'iife' });
  await bundle.close();
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(output[0].code);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><body><script src="/fixture.js"></script></body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function openCard(t, handler) {
  const page = await browser.newPage({ timezoneId: 'Asia/Shanghai' });
  t.after(() => page.close());
  page.setDefaultTimeout(2500);
  await page.clock.install();
  await page.route('**/dsh-pet-7340/system-memory**', handler);
  await page.goto(origin);
  return page;
}

test('旧配置用开关默认值，两个开关独立立即保存', async (t) => {
  const sent = [];
  let current = config;
  const page = await openCard(t, (route) => {
    if (route.request().method() === 'POST') {
      current = route.request().postDataJSON();
      sent.push(current);
    }
    return route.fulfill({ json: { ...reading, config: current } });
  });
  const showUsage = page.getByRole('checkbox', { name: /显示当前内存占用/ });
  const notify = page.getByRole('checkbox', { name: /清理完成后通知/ });
  const usage = page.getByText(/62\.5%.*已用 10 GB.*可用 6 GB/);
  await usage.waitFor();
  await page.getByText('在设置卡和桌面米豆旁显示内存占用。', { exact: true }).waitFor();
  assert.equal(await showUsage.isChecked(), true);
  assert.equal(await notify.isChecked(), false);
  await showUsage.uncheck();
  await usage.waitFor({ state: 'hidden' });
  await page.getByText('已保存。', { exact: true }).waitFor();
  await notify.check();
  await page.getByText('已保存。', { exact: true }).waitFor();
  assert.deepEqual(sent, [
    { ...config, showUsage: false, notifyOnClean: false },
    { ...config, showUsage: false, notifyOnClean: true },
  ]);
});

test('帮手恢复后继续更新，按本地时间显示清理前后实际变化', async (t) => {
  let count = 0;
  const lastClean = {
    trigger: 'manual',
    at: '2026-11-28T06:25:30Z',
    before: { usedBytes: 10 * GB },
    after: { usedBytes: 11 * GB },
  };
  const page = await openCard(t, (route) => {
    count++;
    return route.fulfill({
      json: count === 1 ? { ok: false, available: false, reason: 'helper-failed' } : { ...reading, lastClean },
    });
  });
  await page.getByText('暂时无法连接到系统内存清理帮手。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '立即清理' }).isEnabled(), false);
  await page.clock.runFor(2100);
  await page.getByText(/上次手动清理.*14:25:30.*已用增加 1 GB/).waitFor();
  assert.equal(await page.getByRole('button', { name: '立即清理' }).isEnabled(), true);
});

test('保留正在编辑的数字和正在保存的选项，不被轮询覆盖', { timeout: 10000 }, async (t) => {
  let count = 0;
  let releaseRead;
  let releaseSave;
  let pendingRead;
  let pendingSave;
  const stale = new Promise((resolve) => (releaseRead = resolve));
  const save = new Promise((resolve) => (releaseSave = resolve));
  const readStarted = new Promise((resolve) => (pendingRead = resolve));
  const saveStarted = new Promise((resolve) => (pendingSave = resolve));
  let persisted = { ...config, showUsage: true, notifyOnClean: false };
  const page = await openCard(t, async (route) => {
    if (route.request().method() === 'POST') {
      pendingSave();
      await save;
      persisted = route.request().postDataJSON();
      return route.fulfill({ json: { ...reading, config: persisted } });
    }
    const payload = { ...reading, config: persisted };
    if (++count === 3) {
      pendingRead();
      await stale;
    }
    return route.fulfill({ json: payload });
  });
  const interval = page.getByLabel('定时间隔（秒）');
  await page.getByText(/62\.5%/).waitFor();
  await interval.fill('1900');
  const nextRead = page.waitForResponse((response) => response.request().method() === 'GET');
  await page.clock.runFor(2100);
  await nextRead;
  assert.equal(await interval.inputValue(), '1900');
  await page.clock.runFor(2100);
  await readStarted;
  await interval.press('Tab');
  await saveStarted;
  const staleResponse = page.waitForResponse((response) => response.request().method() === 'GET');
  releaseRead();
  await staleResponse;
  await page.clock.runFor(30);
  assert.equal(await interval.inputValue(), '1900');
  releaseSave();
  await page.getByText('已保存。', { exact: true }).waitFor();
  assert.equal(persisted.intervalSec, 1900);
});

test('清理结果区分实际下降、未下降和失败', async (t) => {
  let count = 0;
  const at = '2026-11-28T06:25:30Z';
  const start = { trigger: 'manual', at, before: { usedBytes: 10 * GB } };
  const reports = [
    { ...start, after: { usedBytes: 9 * GB } },
    { ...start, after: { usedBytes: 10 * GB } },
    { ...start, error: '读取清理后的内存失败' },
  ];
  const page = await openCard(t, (route) => {
    const lastClean = route.request().method() === 'POST' ? reports[count++] : undefined;
    return route.fulfill({ json: { ...reading, lastClean } });
  });
  const clean = page.getByRole('button', { name: '立即清理' });
  await clean.click();
  await page.getByText(/上次手动清理.*已用减少 1 GB/).waitFor();
  await clean.click();
  await page.getByText(/上次手动清理.*已用未下降/).waitFor();
  await clean.click();
  await page.getByText(/上次手动清理.*清理失败.*读取清理后的内存失败/).waitFor();
  await page
    .getByRole('status')
    .getByText(/清理失败 · 读取清理后的内存失败/)
    .waitFor();
  assert.equal(count, 3);
});
