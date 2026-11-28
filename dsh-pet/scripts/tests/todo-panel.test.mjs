import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

const NOW = new Date('2026-11-28T13:40:01+08:00');
const AFTERNOON = new Date('2026-11-28T14:00:00+08:00').getTime();
let browser, server, origin;

before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('../../src/shared/todo/panel.ts', import.meta.url)),
    platform: 'browser',
  });
  const { output } = await bundle.generate({ format: 'iife', name: 'TodoFixture' });
  await bundle.close();
  server = createServer((req, res) => {
    if (req.url === '/todo.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(output[0].code);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><body><script src="/todo.js"></script><script>document.body.append(TodoFixture.createTodoPanel().el)</script>',
    );
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

async function openPanel(t, now = NOW) {
  const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', locale: 'en-US' });
  t.after(() => context.close());
  const sent = [];
  const page = await context.newPage();
  await page.clock.setFixedTime(now);
  await page.route('**/dsh-pet-7340/todos', (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const todo = request.postDataJSON();
      sent.push(todo);
      return route.fulfill({ json: { ok: true, todo: { ...todo, id: 'fixture-1', createdAt: 1, updatedAt: 1 } } });
    }
    return route.fulfill({ json: { ok: true, todos: [] } });
  });
  await page.goto(origin);
  await page.locator('.dsh-pet-todo-input').fill('检查提醒');
  return { page, sent };
}

async function submit(page) {
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'),
    page.locator('.dsh-pet-todo-add').click(),
  ]);
}

test('选择今天时采用尚未到期的默认时间，按中国本地时刻提交', async (t) => {
  const { page, sent } = await openPanel(t);
  const due = page.locator('.dsh-pet-todo-due');
  await due.click();
  await page.locator('button[data-act=today]').click();
  assert.equal(await due.textContent(), '今天 14:00');
  assert.equal(await due.getAttribute('title'), '2026-11-28 14:00');
  await page.locator('button[data-act=done]').click();
  await submit(page);
  assert.deepEqual(sent, [{ text: '检查提醒', dueAt: AFTERNOON }]);
});

test('先选择 24 小时制的 14 时也能提交今天的提醒', async (t) => {
  const { page, sent } = await openPanel(t);
  const due = page.locator('.dsh-pet-todo-due');
  await due.click();
  await page.locator('button[data-act=hour]').click();
  await page.getByRole('button', { name: '14 时', exact: true }).click();
  assert.equal(await due.textContent(), '今天 14:00');
  await page.locator('button[data-act=done]').click();
  await submit(page);
  assert.deepEqual(sent, [{ text: '检查提醒', dueAt: AFTERNOON }]);
});

test('确实过期时显示所选日期时间和当前时刻', async (t) => {
  const { page, sent } = await openPanel(t);
  const due = page.locator('.dsh-pet-todo-due');
  await due.click();
  await page.locator('button[data-act=today]').click();
  await page.locator('button[data-act=hour]').click();
  await page.getByRole('button', { name: '13 时', exact: true }).click();
  await page.locator('button[data-act=done]').click();
  await page.locator('.dsh-pet-todo-add').click();
  assert.match(await page.locator('.dsh-pet-todo-err').textContent(), /2026-11-28 13:00.*13:40:01/);
  assert.deepEqual(sent, []);
});

test('晚间还有未来分钟档位时，今天的默认提醒留在今天', async (t) => {
  const { page, sent } = await openPanel(t, new Date('2026-11-28T23:40:01+08:00'));
  const due = page.locator('.dsh-pet-todo-due');
  await due.click();
  await page.locator('button[data-act=today]').click();
  assert.equal(await due.textContent(), '今天 23:45');
  await page.locator('button[data-act=done]').click();
  await submit(page);
  assert.equal(sent[0].dueAt, new Date('2026-11-28T23:45:00+08:00').getTime());
});

test('当天最后一个分钟档位已过时，解释为什么默认提醒改到明天', async (t) => {
  const { page, sent } = await openPanel(t, new Date('2026-11-28T23:58:00+08:00'));
  const due = page.locator('.dsh-pet-todo-due');
  await due.click();
  await page.locator('button[data-act=today]').click();
  assert.equal(await due.textContent(), '已改为明天 00:00');
  assert.match(await due.getAttribute('aria-label'), /2026-11-29 00:00.*原选日期已无可选时间/);
  await page.locator('button[data-act=done]').click();
  await submit(page);
  assert.equal(sent[0].dueAt, new Date('2026-11-29T00:00:00+08:00').getTime());
});
