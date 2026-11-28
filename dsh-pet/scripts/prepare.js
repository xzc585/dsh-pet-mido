#!/usr/bin/env node
/**
 * 完整构建：tsdown → lib、共享层 → shared-core.js、tsc → 类型声明。
 * npm 发布文件由 package.json 的 files 声明。
 *
 * 只发布单一 webm 格式（VP9-alpha），浏览器与桌面 Helper 共用，源码写死 .webm、发布期不做注入；
 * Safari/HEVC 兼容由仓库保留的流水线支持、需 fork 后自行启用，不参与本插件发布链。
 * 依赖 package.json 里的 bundle / build:desktop-core / types 三个脚本与本地 node_modules。
 * @module dsh-pet/scripts/prepare
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// 用 cmd /c 跑整条 npm 命令：Windows 下 npm 是 npm.cmd，spawnSync 无法直接执行 .cmd
// （命令行固定、无用户输入，没有注入风险）。
console.log('[prepare] building (tsdown)...');
const npmRun = process.platform === 'win32' ? 'cmd /c npm run bundle' : 'npm run bundle';
const build = spawnSync(npmRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (build.status !== 0) {
  console.error(`[prepare] 构建失败 (exit ${build.status})`);
  process.exit(1);
}

// 桌面共享核心与浏览器 bundle 取自同一份 src/shared，产出 window.PetShared（详见 build-desktop-core.mjs）。
console.log('[prepare] building desktop shared-core...');
const coreRun = process.platform === 'win32' ? 'cmd /c npm run build:desktop-core' : 'npm run build:desktop-core';
const buildCore = spawnSync(coreRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (buildCore.status !== 0) {
  console.error(`[prepare] 桌面 shared-core 构建失败 (exit ${buildCore.status})`);
  process.exit(1);
}

// 类型声明是构建产物、不入 git，克隆后靠这一步补齐；漏跑则 exports 声明的 types 路径全空。
console.log('[prepare] generating types (npm run types)...');
const typesRun = process.platform === 'win32' ? 'cmd /c npm run types' : 'npm run types';
const buildTypes = spawnSync(typesRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (buildTypes.status !== 0) {
  console.error(`[prepare] 类型声明生成失败 (exit ${buildTypes.status})`);
  process.exit(1);
}

console.log('[prepare] Build complete');
