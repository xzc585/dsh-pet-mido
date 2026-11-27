/**
 * 内置米豆种类的契约：配置合法，且每个动画名都有对应的透明 webm。
 *
 * 跑法：node --experimental-strip-types --test src/host/pet-pack-dog.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { topFieldValid } from './config/validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, '..', '..', 'assets', 'pet-packs', 'dog');

function collectAnimationNames(node: unknown, out: Set<string>): void {
  if (typeof node === 'string' && node.length > 0) {
    out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectAnimationNames(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'id' || key === 'weight' || key === 'noMirror' || key === 'params' || key === 'default') continue;
      if (key === 'name' && typeof value === 'string') {
        out.add(value);
        continue;
      }
      collectAnimationNames(value, out);
    }
  }
}

describe('内置米豆 pet pack', () => {
  test('dog-config.json 的 animations 与 animationWeights 通过宿主校验', () => {
    const raw = JSON.parse(readFileSync(join(packDir, 'dog-config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(topFieldValid('animations', raw.animations), true);
    assert.equal(topFieldValid('animationWeights', raw.animationWeights), true);
    assert.ok(Array.isArray(raw.pets) && raw.pets.length >= 1);
    const pet = raw.pets[0] as Record<string, unknown>;
    assert.equal(pet.id, 'dog');
    assert.equal(pet.name, '米豆');
  });

  test('配置里出现的每个动画名，都有同名的 .webm', () => {
    const raw = JSON.parse(readFileSync(join(packDir, 'dog-config.json'), 'utf8')) as Record<string, unknown>;
    const names = new Set<string>();
    collectAnimationNames(raw.animations, names);
    assert.ok(names.size >= 20, '动画名太少：' + names.size);
    const missing: string[] = [];
    for (const name of [...names].sort()) {
      const file = join(packDir, 'dog-animation', name + '.webm');
      if (!existsSync(file)) missing.push(name);
    }
    assert.deepEqual(missing, [], '缺少动画文件：' + missing.join('、'));
  });

  test('睡觉三段都在，参考图存在', () => {
    const raw = JSON.parse(readFileSync(join(packDir, 'dog-config.json'), 'utf8')) as Record<string, unknown>;
    const sleep = (raw.animations as { sleep: Array<{ start: string[]; loop: string[]; end: string[] }> }).sleep;
    assert.ok(Array.isArray(sleep) && sleep.length >= 1);
    assert.ok(sleep[0].start.includes('睡觉-入睡'));
    assert.ok(sleep[0].loop.includes('睡觉-循环'));
    assert.ok(sleep[0].end.includes('睡觉-醒来'));
    assert.equal(existsSync(join(packDir, 'dog-character.png')), true);
  });
});
