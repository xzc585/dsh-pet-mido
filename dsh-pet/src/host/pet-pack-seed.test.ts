/**
 * 内置宠物种类写入用户 pet/ 的契约：缺了才拷，已有的配置/动画/表情包目录不覆盖；
 * 已有配置但缺少 `<kind>-memes/` 时仍补拷；已有配置没有 `memes` 键时只合并该字段。
 *
 * 跑法：node --experimental-strip-types --test src/host/pet-pack-seed.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bundledPetPacksDir, seedBundledPetPacks } from './pet-pack-seed.ts';

function makeBundle(
  root: string,
  kind: string,
  config: string,
  extra?: { animation?: string; character?: boolean; memes?: Record<string, string> },
): void {
  const dir = join(root, kind);
  mkdirSync(join(dir, kind + '-animation'), { recursive: true });
  writeFileSync(join(dir, kind + '-config.json'), config);
  writeFileSync(join(dir, kind + '-animation', '待机呼吸.webm'), extra?.animation ?? 'webm');
  if (extra?.character) writeFileSync(join(dir, kind + '-character.png'), 'png');
  if (extra?.memes) {
    mkdirSync(join(dir, kind + '-memes'), { recursive: true });
    for (const [name, body] of Object.entries(extra.memes)) {
      writeFileSync(join(dir, kind + '-memes', name), body);
    }
  }
}

function existsAnim(dest: string): boolean {
  try {
    readFileSync(join(dest, 'dog-animation', '待机呼吸.webm'));
    return true;
  } catch {
    return false;
  }
}

describe('seedBundledPetPacks', () => {
  test('包内目录在 assets/pet-packs（包根或上一级）', () => {
    const found = bundledPetPacksDir();
    assert.ok(found, '应能定位到包内 pet-packs');
    assert.match(found, /assets[\\/]pet-packs$/);
  });

  test('目标没有该种类时拷贝配置、动画目录和参考图', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"pets":[]}', { character: true });
      assert.deepEqual(seedBundledPetPacks(dest, bundle), ['dog']);
      assert.equal(readFileSync(join(dest, 'dog-config.json'), 'utf8'), '{"pets":[]}');
      assert.equal(readFileSync(join(dest, 'dog-animation', '待机呼吸.webm'), 'utf8'), 'webm');
      assert.equal(readFileSync(join(dest, 'dog-character.png'), 'utf8'), 'png');
      assert.equal(existsSync(join(dest, 'dog-memes')), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('首次写入时，包内有 <kind>-memes/ 则一并复制', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"pets":[]}', { memes: { '打招呼.png': 'png', 'README.md': 'readme' } });
      assert.deepEqual(seedBundledPetPacks(dest, bundle), ['dog']);
      assert.equal(readFileSync(join(dest, 'dog-memes', '打招呼.png'), 'utf8'), 'png');
      assert.equal(readFileSync(join(dest, 'dog-memes', 'README.md'), 'utf8'), 'readme');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('已有配置文件时不覆盖配置和动画，也不算新写入', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new"}');
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'dog-config.json'), '{"name":"mine"}');
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      assert.equal(readFileSync(join(dest, 'dog-config.json'), 'utf8'), '{"name":"mine"}');
      assert.equal(existsAnim(dest), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('已有配置但目标没有 <kind>-memes/、包内有，则补拷表情包目录且不覆盖配置', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new"}', { memes: { '打招呼.png': 'bundled' } });
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'dog-config.json'), '{"name":"mine"}');
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      assert.equal(readFileSync(join(dest, 'dog-config.json'), 'utf8'), '{"name":"mine"}');
      assert.equal(existsAnim(dest), false);
      assert.equal(readFileSync(join(dest, 'dog-memes', '打招呼.png'), 'utf8'), 'bundled');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('目标已有 <kind>-memes/ 时不覆盖其中的文件', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new"}', { memes: { '打招呼.png': 'bundled', '新图.png': 'new' } });
      mkdirSync(join(dest, 'dog-memes'), { recursive: true });
      writeFileSync(join(dest, 'dog-config.json'), '{"name":"mine"}');
      writeFileSync(join(dest, 'dog-memes', '打招呼.png'), 'mine');
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      assert.equal(readFileSync(join(dest, 'dog-memes', '打招呼.png'), 'utf8'), 'mine');
      assert.equal(existsSync(join(dest, 'dog-memes', '新图.png')), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('已有配置没有 memes 键、包内有 memes 对象时，只合并该字段并保留用户字段', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      const bundled = '{\n  "name": "new",\n  "memes": {\n    "打招呼": "摇着尾巴问好"\n  }\n}\n';
      makeBundle(bundle, 'dog', bundled);
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'dog-config.json'), '{\n  "name": "mine",\n  "whisperPrompt": "用户人设"\n}\n');
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      const out = JSON.parse(readFileSync(join(dest, 'dog-config.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(out.name, 'mine');
      assert.equal(out.whisperPrompt, '用户人设');
      assert.deepEqual(out.memes, { 打招呼: '摇着尾巴问好' });
      assert.equal(Object.keys(out).includes('name'), true);
      assert.equal(readFileSync(join(dest, 'dog-config.json'), 'utf8').endsWith('\n'), true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('已有配置已经写了 memes（包括空对象）时不改写', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new","memes":{"打招呼":"包内描述"}}');
      mkdirSync(dest, { recursive: true });
      const mine = '{"name":"mine","memes":{}}';
      writeFileSync(join(dest, 'dog-config.json'), mine);
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      assert.equal(readFileSync(join(dest, 'dog-config.json'), 'utf8'), mine);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('包内配置没有 memes 对象时，已有用户配置原样保留', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new","memes":[]}');
      mkdirSync(dest, { recursive: true });
      const mine = '{"name":"mine"}';
      writeFileSync(join(dest, 'dog-config.json'), mine);
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      assert.equal(readFileSync(join(dest, 'dog-config.json'), 'utf8'), mine);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('目标已是 .jsonc、包内是 .json 时，合并进已有文件而不是再写一份 .json', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new","memes":{"打招呼":"问好"}}');
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'dog-config.jsonc'), '{\n  // 用户注释\n  "name": "mine"\n}\n');
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      assert.equal(existsSync(join(dest, 'dog-config.json')), false);
      const out = JSON.parse(readFileSync(join(dest, 'dog-config.jsonc'), 'utf8')) as Record<string, unknown>;
      assert.equal(out.name, 'mine');
      assert.deepEqual(out.memes, { 打招呼: '问好' });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('缺配置或缺动画目录的种类不写入', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      mkdirSync(join(bundle, 'broken'), { recursive: true });
      writeFileSync(join(bundle, 'broken', 'broken-config.json'), '{}');
      assert.deepEqual(seedBundledPetPacks(join(parent, 'pet'), bundle), []);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
