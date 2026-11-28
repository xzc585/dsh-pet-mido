import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';

const sharedCore = fileURLToPath(new URL('../../runtime/electron-helper/shared-core.js', import.meta.url));

test('对话框在贴边处输入长文字后仍处在可用区域内', { skip: !existsSync(sharedCore) }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 360 } });
    await page.setContent('<!doctype html><meta charset="utf-8">');
    await page.addScriptTag({ path: sharedCore });
    await page.evaluate(() => {
      window.PetShared.mountChatDialog({
        petId: 'dog',
        surface: 'web',
        x: 360,
        y: 300,
        clamp: { x: 30, y: 20, w: 330, h: 300 },
      });
    });
    const chat = page.locator('.dsh-pet-chat');
    const initial = await chat.boundingBox();
    await chat.locator('textarea').fill('这是一段很长的待发送内容。'.repeat(125));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const grown = await chat.boundingBox();
    assert.ok(grown.width > initial.width);
    assert.ok(grown.x >= 30 && grown.x + grown.width <= 360, JSON.stringify(grown));
    assert.ok(grown.y >= 20 && grown.y + grown.height <= 320, JSON.stringify(grown));
    const upload = chat.getByRole('button', { name: '上传图片' });
    await upload.scrollIntoViewIfNeeded();
    const button = await upload.boundingBox();
    assert.ok(button.y >= grown.y && button.y + button.height <= grown.y + grown.height);
  } finally {
    await browser.close();
  }
});

test('积分弹窗完整留在最小尺寸宠物的可见窗口内', { skip: !existsSync(sharedCore) }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 220, height: 180 } });
    await page.setContent('<!doctype html><meta charset="utf-8">');
    await page.addScriptTag({ path: sharedCore });
    await page.evaluate(() => {
      const popup = window.PetShared.mountScorePopup({
        x: 50,
        y: 41,
        score: 20,
        speed: 1250,
        size: 80,
        clamp: { x: 37, y: 37, w: 123, h: 100 },
      });
      return Promise.all(popup.el.getAnimations().map((animation) => animation.finished));
    });
    const popup = page.locator('.dsh-pet-score');
    const box = await popup.boundingBox();
    assert.ok(box.x >= 37 && box.x + box.width <= 160, JSON.stringify(box));
    assert.ok(box.y >= 37 && box.y + box.height <= 137, JSON.stringify(box));
    assert.match(await popup.innerText(), /速度 1250\s+·\s+大小 80/);
  } finally {
    await browser.close();
  }
});
