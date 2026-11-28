import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

let browser, server, origin;

before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./todo-overlay.fixture.js', import.meta.url)),
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
    if (req.url.endsWith('/todos')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, todos: [] }));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><div class="dsh-pet-root" style="left:710px;top:35px;width:200px;height:112px;--dsh-pet-size:200px"></div><script src="/fixture.js"></script>',
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

test('网页待办面板避开右上角，移动宠物后跟随到头顶', async (t) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 550 } });
  t.after(() => page.close());
  await page.goto(origin);
  const todo = page.locator('.dsh-pet-todo-bubble');
  await todo.locator('.dsh-pet-todo-input').waitFor();
  const corner = await todo.boundingBox();
  assert.ok(corner.x >= 8 && corner.x + corner.width <= 792, JSON.stringify(corner));
  assert.ok(corner.y >= 147 && corner.y + corner.height <= 542, JSON.stringify(corner));
  await page.locator('.dsh-pet-root').evaluate((pet) => {
    pet.style.left = '300px';
    pet.style.top = '300px';
  });
  await page.waitForFunction(() => {
    const box = document.querySelector('.dsh-pet-todo-bubble').getBoundingClientRect();
    return Math.abs(box.x + box.width / 2 - 400) < 1 && Math.abs(box.bottom - 321.6) < 1;
  });
});

test('矮视口限制待办面板高度，日历仍可滚动操作', async (t) => {
  const page = await browser.newPage({ viewport: { width: 340, height: 150 } });
  t.after(() => page.close());
  await page.goto(origin);
  await page.locator('.dsh-pet-root').evaluate((pet) => {
    pet.style.left = '100px';
    pet.style.top = '12px';
  });
  const todo = page.locator('.dsh-pet-todo-bubble');
  await page.waitForFunction(() => {
    const box = document.querySelector('.dsh-pet-todo-bubble').getBoundingClientRect();
    return box.left >= 8 && box.right <= 332 && box.top >= 8 && box.bottom <= 142;
  });
  await todo.locator('.dsh-pet-todo-due').click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.dsh-pet-todo');
    const fold = panel.querySelector('.dsh-pet-todo-fold.is-cal');
    const calendar = fold.querySelector('.dsh-pet-todo-cal');
    return fold.clientHeight >= calendar.offsetHeight && panel.scrollHeight > panel.clientHeight;
  });
  const confirm = todo.locator('button[data-act=done]');
  await confirm.scrollIntoViewIfNeeded();
  assert.ok(await todo.locator('.dsh-pet-todo').evaluate((el) => el.scrollTop > 0));
  await confirm.click();
});
