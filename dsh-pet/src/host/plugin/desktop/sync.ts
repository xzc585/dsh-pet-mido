/**
 * 桌面侧重启：一批连续配置写入合成一次重启，重启期间的新写入排到下一批。
 *
 * 两种形态走同一条入口：双进程（插件 / 独立模式）重启子进程；单进程（打包应用）没有
 * 子进程可重启，改让内嵌 helper 按新配置重建窗口。
 * 不自己停拉进程（归 ./spawn），不重算配置（归 ./pets）。
 * 依赖显式传入（见输入类型），模块内只读一个进程级事实：DSH_PET_IN_PROCESS。
 * @module dsh-pet/src/host/plugin/desktop/sync
 */
import type { DesktopHelperDeps } from './types.ts';
import type { DesktopPets } from './pets.ts';
import type { DesktopSpawn } from './spawn.ts';

/** DesktopSync的输入。 */
export type DesktopSyncInput = { log: Pick<DesktopHelperDeps['log'], 'warn'> } & Pick<
  DesktopPets,
  'logDesktopDecision' | 'desktopPetList'
> &
  Pick<DesktopSpawn, 'startHelper' | 'stopHelperAndWait'>;

/** 应用模式下由内嵌 helper 注册的重建钩子；双进程模式下不存在。 */
type RebuildHook = (() => Promise<void>) | undefined;
const SAVE_BURST_DELAY_MS = 200;

interface PendingRestart {
  done: Promise<void>;
  resolve: () => void;
}

/**
 * 创建DesktopSync。
 */
export function createDesktopSync(deps: DesktopSyncInput) {
  const { log, logDesktopDecision, desktopPetList, startHelper, stopHelperAndWait } = deps;

  /** 同进程内跑 helper（打包应用）：没有子进程可重启，只能让 helper 自己重建窗口。 */
  const inProcessHost = process.env.DSH_PET_IN_PROCESS === '1';

  let pending: PendingRestart | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restarting = false;
  let disposed = false;

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_BURST_DELAY_MS);
  }

  async function flush(): Promise<void> {
    timer = undefined;
    const batch = pending;
    if (!batch || disposed) return;
    pending = undefined;
    restarting = true;
    try {
      logDesktopDecision();
      if (inProcessHost) {
        // 已接入 DSH 时，窗口由宿主配置驱动，本机设置只保存到本机。
        if (process.env.DSH_PET_DSH_CONNECTED === '1') return;
        process.env.DSH_PET_PETS = JSON.stringify(desktopPetList());
        await (globalThis as { __dshPetRebuildUi?: RebuildHook }).__dshPetRebuildUi?.();
      } else {
        await stopHelperAndWait('desktop-config-change');
        if (!disposed) startHelper();
      }
    } catch (e) {
      log.warn(`[dsh-pet] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      restarting = false;
      batch.resolve();
      if (pending && !disposed) schedule();
    }
  }

  function requestRestart(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!pending) {
      let resolve!: () => void;
      const done = new Promise<void>((finish) => {
        resolve = finish;
      });
      pending = { done, resolve };
    }
    if (!restarting) schedule();
    return pending.done;
  }

  function dispose(): void {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending?.resolve();
    pending = undefined;
  }

  return { requestRestart, dispose };
}

/** DesktopSync的产出。 */
export type DesktopSync = ReturnType<typeof createDesktopSync>;
