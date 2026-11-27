/**
 * 把包内附带的宠物种类写到用户的 pet/ 目录。
 *
 * 只在目标种类还没有配置文件时复制，已有的用户改动一律不动。
 * 这和对话长期记忆无关：只是把 `assets/pet-packs/<kind>/` 拷到 `$DSH_HOME/dsh-pet/pet/`。
 * @module dsh-pet/src/host/pet-pack-seed
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGE_ROOT } from './paths.ts';

/**
 * 包内宠物种类根目录。构建后 `PACKAGE_ROOT` 是包根；测试从 `src/host` 加载时是 `src/`，
 * 所以同时看上一级的 `assets/pet-packs`。
 */
export function bundledPetPacksDir(packageRoot = PACKAGE_ROOT): string | undefined {
  const candidates = [join(packageRoot, 'assets', 'pet-packs'), join(packageRoot, '..', 'assets', 'pet-packs')];
  return candidates.find((dir) => existsSync(dir));
}

/**
 * 将尚未出现在用户目录里的内置种类复制过去。
 *
 * @param petConfigDir - `$DSH_HOME/dsh-pet/pet`。
 * @param bundledRoot - 测试可注入；缺省时自动定位包内目录。
 * @returns 本次新写入的种类名前缀（如 `dog`）。
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
    const destConfig = join(petConfigDir, kind + (srcConfig.endsWith('.jsonc') ? '-config.jsonc' : '-config.json'));
    const destAnim = join(petConfigDir, kind + '-animation');
    const destCharacterPng = join(petConfigDir, kind + '-character.png');
    const destCharacterJpg = join(petConfigDir, kind + '-character.jpg');
    if (existsSync(destConfig)) continue;
    mkdirSync(petConfigDir, { recursive: true });
    cpSync(srcConfig, destConfig);
    if (!existsSync(destAnim)) cpSync(srcAnim, destAnim, { recursive: true });
    const srcCharacter = ['png', 'jpg', 'jpeg', 'webp']
      .map((ext) => join(srcDir, kind + '-character.' + ext))
      .find((file) => existsSync(file));
    if (srcCharacter && !existsSync(destCharacterPng) && !existsSync(destCharacterJpg)) {
      const ext = srcCharacter.slice(srcCharacter.lastIndexOf('.'));
      cpSync(srcCharacter, join(petConfigDir, kind + '-character' + ext));
    }
    seeded.push(kind);
  }
  return seeded;
}
