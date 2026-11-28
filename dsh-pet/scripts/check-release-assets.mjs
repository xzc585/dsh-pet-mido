#!/usr/bin/env node
/** 核对 npm 发布文件清单或 Windows 解包目录里的米豆资源。 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dog = 'assets/pet-packs/dog';
const dogConfig = `${dog}/dog-config.json`;
const helper = 'tools/mido-ram-cleaner.exe';
const format = process.argv[2];

function requireFiles(files, names) {
  const missing = names.filter((name) => !files.has(name));
  if (missing.length) throw new Error(`缺少发布文件：${missing.join('、')}`);
}

function verifyAssets(files, readFile) {
  requireFiles(files, [dogConfig]);
  const config = JSON.parse(readFile(dogConfig));
  const { idle, turn, drag, clicks, moves, categories, events, sleep } = config.animations;
  const names = new Set([
    ...idle,
    ...turn,
    ...drag,
    ...clicks,
    ...moves.actions.map((action) => action.name),
    ...categories.flatMap((category) => category.actions),
    ...Object.values(events).flat(),
    ...sleep.flatMap(({ start, loop, end }) => [...start, ...loop, ...end]),
  ]);
  const memeNames = Object.keys(config.memes);
  const required = [
    'lib/app.js',
    'runtime/electron-helper/shared-core.js',
    'assets/config.jsonc',
    `${dog}/dog-character.png`,
    ...[...names].map((name) => `${dog}/dog-animation/${name}.webm`),
    ...memeNames.map((name) => `${dog}/dog-memes/${name}.png`),
  ];
  if (!idle.length || !memeNames.length) throw new Error('米豆必须有待机动画和对话配图');
  requireFiles(files, required);
  console.log(`已核对 ${names.size} 段米豆动画、${memeNames.length} 张配图及桌面运行文件`);
}

function checkNpm() {
  const [pack] = JSON.parse(
    execSync('npm pack --dry-run --ignore-scripts --json', {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  const files = new Set(pack.files.filter((file) => file.size > 0).map((file) => file.path));
  verifyAssets(files, (name) => readFileSync(join(root, name), 'utf8'));
  requireFiles(files, [
    'lib/index.js',
    'lib/client.js',
    'lib/standalone.js',
    'lib/types/index.d.ts',
    'lib/types/client/index.d.ts',
    'cordis.patch.yml',
    `assets/${helper}`,
  ]);
  if (pack.unpackedSize > 200e6) throw new Error(`npm 包解压体积超限：${pack.unpackedSize} 字节`);
  console.log(`npm 发布清单通过，解压体积 ${(pack.unpackedSize / 1e6).toFixed(1)} MB`);
}

function checkWindows() {
  // 使用 electron-builder 自己依赖的 ASAR 库，以兼容 npm 与 pnpm 的依赖布局。
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
  const asar = appBuilderRequire('@electron/asar');
  const directory = resolve(process.argv[3] ?? join(root, 'dist-app/win-unpacked'));
  const archive = join(directory, 'resources', 'app.asar');
  const files = new Set(
    asar
      .listPackage(archive)
      .map((path) => path.slice(1))
      .filter((path) => asar.statFile(archive, path).size > 0)
      .map((path) => path.replaceAll('\\', '/')),
  );
  verifyAssets(files, (name) => asar.extractFile(archive, join(...name.split('/'))).toString('utf8'));
  if (files.has(`assets/${helper}`)) throw new Error('Windows 助手应放在 ASAR 外');
  for (const path of ['dsh-pet.exe', `resources/${helper}`]) {
    const stat = statSync(join(directory, path));
    if (!stat.isFile() || stat.size === 0) throw new Error(`无效的可执行文件：${path}`);
  }
  console.log('Windows 解包产物及外置内存清理助手检查通过');
}

try {
  if (format === '--windows') checkWindows();
  else if (!format) checkNpm();
  else throw new Error(`未知检查模式：${format}`);
} catch (error) {
  console.error(`[check-release-assets] ${error.message}`);
  process.exitCode = 1;
}
