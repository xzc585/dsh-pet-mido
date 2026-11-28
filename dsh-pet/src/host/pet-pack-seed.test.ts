/**
 * 内置宠物种类写入用户 pet/ 的契约：补齐缺失素材，按哈希更新指定旧版素材，保留用户文件；
 * 已有配置但缺少 `<kind>-memes/` 时仍补拷；已有配置没有 `memes` 键时只合并该字段。
 *
 * 跑法：node --experimental-strip-types --test src/host/pet-pack-seed.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

const LEGACY_TURN = 'old stock clip';
const LEGACY_TURN_DIGESTS = new Map([
  [BigInt(Buffer.byteLength(LEGACY_TURN)), createHash('sha256').update(LEGACY_TURN).digest('hex')],
]);
const TURN_FILE = '转转头.webm';

describe('seedBundledPetPacks', () => {
  test('包内目录在 assets/pet-packs（包根或上一级）', () => {
    const found = bundledPetPacksDir();
    assert.ok(found, '应能定位到包内 pet-packs');
    assert.match(found, /assets[\\/]pet-packs$/);
  });

  test('打包版优先使用 app.asar 外的真实素材目录', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-resources-'));
    try {
      const archive = join(parent, 'app.asar');
      const embedded = join(archive, 'assets', 'pet-packs');
      const external = join(parent, 'assets', 'pet-packs');
      mkdirSync(embedded, { recursive: true });
      mkdirSync(external, { recursive: true });
      assert.equal(bundledPetPacksDir(archive), external);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
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

  test('首次复制中断留下配置时补齐缺失动画和立绘，保留原配置', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new"}', { character: true });
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'dog-config.json'), '{"name":"mine"}');
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      assert.equal(readFileSync(join(dest, 'dog-config.json'), 'utf8'), '{"name":"mine"}');
      assert.equal(readFileSync(join(dest, 'dog-animation', '待机呼吸.webm'), 'utf8'), 'webm');
      assert.equal(readFileSync(join(dest, 'dog-character.png'), 'utf8'), 'png');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('动画目录部分写入时只补缺失文件，保留自定义动画', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-partial-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      const existing = join(dest, 'dog-animation');
      makeBundle(bundle, 'dog', '{"name":"new"}');
      writeFileSync(join(bundle, 'dog', 'dog-animation', '点击.webm'), 'bundled click');
      mkdirSync(existing, { recursive: true });
      writeFileSync(join(dest, 'dog-config.json'), '{"name":"mine"}');
      writeFileSync(join(existing, '点击.webm'), 'custom click');
      assert.deepEqual(seedBundledPetPacks(dest, bundle), []);
      assert.equal(readFileSync(join(existing, '待机呼吸.webm'), 'utf8'), 'webm');
      assert.equal(readFileSync(join(existing, '点击.webm'), 'utf8'), 'custom click');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('只更新已识别的旧版米豆转转头动画，保留用户素材与初始化结果', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-turn-'));
    try {
      const bundle = join(parent, 'bundle');
      const next = 'new stock clip';
      const config = '{"name":"mine","memes":{}}\n';
      makeBundle(bundle, 'dog', '{"name":"new"}');
      writeFileSync(join(bundle, 'dog', 'dog-animation', TURN_FILE), next);
      writeFileSync(join(bundle, 'dog', 'dog-animation', '另一个动作.webm'), 'new other clip');
      for (const [name, existing, expected] of [
        ['legacy', LEGACY_TURN, next],
        ['custom', 'user edit clip', 'user edit clip'],
        ['current', next, next],
        ['missing', undefined, next],
      ] as const) {
        const dest = join(parent, name);
        const anim = join(dest, 'dog-animation');
        const turn = join(anim, TURN_FILE);
        mkdirSync(anim, { recursive: true });
        writeFileSync(join(dest, 'dog-config.json'), config);
        writeFileSync(join(anim, '另一个动作.webm'), LEGACY_TURN);
        if (existing !== undefined) {
          writeFileSync(turn, existing);
          utimesSync(turn, 1, 1);
        }
        const before = lstatSync(turn, { throwIfNoEntry: false })?.mtimeMs;
        assert.deepEqual(seedBundledPetPacks(dest, bundle, LEGACY_TURN_DIGESTS), []);
        assert.equal(readFileSync(turn, 'utf8'), expected);
        assert.equal(readFileSync(join(dest, 'dog-config.json'), 'utf8'), config);
        assert.equal(readFileSync(join(anim, '另一个动作.webm'), 'utf8'), LEGACY_TURN);
        assert.equal(readFileSync(join(anim, '待机呼吸.webm'), 'utf8'), 'webm');
        if (before !== undefined && existing === expected) assert.equal(lstatSync(turn).mtimeMs, before);
        const after = lstatSync(turn).mtimeMs;
        assert.deepEqual(seedBundledPetPacks(dest, bundle, LEGACY_TURN_DIGESTS), []);
        assert.equal(lstatSync(turn).mtimeMs, after);
        assert.ok(readdirSync(anim).every((file) => !file.endsWith('.tmp')));
      }
      assert.deepEqual(seedBundledPetPacks(join(parent, 'new'), bundle, LEGACY_TURN_DIGESTS), ['dog']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('包内缺少合法的新版转转头时保留旧版', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-turn-missing-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new"}');
      const anim = join(dest, 'dog-animation');
      mkdirSync(anim, { recursive: true });
      const turn = join(anim, TURN_FILE);
      writeFileSync(turn, LEGACY_TURN);
      assert.deepEqual(seedBundledPetPacks(dest, bundle, LEGACY_TURN_DIGESTS), ['dog']);
      assert.equal(readFileSync(turn, 'utf8'), LEGACY_TURN);
      const invalid = join(bundle, 'dog', 'dog-animation', TURN_FILE);
      writeFileSync(invalid, '');
      assert.deepEqual(seedBundledPetPacks(dest, bundle, LEGACY_TURN_DIGESTS), []);
      assert.equal(readFileSync(turn, 'utf8'), LEGACY_TURN);
      rmSync(invalid);
      mkdirSync(invalid);
      assert.deepEqual(seedBundledPetPacks(dest, bundle, LEGACY_TURN_DIGESTS), []);
      assert.equal(readFileSync(turn, 'utf8'), LEGACY_TURN);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('转转头迁移不会替换用户链接或采用包内链接', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-pet-seed-turn-link-'));
    try {
      const bundle = join(parent, 'bundle');
      const dest = join(parent, 'pet');
      makeBundle(bundle, 'dog', '{"name":"new"}');
      const anim = join(dest, 'dog-animation');
      mkdirSync(anim, { recursive: true });
      const installed = join(anim, TURN_FILE);
      const packaged = join(bundle, 'dog', 'dog-animation', TURN_FILE);
      const linked = join(parent, 'linked.webm');
      // Windows 目录联接同样由 lstat 识别为链接，且不需要管理员权限。
      const type = process.platform === 'win32' ? 'junction' : 'file';
      if (type === 'junction') mkdirSync(linked);
      const contents = type === 'junction' ? join(linked, 'original.webm') : linked;
      writeFileSync(contents, LEGACY_TURN);
      symlinkSync(linked, installed, type);
      writeFileSync(packaged, 'new stock clip');
      assert.deepEqual(seedBundledPetPacks(dest, bundle, LEGACY_TURN_DIGESTS), ['dog']);
      assert.ok(lstatSync(installed).isSymbolicLink());
      assert.equal(readFileSync(contents, 'utf8'), LEGACY_TURN);

      rmSync(installed);
      rmSync(packaged);
      writeFileSync(installed, LEGACY_TURN);
      writeFileSync(contents, 'new stock clip');
      symlinkSync(linked, packaged, type);
      assert.deepEqual(seedBundledPetPacks(dest, bundle, LEGACY_TURN_DIGESTS), []);
      assert.equal(readFileSync(installed, 'utf8'), LEGACY_TURN);
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
      assert.equal(existsAnim(dest), true);
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
