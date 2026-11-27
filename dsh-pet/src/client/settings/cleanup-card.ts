/**
 * 「清理内存」卡：定时、阈值、防抖，外加一个立刻清的按钮。
 *
 * 管的是动画缓存和进程占用，不是「长期记忆」那张卡。
 * 三个数字随「保存」整包写入；「立即清理」直接打宿主，不等保存。
 * @module dsh-pet/src/client/settings/cleanup-card
 */
import type { FunctionComponent } from 'react';
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit, numberInputProps } from './ui.ts';

/** 清理卡的输入。 */
export interface CleanupCardProps {
  /** 保存中或配置未就绪时禁用。 */
  readonly busy: boolean;
  readonly enabled: boolean;
  readonly intervalSec: number;
  readonly thresholdMb: number;
  readonly debounceSec: number;
  readonly onEnabled: (value: boolean) => void;
  readonly onInterval: (value: number) => void;
  readonly onThreshold: (value: number) => void;
  readonly onDebounce: (value: number) => void;
}

/**
 * 让宿主立刻清一次。用的是已经保存的配置时钟，不把表单草稿传过去。
 *
 * @returns 给人看的一句结果；失败时 ok 为 false。
 */
export async function triggerMemoryCleanup(): Promise<{ ok: boolean; text: string }> {
  try {
    const response = await fetch(ROUTE_PATH + '/memory-cleanup', { method: 'POST' });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; freedBytes?: unknown; reason?: unknown } | null;
    if (!response.ok || !body || body.ok === false) return { ok: false, text: 'cleanupFailed' };
    const freed = typeof body.freedBytes === 'number' ? body.freedBytes : 0;
    return { ok: true, text: String(freed) };
  } catch {
    return { ok: false, text: 'cleanupFailed' };
  }
}

/**
 * 造清理内存卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeCleanupCard(rt: SettingsRuntime): FunctionComponent<CleanupCardProps> {
  const { h, t, useState } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });

  return function CleanupCard(props: CleanupCardProps) {
    const [cleaning, setCleaning] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });

    const cleanNow = (): void => {
      setCleaning(true);
      setFeedback({ kind: '', text: '' });
      void (async () => {
        try {
          const result = await triggerMemoryCleanup();
          if (!result.ok) {
            setFeedback({ kind: 'err', text: t('cleanupFailed') });
            return;
          }
          setFeedback({ kind: 'ok', text: t('cleanupDone').replace('{bytes}', result.text) });
        } finally {
          setCleaning(false);
        }
      })();
    };

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('cleanupTitle'), t('cleanupHint')),
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            toggleCell('cleanupEnabled', props.enabled, props.busy, props.onEnabled),
            field(
              t('cleanupIntervalLabel'),
              h('input', numberInputProps(props.intervalSec, props.onInterval, { min: 1, step: 1, disabled: props.busy })),
              t('cleanupIntervalHint'),
            ),
            field(
              t('cleanupThresholdLabel'),
              h('input', numberInputProps(props.thresholdMb, props.onThreshold, { min: 1, step: 1, disabled: props.busy })),
              t('cleanupThresholdHint'),
            ),
            field(
              t('cleanupDebounceLabel'),
              h('input', numberInputProps(props.debounceSec, props.onDebounce, { min: 1, step: 1, disabled: props.busy })),
              t('cleanupDebounceHint'),
            ),
          ],
        }),
        h('div', {
          className: 'dsh-pet-cfg__row',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-pet-cfg__btn',
              disabled: props.busy || cleaning,
              onClick: cleanNow,
              children: t('cleanupNow'),
            }),
            feedback.text
              ? h('span', {
                  className: 'dsh-pet-cfg__msg' + (feedback.kind === 'err' ? ' is-err' : ''),
                  children: feedback.text,
                })
              : null,
          ],
        }),
      ],
    });
  };
}
