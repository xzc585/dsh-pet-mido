/**
 * 「系统内存清理」卡：看整机占用，调节自动清理，并可立刻清一次。
 *
 * 改动直接写给帮手（%APPDATA%/mido-ram-cleaner/config.json），不等页面底的「保存」。
 * 和「清理缓存」卡不是一回事：这边清的是系统 RAM，不是插件缓存。
 * @module dsh-pet/src/client/settings/system-memory-card
 */
import type { FunctionComponent } from 'react';
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit, numberInputProps } from './ui.ts';

/** 系统内存卡自己的输入：保存中时只禁用按钮，不挡住轮询。 */
export interface SystemMemoryCardProps {
  /** 宠物配置正在保存时禁用操作，避免设置页整体忙碌时误点。 */
  readonly busy: boolean;
}

interface SystemMemoryConfig {
  autoClean: boolean;
  intervalSec: number;
  thresholdPercent: number;
  debounceSec: number;
}

interface MemorySnap {
  totalBytes?: number;
  availableBytes?: number;
  usedBytes?: number;
  usedPercent?: number;
}

interface CleanReport {
  at?: string;
  standbyCleared?: boolean;
  before?: MemorySnap;
  after?: MemorySnap;
  error?: string;
}

interface SystemMemoryStatus extends MemorySnap {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  message?: string;
  isAdmin?: boolean;
  config?: SystemMemoryConfig;
  lastClean?: CleanReport;
}

const DEFAULT_CONFIG: SystemMemoryConfig = {
  autoClean: true,
  intervalSec: 1800,
  thresholdPercent: 85,
  debounceSec: 120,
};

async function requestSystemMemory(path: string, init?: RequestInit): Promise<SystemMemoryStatus> {
  const response = await fetch(ROUTE_PATH + path, {
    cache: 'no-store',
    ...init,
  });
  const body = (await response.json().catch(() => null)) as SystemMemoryStatus | null;
  if (!body) return { ok: false, available: false, message: 'cleanupFailed' };
  return body;
}

export async function fetchSystemMemoryStatus(): Promise<SystemMemoryStatus> {
  return requestSystemMemory('/system-memory');
}

export async function triggerSystemMemoryClean(): Promise<SystemMemoryStatus> {
  return requestSystemMemory('/system-memory', { method: 'POST' });
}

export async function triggerSystemMemoryCleanElevated(): Promise<SystemMemoryStatus> {
  return requestSystemMemory('/system-memory/clean-elevated', { method: 'POST' });
}

export async function saveSystemMemoryConfig(config: SystemMemoryConfig): Promise<SystemMemoryStatus> {
  return requestSystemMemory('/system-memory/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

/** 把字节数写成给用户看的容量，例如 8.2 GB。 */
export function formatMemoryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return (Math.round(gb * 10) / 10).toFixed(1).replace(/\.0$/, '') + ' GB';
  const mb = bytes / (1024 * 1024);
  return Math.max(0, Math.round(mb)) + ' MB';
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Math.round(value * 10) / 10);
}

