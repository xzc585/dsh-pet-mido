/**
 * 把包内附带的宠物种类写到用户的 pet/ 目录。
 *
 * 首次出现的种类：复制配置、`<kind>-animation/`、立绘，以及（若包内有）`<kind>-memes/`。
 * 目标已有配置文件时：不覆盖配置、动画和立绘；若目标还没有 `<kind>-memes/` 而包内有，则补拷该目录；
 * 若目标配置缺少 `memes` 字段（键不存在或值为 undefined）而包内配置有 `memes` 对象，则只把该字段合并进去，其它用户字段一律不动。
 * 用户目录里已经存在的 `<kind>-memes/` 不会被覆盖。
 * 这和对话长期记忆无关：只是把 `assets/pet-packs/<kind>/` 拷到 `$DSH_HOME/dsh-pet/pet/`。
 * @module dsh-pet/src/host/pet-pack-seed
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readJsonc } from './config/jsonc.ts';
import { PACKAGE_ROOT } from './paths.ts';

/**
 * 包内宠物种类根目录。构建后 `PACKAGE_ROOT` 是包根；测试从 `src/host` 加载时是 `src/`，
 * 所以同时看上一级的 `assets/pet-packs`。
 */
export function bundledPetPacksDir(packageRoot = PACKAGE_ROOT): string | undefined {
  const candidates = [join(packageRoot, 'assets', 'pet-packs'), join(packageRoot, '..', 'assets', 'pet-packs')];
  return candidates.find((dir) => existsSync(dir));
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 定位用户目录里该种类的配置文件。优先与包内同一扩展名（.json / .jsonc），
 * 否则回落到另一种扩展名，避免两边扩展名不一致时误当成「尚未安装」再写一份。
 */
function resolveDestConfig(petConfigDir: string, kind: string, srcConfig: string): { path: string; exists: boolean } {
  const useJsonc = srcConfig.endsWith('.jsonc');
  const preferred = join(petConfigDir, kind + (useJsonc ? '-config.jsonc' : '-config.json'));
  const other = join(petConfigDir, kind + (useJsonc ? '-config.json' : '-config.jsonc'));
  if (existsSync(preferred)) return { path: preferred, exists: true };
  if (existsSync(other)) return { path: other, exists: true };
  return { path: preferred, exists: false };
}

function isMemesObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 包内配置的 `memes` 对象；缺失、非法或文件读不出 → undefined。 */
function bundledMemes(srcConfig: string): Record<string, unknown> | undefined {
  const src = readJsonc(srcConfig);
  if (!src || !isMemesObject(src.memes)) return undefined;
  return src.memes;
}

/**
 * 目标已有配置、但还没有 `memes` 键时，把包内的 `memes` 对象合并进去。
 * 用户已经写了 `memes`（包括空对象）则不动。解析失败也不改文件。
 * 写入为 2 空格缩进的 JSON 并保留末尾换行（与现有种类配置一致）；jsonc 注释不会保留。
 */
function mergeBundledMemes(destConfig: string, srcConfig: string): void {
  const memes = bundledMemes(srcConfig);
  if (!memes) return;
  const dest = readJsonc(destConfig);
  if (!dest) return;
  if (Object.prototype.hasOwnProperty.call(dest, 'memes') && dest.memes !== undefined) return;
  dest.memes = memes;
  writeFileSync(destConfig, JSON.stringify(dest, null, 2) + '\n', 'utf8');
}

/** 包内有 `<kind>-memes/` 且目标还没有时才复制；已有目标目录一律不覆盖。 */
function seedMemesDir(srcDir: string, destDir: string, kind: string): void {
  const srcMemes = join(srcDir, kind + '-memes');
  const destMemes = join(destDir, kind + '-memes');
  if (!isDir(srcMemes) || existsSync(destMemes)) return;
  cpSync(srcMemes, destMemes, { recursive: true });
}

/**
 * 将尚未出现在用户目录里的内置种类复制过去；已有种类按需补拷 `<kind>-memes/` 并可能合并 `memes` 字段。
 *
 * @param petConfigDir - `$DSH_HOME/dsh-pet/pet`。
 * @param bundledRoot - 测试可注入；缺省时自动定位包内目录。
 * @returns 本次作为新种类完整写入的名前缀（如 `dog`）；仅补拷表情包或合并字段不算在内。
 */
export function seedBundledPetPacks(petConfigDir: string, bundledRoot = bundledPetPacksDir()): string[] {
  mkdirSync(petConfigDir, { recursive: true });
  if (!bundledRoot || !existsSync(bundledRoot)) return [];
  const seeded: string[] = [];
  for (const entry of readdirSync(bundledRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const kind = entry.name;
    const srcDir = join(bundledRoot, kind);
    const srcConfigJson = join(srcDir, kind + '-config.json');
    const srcConfigJsonc = join(srcDir, kind + '-config.jsonc');
    const srcConfig = existsSync(srcConfigJson) ? srcConfigJson : existsSync(srcConfigJsonc) ? srcConfigJsonc : '';
    const srcAnim = join(srcDir, kind + '-animation');
    if (!srcConfig || !existsSync(srcAnim)) continue;
    const dest = resolveDestConfig(petConfigDir, kind, srcConfig);
    const destAnim = join(petConfigDir, kind + '-animation');
    const destCharacterPng = join(petConfigDir, kind + '-character.png');
    const destCharacterJpg = join(petConfigDir, kind + '-character.jpg');
    if (dest.exists) {
      seedMemesDir(srcDir, petConfigDir, kind);
      mergeBundledMemes(dest.path, srcConfig);
      continue;
    }
    mkdirSync(petConfigDir, { recursive: true });
    cpSync(srcConfig, dest.path);
    if (!existsSync(destAnim)) cpSync(srcAnim, destAnim, { recursive: true });
    const srcCharacter = ['png', 'jpg', 'jpeg', 'webp']
      .map((ext) => join(srcDir, kind + '-character.' + ext))
      .find((file) => existsSync(file));
    if (srcCharacter && !existsSync(destCharacterPng) && !existsSync(destCharacterJpg)) {
      const ext = srcCharacter.slice(srcCharacter.lastIndexOf('.'));
      cpSync(srcCharacter, join(petConfigDir, kind + '-character' + ext));
    }
    seedMemesDir(srcDir, petConfigDir, kind);
    seeded.push(kind);
  }
  return seeded;
}
