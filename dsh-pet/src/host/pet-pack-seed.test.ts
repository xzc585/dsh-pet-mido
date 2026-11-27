/**
 * 内置宠物种类写入用户 pet/ 的契约：缺了才拷，已有的不覆盖。
 *
 * 跑法：node --experimental-strip-types --test src/host/pet-pack-seed.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bundledPetPacksDir, seedBundledPetPacks } from './pet-pack-seed.ts';

function makeBundle(root: string, kind: string, config: string, extra?: { animation?: string; character?: boolean }): void {
  const dir = join(root, kind);
  mkdirSync(join(dir, kind + '-animation'), { recursive: true });
  writeFileSync(join(dir, kind + '-config.json'), config);
  writeFileSync(join(dir, kind + '-animation', '待机呼吸.webm'), extra?.animation ?? 'webm');
  if (extra?.character) writeFileSync(join(dir, kind + '-character.png'), 'png');
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
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('已有配置文件时整包跳过，不覆盖用户改动', () => {
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

function existsAnim(dest: string): boolean {
  try {
    readFileSync(join(dest, 'dog-animation', '待机呼吸.webm'));
    return true;
  } catch {
    return false;
  }
}