/**
 * 造系统内存清理卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeSystemMemoryCard(rt: SettingsRuntime): FunctionComponent<SystemMemoryCardProps> {
  const { h, t, useEffect, useState } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });

  return function SystemMemoryCard(props: SystemMemoryCardProps) {
    const [status, setStatus] = useState<SystemMemoryStatus | null>(null);
    const [config, setConfig] = useState<SystemMemoryConfig>(DEFAULT_CONFIG);
    const [busyAction, setBusyAction] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });

    const applyStatus = (next: SystemMemoryStatus): void => {
      setStatus(next);
      if (next.config) setConfig(next.config);
    };

    const showFeedback = (next: SystemMemoryStatus, okText?: string): void => {
      if (next.message && next.ok !== false && next.available !== false) {
        setFeedback({ kind: 'ok', text: next.message });
        return;
      }
      if (next.ok === false || next.available === false) {
        const text =
          next.message && next.message !== 'cleanupFailed'
            ? next.message
            : next.reason === 'not-windows'
              ? t('systemMemoryNotWindows')
              : next.reason === 'helper-missing'
                ? t('systemMemoryMissing')
                : t('systemMemoryUnavailable');
        setFeedback({ kind: 'err', text });
        return;
      }
      if (okText) setFeedback({ kind: 'ok', text: okText });
    };

    useEffect(() => {
      let alive = true;
      const tick = (): void => {
        void fetchSystemMemoryStatus()
          .then((next) => {
            if (!alive) return;
            applyStatus(next);
          })
          .catch(() => undefined);
      };
      tick();
      const timer = setInterval(tick, 2000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, []);

    const patchConfig = (patch: Partial<SystemMemoryConfig>): void => {
      const previous = config;
      const next: SystemMemoryConfig = { ...config, ...patch };
      if (next.debounceSec > next.intervalSec) next.debounceSec = next.intervalSec;
      setConfig(next);
      setBusyAction(true);
      void (async () => {
        try {
          const result = await saveSystemMemoryConfig(next);
          applyStatus(result);
          showFeedback(result, t('systemMemorySaved'));
          if (result.ok === false && result.config) setConfig(result.config);
          else if (result.ok === false) setConfig(previous);
        } catch {
          setConfig(previous);
          setFeedback({ kind: 'err', text: t('systemMemorySaveFailed').replace('{error}', t('systemMemoryFailed')) });
        } finally {
          setBusyAction(false);
        }
      })();
    };

    const lastCleanText = (report: CleanReport | undefined): string => {
      if (!report || !report.before || !report.after) return '';
      return (report.standbyCleared ? t('systemMemoryLastCleanAdmin') : t('systemMemoryLastClean'))
        .replace('{before}', formatMemoryBytes(report.before.usedBytes ?? 0) + '（' + formatPercent(report.before.usedPercent) + '%）')
        .replace('{after}', formatMemoryBytes(report.after.usedBytes ?? 0) + '（' + formatPercent(report.after.usedPercent) + '%）');
    };

    const run = (action: () => Promise<SystemMemoryStatus>, okText?: string): void => {
      setBusyAction(true);
      setFeedback({ kind: '', text: '' });
      void (async () => {
        try {
          const result = await action();
          applyStatus(result);
          const done = lastCleanText(result.lastClean);
          showFeedback(result, okText || done || t('systemMemoryDone'));
        } catch {
          setFeedback({ kind: 'err', text: t('systemMemoryFailed') });
        } finally {
          setBusyAction(false);
        }
      })();
    };

    const unavailable = status != null && status.available === false;
    const disabled = props.busy || busyAction || unavailable;
    const used = status?.usedBytes;
    const total = status?.totalBytes;
    const avail = status?.availableBytes;
    const usageText =
      status == null
        ? t('systemMemoryHelperStarting')
        : unavailable
          ? status.reason === 'not-windows'
            ? t('systemMemoryNotWindows')
            : status.reason === 'helper-missing'
              ? t('systemMemoryMissing')
              : status.message || t('systemMemoryUnavailable')
          : t('systemMemoryUsageValue')
              .replace('{percent}', formatPercent(status.usedPercent))
              .replace('{used}', typeof used === 'number' ? formatMemoryBytes(used) : '—')
              .replace('{total}', typeof total === 'number' ? formatMemoryBytes(total) : '—')
              .replace('{avail}', typeof avail === 'number' ? formatMemoryBytes(avail) : '—');

    const lastText = lastCleanText(status?.lastClean);

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('systemMemoryTitle'), t('systemMemoryHint')),
        h('p', {
          className: 'dsh-pet-cfg__flabel',
          children: t('systemMemoryUsage') + '：' + usageText,
        }),
        lastText
          ? h('p', { className: 'dsh-pet-cfg__flabel', children: lastText })
          : null,
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            toggleCell('systemMemoryAuto', config.autoClean, disabled, (value) => patchConfig({ autoClean: value })),
            field(
              t('systemMemoryIntervalLabel'),
              h('input', numberInputProps(config.intervalSec, (value) => patchConfig({ intervalSec: Math.round(value) }), { min: 30, max: 86400, step: 1, disabled })),
              t('systemMemoryIntervalHint'),
            ),
            field(
              t('systemMemoryThresholdLabel'),
              h('input', numberInputProps(config.thresholdPercent, (value) => patchConfig({ thresholdPercent: Math.round(value) }), { min: 50, max: 99, step: 1, disabled })),
              t('systemMemoryThresholdHint'),
            ),
            field(
              t('systemMemoryDebounceLabel'),
              h('input', numberInputProps(config.debounceSec, (value) => patchConfig({ debounceSec: Math.round(value) }), { min: 10, step: 1, disabled })),
              t('systemMemoryDebounceHint'),
            ),
          ],
        }),
        h('div', {
          className: 'dsh-pet-cfg__row',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-pet-cfg__btn',
              disabled,
              onClick: () => run(triggerSystemMemoryClean),
              children: t('systemMemoryNow'),
            }),
            status?.isAdmin
              ? null
              : h('button', {
                  type: 'button',
                  className: 'dsh-pet-cfg__btn',
                  disabled,
                  title: t('systemMemoryElevatedHint'),
                  onClick: () => run(triggerSystemMemoryCleanElevated, t('systemMemoryElevatedSent')),
                  children: t('systemMemoryElevated'),
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
