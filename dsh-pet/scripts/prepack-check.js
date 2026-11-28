#!/usr/bin/env node
/**
 * 发布前健康检查，由 package.json 的 prepack 触发，任何一项失败都以非零退出码阻断发布。
 *
 * 查必需文件、原始母版、client.js 的 bundle 形态、DSH 声明和未声明的运行时依赖。
 * 米豆资源由 check-release-assets.mjs 根据实际产物检查。
 * 只读检查，不构建、不打包、不改任何文件，依赖已构建好的 lib 与 assets。
 * @module dsh-pet/scripts/prepack-check
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 包根目录（scripts/ 的上一级）
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// 失败与通过两种输出的辅助函数。
const fail = (msg) => {
  console.error(`[prepack-check] FAIL: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`[prepack-check] ok: ${msg}`);
// 缺任一件，装上就是运行期报错，所以在发布前逐个点名。
const required = [
  'lib/index.js', // 宿主半侧
  'lib/client.js', // 浏览器半侧
  'lib/types/index.d.ts', // 宿主类型声明
  'lib/types/client/index.d.ts', // 客户端类型声明
  'cordis.patch.yml', // bundle patch（挂载声明）
  'runtime/electron-helper/main.js', // 桌面模式 Electron 主进程
  'runtime/electron-helper/main/smoke.js', // 桌面模式冒烟自检（main.js require，缺了启动即崩）
  'runtime/electron-helper/main/dpi.js', // 桌面模式 DPI 与指针（main.js require，缺了启动即崩）
  'runtime/electron-helper/main/bridge.js', // 桌面模式与宿主通道（同上）
  'runtime/electron-helper/main/tray.js', // 桌面模式托盘（同上）
  'runtime/electron-helper/main/windows.js', // 桌面模式窗口与两条实时泵（同上）
  'runtime/electron-helper/main/ipc.js', // 桌面模式 ipc 处理器（同上）
  'runtime/electron-helper/main/displays.js', // 桌面模式显示器热更新（同上）
  'runtime/electron-helper/main/user-data.js', // 桌面模式 userData 回退决策（main.js require，缺了会启动即崩）
  'runtime/electron-helper/pointer-target.js', // 桌面模式点击穿透兜底判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/host-liveness.js', // 桌面模式宿主存活判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/topmost-watchdog.js', // 桌面模式置顶看门狗判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/taskbar-watchdog.js', // 桌面模式任务栏看门狗判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/dpi-linearization.js', // 桌面模式 DPI 线性化判定与换算（main.js require，缺了会启动即崩）
  'runtime/electron-helper/tray-platform.js', // 桌面模式托盘平台差异判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/desktop-geometry.js', // 活动边界与菜单工作区分离
  'runtime/electron-helper/preload.js', // 桌面模式 preload 桥
  'runtime/electron-helper/renderer.js', // 桌面模式渲染端（宠物本体）
  'runtime/electron-helper/system-memory.js', // 桌面内存占用读数
  'runtime/electron-helper/sprite/bubble.js', // 桌面模式气泡与提示渲染（sprite.js 的原型扩展，须在其后加载）
  'runtime/electron-helper/sprite/menu.js', // 桌面模式右键菜单（sprite.js 的原型扩展，须在其后加载）
  'runtime/electron-helper/sprite/playback.js', // 桌面模式播放状态机（同上）
  'runtime/electron-helper/sprite/motion.js', // 桌面模式运动驱动（同上）
  'runtime/electron-helper/sprite/input.js', // 桌面模式指针与命中（同上）
  'runtime/electron-helper/sprite/init.js', // 桌面模式构建期初始化（同上）
  'runtime/electron-helper/sprite/window-fit.js', // 桌面模式窗口落位与钳制补偿（sprite.js 的原型扩展，须在其后加载）
  'runtime/electron-helper/shared-core.js', // 桌面模式共享纯逻辑（src/shared 构建产物，window.PetShared）
  'runtime/electron-helper/index.html', // 桌面模式页面壳
];
for (const f of required) {
  existsSync(join(ROOT, f)) ? ok(`exists ${f}`) : fail(`missing ${f}`);
}

// 原始母版（1200×1200）体积超限，应放 GitHub Releases，不进 npm 包。
// assets/ 根下若有 .webm 就是原始母版，播放素材在 assets/webm|mov 子目录。
const originals = [];
const assetsRoot = join(ROOT, 'assets');
for (const name of readdirSync(assetsRoot)) {
  if (name.endsWith('.webm')) originals.push(name);
}
if (originals.length > 0)
  fail(`original masters must not ship in npm package: ${originals.join(', ')} (move them to GitHub Releases)`);
else ok('no original masters in assets/');

// 宿主加载器只认官方 bundle 形态；形制不对，插件在浏览器半侧根本注册不上。
const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
client.includes('__ModuleLoader__.load')
  ? ok('client bundle shell OK')
  : fail('client.js missing __ModuleLoader__.load');
const exportsPlugin =
  /exports\.(apply|inject|name)/.test(client) || /module\.exports\s*=\s*\{[^}]*apply[^}]*inject[^}]*name/.test(client);
exportsPlugin ? ok('client exports apply/inject/name') : fail('client.js missing apply/inject/name exports');

// 两项声明缺任一个都装不进宿主：bundle 声明决定挂载声明，client 声明决定浏览器半侧注入。
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.dsh?.bundle?.patch) ok('dsh.bundle.patch declared');
else fail('package.json missing dsh.bundle.patch');
if (pkg.dsh?.client?.platform === 'web') ok('dsh.client.web declared');
else fail('package.json missing dsh.client platform web');

// rolldown 在 target es2020 下会为「带初始化器的类字段」产出降级语法，
// 打包结果里就会多出 `import _defineProperty from "@oxc-project/runtime/helpers/defineProperty"`；
// 该包既不在 dependencies 也不随包发布，宿主加载插件树时会 ERR_MODULE_NOT_FOUND，整个 profile 起不来。
// 约定是类字段一律 declare 加构造器赋值，避免降级出外部 helper（见 src/host/helper-process.ts）。
const OXC_RUNTIME = '@oxc-project/runtime';
const oxcBundles = ['lib/index.js', 'lib/client.js'].filter((f) => {
  const p = join(ROOT, f);
  return existsSync(p) && readFileSync(p, 'utf8').includes(OXC_RUNTIME);
});
if (oxcBundles.length > 0)
  fail(
    `bundle imports undeclared helper ${OXC_RUNTIME} (${oxcBundles.join(', ')}) — ` +
      '类字段改用 declare + 构造器赋值（见 src/host/helper-process.ts 的约定）',
  );
else ok(`no undeclared ${OXC_RUNTIME} import in bundles`);

if (process.exitCode) console.error('\n[prepack-check] fix the failures above before publishing.');
else console.log('\n[prepack-check] all checks passed — ready to pack/publish.');
