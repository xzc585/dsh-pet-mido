/**
 * 待办面板的气泡外壳：把共享面板塞进气泡槽，显隐与优先级都由槽位决定。
 * 处理浏览器浮层定位，面板本体与数据在 shared/todo/panel。
 * @module dsh-pet/src/client/todo-bubble
 */
import { createTodoPanel } from '../shared/todo/panel.ts';
import { BUBBLE_OVERLAP_RATIO } from '../shared/fonts.ts';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

const VIEWPORT_GAP = 8;

function followPet(host: HTMLDivElement, pet: HTMLElement): () => void {
  const place = (): void => {
    const { clientWidth: width, clientHeight: height } = document.documentElement;
    host.style.maxWidth = Math.max(0, width - 2 * VIEWPORT_GAP) + 'px';
    host.style.setProperty('--dsh-pet-todo-max-height', Math.max(0, height - 2 * VIEWPORT_GAP) + 'px');

    const anchor = pet.getBoundingClientRect();
    const panel = host.getBoundingClientRect();
    const center = anchor.left + anchor.width / 2;
    const left = Math.max(VIEWPORT_GAP, Math.min(center - panel.width / 2, width - panel.width - VIEWPORT_GAP));
    const above = anchor.top + anchor.width * BUBBLE_OVERLAP_RATIO - panel.height;
    const below = anchor.bottom + VIEWPORT_GAP;
    const preferredTop = above >= VIEWPORT_GAP ? above : below;
    const top = Math.max(VIEWPORT_GAP, Math.min(preferredTop, height - panel.height - VIEWPORT_GAP));

    // 浮层仍在宠物节点内，视口落点要换算回父节点的局部坐标。
    host.style.left = left - anchor.left + 'px';
    host.style.top = top - anchor.top + 'px';
    host.dataset.side = top === above ? 'above' : top === below ? 'below' : 'overlap';
    const tail = Math.max(VIEWPORT_GAP, Math.min(center - left, panel.width - VIEWPORT_GAP));
    host.style.setProperty('--dsh-pet-todo-tail-x', tail + 'px');
  };

  let frame = 0;
  const schedule = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  };
  const movement = new MutationObserver(schedule);
  movement.observe(pet, { attributes: true, attributeFilter: ['style', 'data-corner'] });
  const resize = new ResizeObserver(schedule);
  resize.observe(host);
  resize.observe(pet);
  window.addEventListener('resize', schedule);
  place();
  return () => {
    movement.disconnect();
    resize.disconnect();
    window.removeEventListener('resize', schedule);
    if (frame) window.cancelAnimationFrame(frame);
  };
}

/** 注入的 react 能力。 */
export interface TodoBubbleRuntime {
  /** 创建元素。 */
  h: typeof jsx;
  /** 引用。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  /** 副作用；面板挂载一次，卸载时 dispose。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}

/** 面板气泡的 props。 */
export interface TodoBubbleProps {
  /** 是否显示；槽位为 `todo` 时为真。 */
  on: boolean;
  /** 点面板关闭按钮时回调，由槽位收起。 */
  onClose: () => void;
}

/**
 * 制造待办面板气泡组件（工厂）。
 *
 * @param rt - 注入的 react 能力。
 * @returns 待办面板的气泡组件。
 */
export function makeTodoBubble(rt: TodoBubbleRuntime) {
  const { h, useRef, useEffect } = rt;

  return function TodoBubble({ on, onClose }: TodoBubbleProps) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    // 回调存 ref：面板只在挂载时拿一次 onClose，直接闭包会捕获旧的那份。
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEffect(() => {
      const host = hostRef.current;
      if (host === null) return;
      const panel = createTodoPanel({
        onClose: () => closeRef.current(),
        // 点宠物本体不收起：拖它走是常见需求，收起就没法一边看清单一边挪位置。
        keepOpenOn: (target) => target instanceof Element && target.closest('.dsh-pet-hit') !== null,
      });
      host.appendChild(panel.el);
      return () => panel.dispose();
    }, []);

    useEffect(() => {
      const host = hostRef.current;
      const pet = host?.parentElement;
      if (!on || !host || !pet) return undefined;
      return followPet(host, pet);
    }, [on]);

    return h('div', {
      ref: hostRef,
      className: 'dsh-pet-bubble dsh-pet-todo-bubble' + (on ? ' is-on' : ''),
      style: { bottom: 'auto', minWidth: 0, transform: 'none' },
    });
  };
}
