/**
 * 独立模式设置页「清理内存」卡的契约测试。
 *
 * 与「长期记忆」卡分开：缺段时用内置默认并随保存提交；手动按钮打 POST /memory-cleanup。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { POWERCONTEXT_MEMORY_ID } from '../../shared/memory.ts';
import { coreScript } from './script/core.ts';
import { globalsScript } from './script/globals.ts';
import { overlayScript } from './script/overlay.ts';
import { petsScript } from './script/pets.ts';
import { widgetsScript } from './script/widgets.ts';

interface FakeNode {
  nodeType: number;
  attrs: Record<string, string>;
  children: FakeNode[];
  hidden?: boolean;
  type?: string;
  checked?: boolean;
  value?: string;
  className?: string;
  textContent?: string;
  disabled?: boolean;
  append(...kids: FakeNode[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, fn: () => void): void;
  readonly firstElementChild: FakeNode | undefined;
}

interface Probe {
  state: {
    globals: { memoryCleanup: { enabled: boolean; intervalSec: number; thresholdMb: number; debounceSec: number } };
  };
  initDrafts(config: Record<string, unknown>): void;
  cleanupCard(): FakeNode;
  petsBody(): Record<string, unknown>;
}

function probe(): Probe {
  const listeners = new Map<FakeNode, Array<() => void>>();
  const node = (): FakeNode => ({
    nodeType: 1,
    attrs: {},
    children: [],
    value: '',
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener(_name, fn) {
      const list = listeners.get(this) ?? [];
      list.push(fn);
      listeners.set(this, list);
    },
    append(...kids) {
      this.children.push(...kids);
    },
    get firstElementChild() {
      return this.children.find((kid) => kid && kid.nodeType === 1);
    },
  });
  const document = {
    createElement: node,
    createElementNS: node,
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const script = [
    coreScript('/dsh-pet-7340', {
      voices: [],
      defaultVoice: 'edge/zh-CN-XiaoyiNeural',
      fonts: [],
      displays: [],
      corners: [],
      physics: {},
      font: {},
      weights: { idle: 10, turn: 5, move: 5 },
      powerContextProviderId: POWERCONTEXT_MEMORY_ID,
    }),
    widgetsScript(),
    overlayScript(),
    globalsScript(),
    petsScript(),
    'globalThis.__probe = { state, initDrafts, cleanupCard, petsBody };',
  ].join('\n');
  const context: Record<string, unknown> = {
    document,
    location: { hash: '' },
    history: { replaceState() {} },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
  };
  runInNewContext(script, context);
  return (context as unknown as { __probe: Probe }).__probe;
}

/** vm 沙箱里的对象与测试进程不共享原型，deepEqual 会误报。 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function walk(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
  out.push(node);
  for (const kid of node.children) if (kid && kid.nodeType === 1) walk(kid, out);
  return out;
}

describe('独立模式清理内存', () => {
  test('成品里没有这一段 → 草稿用内置默认，保存时会带上', () => {
    const page = probe();
    page.initDrafts({ main: { pets: [] } });
    assert.deepEqual(plain(page.state.globals.memoryCleanup), {
      enabled: true,
      intervalSec: 1800,
      thresholdMb: 512,
      debounceSec: 120,
    });
    const body = page.petsBody();
    assert.deepEqual(plain(body.memoryCleanup), plain(page.state.globals.memoryCleanup));
  });

  test('成品里写了 → 原样读进草稿', () => {
    const page = probe();
    const cleanup = { enabled: false, intervalSec: 60, thresholdMb: 64, debounceSec: 15 };
    page.initDrafts({ main: { pets: [], memoryCleanup: cleanup } });
    assert.deepEqual(plain(page.state.globals.memoryCleanup), cleanup);
    const card = page.cleanupCard();
    const titles = walk(card)
      .map((item) => item.textContent)
      .filter((text): text is string => Boolean(text));
    assert.ok(titles.some((text) => text.includes('清理内存')));
    assert.ok(titles.some((text) => text.includes('立即清理')));
    assert.ok(
      titles.every((text) => !text.includes('长期记忆') || text.includes('不是一回事')),
      '文案不应和长期记忆卡混在一起',
    );
  });
});
