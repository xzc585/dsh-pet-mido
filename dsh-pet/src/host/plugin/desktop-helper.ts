/**
 * 桌面 Helper 的组合根：把宠物列表、进程拉起、重启串行化三块拼成对外能力。
 *
 * 只做装配，不含逻辑；三块的分工见 ./desktop/ 下各自模块头。
 * 必须始终成立：requestRestart 是唯一的重启入口，内部串行且不重叠。
 * @module dsh-pet/src/host/plugin/desktop-helper
 */
import { createAttachHost } from './desktop/attach-host.ts';
import { createDesktopPets } from './desktop/pets.ts';
import { createDesktopSpawn } from './desktop/spawn.ts';
import { createDesktopSync } from './desktop/sync.ts';
import type { DesktopHelperDeps } from './desktop/types.ts';

export type { DesktopHelperDeps };

/**
 * 创建桌面 Helper 的全部能力。
 * @param deps - 装配期对象与桌面侧需要的动作函数。
 * @returns 启动、停止、请求重启与素材根解析。
 */
export function createDesktopHelper(deps: DesktopHelperDeps) {
  const pets = createDesktopPets(deps);
  const spawn = createDesktopSpawn({ ...deps, ...pets });
  const attach = createAttachHost({
    ...deps,
    ...pets,
    stopHelper: () => spawn.stopHelper('standalone-attached'),
  });
  const startHelper = (): void => {
    // 先开放本机接入服务并写入发现文件，独立入口才能连上；再决定要不要自己拉 Helper。
    attach.start();
    if (attach.hasLiveStandalone()) {
      deps.log.info(
        '[dsh-pet] 米豆独立入口已在桌面上运行，不再拉起第二只桌面宠物；宿主能力会交给那只已有的米豆',
      );
      return;
    }
    spawn.startHelper();
  };
  const stopHelper = (reason = 'settings-change'): void => {
    spawn.stopHelper(reason);
  };
  const markDisposed = (): void => {
    attach.stop();
    spawn.markDisposed();
  };
  const sync = createDesktopSync({ ...deps, ...pets, ...spawn, startHelper, stopHelperAndWait: spawn.stopHelperAndWait });
  return {
    startHelper,
    stopHelper,
    requestRestart: sync.requestRestart,
    assetRootFor: spawn.assetRootFor,
    userRootFor: spawn.userRootFor,
    markDisposed,
  };
}

/** 桌面 Helper 生命周期的产出（供下游工厂按需 Pick）。 */
export type DesktopHelper = ReturnType<typeof createDesktopHelper>;
