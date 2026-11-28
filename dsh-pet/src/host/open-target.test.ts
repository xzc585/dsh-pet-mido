/**
 * 三种宿主形态的菜单首项。用模拟 Electron IPC 与真实渲染脚本验证打开行为。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { localSession } from '../app/dsh-connect.ts';
import { resolveOpenTarget } from './plugin/desktop/spawn.ts';

const readRuntime = (name: string) =>
  readFileSync(new URL('../../runtime/electron-helper/' + name, import.meta.url), 'utf8');

test('区分 Electron 宿主、独立设置页和 web 站点', () => {
  const settings = 'http://127.0.0.1:31380/standalone-ai/#token=test-only';
  const site = 'http://127.0.0.1:3080/#token=test-only';
  assert.equal(resolveOpenTarget(settings, true), 'desktop');
  assert.equal(resolveOpenTarget(site, true), 'desktop');
  assert.equal(resolveOpenTarget(settings, false), 'standalone');
  assert.equal(resolveOpenTarget(site, false), 'web');
  assert.equal(
    localSession({
      localOrigin: () => 'http://127.0.0.1:31380',
      localToken: () => 'test',
      localSiteUrl: () => settings,
    }).openTarget,
    'standalone',
  );
});

type Handler = (event: unknown, payload: { url: string }) => void;

function ipcHarness(openTarget: string, options: { failDesktop?: boolean; authed?: string } = {}) {
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  const env = { DSH_PET_OPEN_TARGET: '', DSH_PET_SITE_URL: options.authed ?? '' };
  const module = { exports: {} } as { exports: { registerIpc(deps: unknown): void } };
  runInNewContext(readRuntime('main/ipc.js'), {
    module,
    require: () => ({}),
    process: { env },
    URL,
    console: { error() {} },
  });
  module.exports.registerIpc({
    ipcMain: { on: (name: string, callback: Handler) => handlers.set(name, callback), handle() {} },
    openTarget,
    shell: {
      async openExternal(url: string) {
        calls.push(url);
        if (options.failDesktop && url === 'dsh://open') throw new Error('protocol not registered');
      },
    },
  });
  return {
    env,
    calls,
    open: async (url: string) => {
      handlers.get('pet:open-site')?.({}, { url });
      await Promise.resolve();
    },
  };
}

test('桌面宿主走 dsh://，协议失败时回落到已鉴权站点', async () => {
  const origin = 'http://127.0.0.1:3080/';
  const success = ipcHarness('desktop');
  await success.open(origin);
  assert.deepEqual(success.calls, ['dsh://open']);
  const failure = ipcHarness('desktop', { failDesktop: true, authed: origin + '#token=test-only' });
  await failure.open(origin);
  assert.deepEqual(failure.calls, ['dsh://open', origin + '#token=test-only']);
});

test('切换到独立模式后，当前去向会覆盖启动时的桌面宿主', async () => {
  const settings = 'http://127.0.0.1:31380/standalone-ai/';
  const harness = ipcHarness('desktop', { authed: settings + '#token=test-only' });
  harness.env.DSH_PET_OPEN_TARGET = 'standalone';
  await harness.open(settings);
  assert.deepEqual(harness.calls, [settings + '#token=test-only']);
});

test('web 形态只打开站点，同源站点才使用鉴权链接', async () => {
  const harness = ipcHarness('web', { authed: 'http://127.0.0.1:31380/#token=test-only' });
  await harness.open('http://127.0.0.1:3080/');
  assert.deepEqual(harness.calls, ['http://127.0.0.1:3080/']);
});

test('渲染端从窗口参数决定三种文案，缺参数默认打开网站', () => {
  const source = readRuntime('constants.js') + '\n' + readRuntime('sprite/menu.js');
  const cases = [
    ['?openTarget=desktop', '打开软件'],
    ['?openTarget=standalone', '打开 AI 设置'],
    ['?openTarget=web', '打开网站'],
    ['', '打开网站'],
  ];
  for (const [search, expected] of cases) {
    let firstItem: { label: string; action: string } | undefined;
    let menuPoint: { x: number; y: number } | undefined;
    class PetSprite {
      dragState = {};
      animations = {};
      winOffset = { x: 16, y: 32 };
      refreshPopupBounds() {
        this.winOffset = { x: 48, y: 64 };
      }
      stopThrow() {}
      stopMove() {}
      setInteractive() {}
      syncInputBusy() {}
      visibleClampRect() {}
      syncInputRegions() {}
      declare onContextMenu: (event: unknown) => void;
    }
    runInNewContext(source, {
      PetSprite,
      URL,
      URLSearchParams,
      location: { search },
      document: { getElementById() {} },
      OPEN_SHORTCUT_HINT: 'Ctrl+左键',
      window: {
        addEventListener() {},
        PetShared: {
          translateRects: (rects: unknown) => rects,
          buildMemeBranch() {},
          buildMoreBranch() {},
          buildMenuTree: () => [],
          displayMenuBranch: () => ({}),
          mountContextMenu: ({
            tree,
            x,
            y,
          }: {
            tree: Array<{ label: string; action: string }>;
            x: number;
            y: number;
          }) => {
            firstItem = tree[0];
            menuPoint = { x, y };
            return { close() {} };
          },
        },
      },
    });
    new PetSprite().onContextMenu({ clientX: 20, clientY: 36, preventDefault() {} });
    assert.equal(firstItem?.label, expected);
    assert.equal(firstItem?.action, 'open-site');
    assert.deepEqual(menuPoint, { x: 52, y: 68 }, '扩窗后保持原鼠标落点');
  }
});
