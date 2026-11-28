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

/** 系统内存卡自己的输入。 */
export interface SystemMemoryCardProps {
  /** 宠物配置正在保存时禁用操作，避免设置页整体忙碌时误点。 */
  readonly busy: boolean;
}

interface SystemMemoryConfig {
  autoClean: boolean;
  intervalSec: number;
  thresholdPercent: number;
  debounceSec: number;
  showUsage: boolean;
  notifyOnClean: boolean;
}

interface MemorySnap {
  totalBytes?: number;
  availableBytes?: number;
  usedBytes?: number;
  usedPercent?: number;
}

interface CleanReport {
  at?: string;
  trigger?: 'auto' | 'manual' | 'elevated';
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
  config?: Partial<SystemMemoryConfig>;
  lastClean?: CleanReport;
}

const DEFAULT_CONFIG: SystemMemoryConfig = {
  autoClean: true,
  intervalSec: 1800,
  thresholdPercent: 85,
  debounceSec: 120,
  showUsage: true,
  notifyOnClean: false,
};

const CLEAN_TRIGGER_KEYS = {
  auto: 'systemMemoryCleanAuto',
  manual: 'systemMemoryCleanManual',
  elevated: 'systemMemoryCleanElevated',
} as const;

async function requestSystemMemory(path: string, init?: RequestInit): Promise<SystemMemoryStatus> {
  const response = await fetch(ROUTE_PATH + path, {
    cache: 'no-store',
    ...init,
  });
  const body = (await response.json().catch(() => null)) as SystemMemoryStatus | null;
  if (!body) return { ok: false, available: false, message: 'cleanupFailed' };
  return response.ok ? body : { ...body, ok: false };
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

function formatMemoryReading(snapshot: MemorySnap): string {
  const used = formatMemoryBytes(snapshot.usedBytes ?? NaN);
  const percent = formatPercent(snapshot.usedPercent);
  if (percent === '—') return used;
  return used === '—' ? percent + '%' : `${used} (${percent}%)`;
}

function failed(status: SystemMemoryStatus): boolean {
  return status.ok === false || status.available === false;
}

/**
 * 造系统内存清理卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeSystemMemoryCard(rt: SettingsRuntime): FunctionComponent<SystemMemoryCardProps> {
  const { h, t, useEffect, useRef, useState } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });

  return function SystemMemoryCard(props: SystemMemoryCardProps) {
    const [status, setStatus] = useState<SystemMemoryStatus | null>(null);
    const [config, setConfig] = useState<SystemMemoryConfig>(DEFAULT_CONFIG);
    const [busyAction, setBusyAction] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    const operation = useRef({ generation: 0, busy: false });

    const applyStatus = (next: SystemMemoryStatus): void => {
      setStatus(next);
      if (next.config) setConfig({ ...DEFAULT_CONFIG, ...next.config });
    };

    const showFeedback = (next: SystemMemoryStatus, okText?: string): void => {
      if (next.message && !failed(next)) {
        setFeedback({ kind: 'ok', text: next.message });
        return;
      }
      if (failed(next)) {
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
      let polling = false;
      const tick = (): void => {
        if (operation.current.busy || polling) return;
        polling = true;
        const generation = operation.current.generation;
        const current = (): boolean => alive && generation === operation.current.generation;
        void fetchSystemMemoryStatus()
          .then((next) => {
            if (current()) applyStatus(next);
          })
          .catch(() => {
            if (current()) applyStatus({ ok: false, available: false });
          })
          .finally(() => {
            polling = false;
          });
      };
      tick();
      const timer = setInterval(tick, 2000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, []);

    const disabled = props.busy || busyAction || status == null || status.available === false;
    const beginOperation = (): boolean => {
      if (disabled || operation.current.busy) return false;
      // Retire every poll started before this action, even if it returns after the save finishes.
      operation.current.generation++;
      operation.current.busy = true;
      setBusyAction(true);
      setFeedback({ kind: '', text: '' });
      return true;
    };

    const endOperation = (): void => {
      operation.current.busy = false;
      setBusyAction(false);
    };

    const patchConfig = (patch: Partial<SystemMemoryConfig>): void => {
      if (!beginOperation()) return;
      const previous = config;
      const next: SystemMemoryConfig = { ...config, ...patch };
      if (next.debounceSec > next.intervalSec) next.debounceSec = next.intervalSec;
      setConfig(next);
      void (async () => {
        try {
          const result = await saveSystemMemoryConfig(next);
          if (failed(result)) setConfig(result.config ? { ...DEFAULT_CONFIG, ...result.config } : previous);
          else applyStatus(result);
          showFeedback(result, t('systemMemorySaved'));
        } catch {
          setConfig(previous);
          setFeedback({ kind: 'err', text: t('systemMemorySaveFailed').replace('{error}', t('systemMemoryFailed')) });
        } finally {
          endOperation();
        }
      })();
    };

    const lastCleanText = (report: CleanReport | undefined): string => {
      if (!report || !report.before || !report.after) return '';
      return (report.standbyCleared ? t('systemMemoryLastCleanAdmin') : t('systemMemoryLastClean'))
        .replace('{before}', formatMemoryReading(report.before))
        .replace('{after}', formatMemoryReading(report.after));
    };

    const run = (action: () => Promise<SystemMemoryStatus>, okText?: string): void => {
      if (!beginOperation()) return;
      void (async () => {
        try {
          const result = await action();
          if (!failed(result) || result.lastClean) applyStatus(result);
          const cleanError = !okText && result.lastClean?.error;
          showFeedback(
            cleanError ? { ...result, ok: false, message: cleanError } : result,
            okText || t('systemMemoryDone'),
          );
        } catch {
          setFeedback({ kind: 'err', text: t('systemMemoryFailed') });
        } finally {
          endOperation();
        }
      })();
    };

    const unavailable = status != null && status.available === false;
    const used = status?.usedBytes;
    const total = status?.totalBytes;
    const avail = status?.availableBytes;
    const helperText =
      status == null
        ? t('systemMemoryHelperStarting')
        : unavailable
          ? status.reason === 'not-windows'
            ? t('systemMemoryNotWindows')
            : status.reason === 'helper-missing'
              ? t('systemMemoryMissing')
              : status.message || t('systemMemoryUnavailable')
          : '';
    const usageText =
      status && !unavailable && config.showUsage
        ? t('systemMemoryUsage') +
          '：' +
          t('systemMemoryUsageValue')
            .replace('{percent}', formatPercent(status.usedPercent))
            .replace('{used}', formatMemoryBytes(used ?? NaN))
            .replace('{total}', formatMemoryBytes(total ?? NaN))
            .replace('{avail}', formatMemoryBytes(avail ?? NaN))
        : '';

    const lastClean = status?.lastClean;
    const lastText = lastCleanText(lastClean);
    const triggerKey = lastClean?.trigger && CLEAN_TRIGGER_KEYS[lastClean.trigger];
    const details = [triggerKey && t(triggerKey), lastText, lastClean?.error].filter(Boolean).join(' · ');
    const at = new Date(lastClean?.at ?? '');
    const timestamp = Number.isFinite(at.getTime())
      ? h('time', { key: 'time', dateTime: at.toISOString(), children: at.toLocaleString() })
      : null;

    return h('div', {
      className: 'dsh-pet-cfg__card',
      'aria-busy': busyAction,
      children: [
        cardHead(t('systemMemoryTitle'), t('systemMemoryHint')),
        helperText || usageText
          ? h('p', { className: 'dsh-pet-cfg__flabel', children: helperText || usageText })
          : null,
        timestamp || details
          ? h('p', {
              className: 'dsh-pet-cfg__flabel',
              children: [
                t('systemMemoryLastCleanHeading') + '：',
                timestamp,
                timestamp && details ? ' · ' : '',
                details,
              ],
            })
          : null,
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            toggleCell('systemMemoryShowUsage', config.showUsage, disabled, (value) =>
              patchConfig({ showUsage: value }),
            ),
            toggleCell('systemMemoryNotifyOnClean', config.notifyOnClean, disabled, (value) =>
              patchConfig({ notifyOnClean: value }),
            ),
            toggleCell('systemMemoryAuto', config.autoClean, disabled, (value) => patchConfig({ autoClean: value })),
            field(
              t('systemMemoryIntervalLabel'),
              h(
                'input',
                numberInputProps(config.intervalSec, (value) => patchConfig({ intervalSec: Math.round(value) }), {
                  min: 30,
                  max: 86400,
                  step: 1,
                  disabled,
                }),
              ),
              t('systemMemoryIntervalHint'),
            ),
            field(
              t('systemMemoryThresholdLabel'),
              h(
                'input',
                numberInputProps(
                  config.thresholdPercent,
                  (value) => patchConfig({ thresholdPercent: Math.round(value) }),
                  { min: 50, max: 99, step: 1, disabled },
                ),
              ),
              t('systemMemoryThresholdHint'),
            ),
            field(
              t('systemMemoryDebounceLabel'),
              h(
                'input',
                numberInputProps(config.debounceSec, (value) => patchConfig({ debounceSec: Math.round(value) }), {
                  min: 10,
                  step: 1,
                  disabled,
                }),
              ),
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
                  role: 'status',
                  children: feedback.text,
                })
              : null,
          ],
        }),
      ],
    });
  };
}
