/**
 * 窗口落位与上报：把「本体屏幕位置」换算成窗口矩形，把窗口管理器钳掉的那截转成本体偏移，再报给主进程。
 *
 * 四边都钳：贴顶时窗口停在 y=0，本体在窗口内下移，窗口上方那截余量正好留给气泡。
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * @module dsh-pet/runtime/electron-helper/sprite-window-fit
 */
'use strict';

const POPUP_EDGE_GAP = 8;
const MENU_WINDOW_SIZE = { width: 620, height: 480 };
const CHAT_WINDOW_SIZE = { width: 400, height: 440 };
const MEMORY_BADGE_MIN_WIDTH = 224;
const MEMORY_BADGE_VERTICAL_MARGIN = 40;

Object.assign(PetSprite.prototype, {
  /**
   * 越界允许量：命中区至少留 MIN_REACHABLE_PX 在屏幕内，其余部分可以挂到屏幕外。
   * 与网页端 clampReachableBox 同一条规则：宠物能挂出去，但右键永远点得到。
   * 上/下按「命中区的另一条边」留：挂在上方时留的是底边，挂在下方时留的是顶边。
   */
  reachInset() {
    const hit = this.hitRect;
    const keep = S.MIN_REACHABLE_PX;
    return {
      left: hit.x + hit.w - keep,
      right: this.size - hit.x - keep,
      top: hit.y + hit.h - keep,
      bottom: this.winH - hit.y - keep,
    };
  },

  /**
   * 算窗口落位并就地应用本体偏移；所有位移经 sendBounds 逐帧走到这里。
   *
   * @returns 窗口内容区（屏幕坐标系，CSS 像素）x/y/width/height 与本体在窗口内的偏移 offsetX/offsetY。
   */
  fitWindow() {
    const baseWidth = this.size + this.margin.l + this.margin.r;
    const baseHeight = this.winH + this.margin.t + this.margin.b;
    const popupOpen = this.menuOpen || this.chatOpen || this.todoOpen;
    // 系统窗口可以探出屏幕，操作面板打开时要让原生窗口留在本体所在的工作区。
    const area =
      CONFIG.isWindowClampedToWorkArea || popupOpen
        ? S.resolveRect(WORK_AREAS, this.pos.x + this.halfW, this.pos.y + this.halfH)
        : undefined;
    let width = baseWidth;
    let height = baseHeight;
    let insetY = this.margin.t;
    if (this.memoryBadge) {
      // Keep enough transparent room for a readable badge even on a tiny sprite at the screen edge.
      width = Math.max(width, MEMORY_BADGE_MIN_WIDTH);
      insetY = Math.max(insetY, MEMORY_BADGE_VERTICAL_MARGIN);
      height = this.winH + insetY + Math.max(this.margin.b, MEMORY_BADGE_VERTICAL_MARGIN);
    }
    if (this.menuOpen) {
      width = Math.max(width, MENU_WINDOW_SIZE.width);
      height = Math.max(height, MENU_WINDOW_SIZE.height);
    }
    if (this.chatOpen) {
      width = Math.max(width, CHAT_WINDOW_SIZE.width);
      height = Math.max(height, CHAT_WINDOW_SIZE.height);
    }
    if (this.todoOpen) {
      const topMargin = S.todoPanelTopMarginPx(this.font, this.size);
      const panelHeight = topMargin + this.size * S.BUBBLE_OVERLAP_RATIO;
      width = Math.max(width, S.todoPanelWidthPx(this.font, this.size) + 2 * POPUP_EDGE_GAP);
      height = Math.max(height, this.winH + panelHeight + 3 * POPUP_EDGE_GAP);
      insetY = Math.max(insetY, topMargin + POPUP_EDGE_GAP);
    }
    if (popupOpen && area) {
      width = Math.min(Math.ceil(width), area.width);
      height = Math.min(Math.ceil(height), area.height);
    }
    this.windowLayout = { width, height };
    const fit = S.fitWindowInArea({
      bodyX: this.pos.x,
      bodyY: this.pos.y,
      width,
      height,
      bodyWidth: this.size,
      // 纵向是「精灵总高」（含脚底透明垫），不是视频高：偏移上限按精灵算才对得上窗口尺寸
      bodyHeight: this.winH,
      insetX: this.margin.l + (width - baseWidth) / 2,
      insetY,
      reach: this.reachInset(),
      area,
    });
    this.applyWinOffset(fit.offsetX, fit.offsetY);
    return { x: fit.x, y: fit.y, width, height, offsetX: fit.offsetX, offsetY: fit.offsetY };
  },

  refreshPopupBounds() {
    if (!this.ac?.signal.aborted) this.sendBounds(this.pos.x, this.pos.y);
  },

  /** 待办优先贴在头顶，贴屏幕顶边时放到本体下方。内容高度变动后重新落位。 */
  layoutTodoPopup() {
    if (!this.todoOpen) return;
    const area = this.visibleClampRect();
    if (!area) return;
    const bubble = this.bubble;
    const gap = POPUP_EDGE_GAP;
    bubble.style.setProperty('--desktop-todo-max-width', Math.max(1, area.w - 2 * gap) + 'px');
    bubble.style.setProperty('--dsh-pet-todo-max-height', Math.max(1, area.h - 2 * gap) + 'px');
    const { width, height } = bubble.getBoundingClientRect();
    const center = this.winOffset.x + this.halfW;
    const left = Math.max(area.x + gap, Math.min(center - width / 2, area.x + area.w - width - gap));
    const above = this.winOffset.y + this.size * S.BUBBLE_OVERLAP_RATIO - height;
    const below = this.winOffset.y + this.winH + gap;
    const minTop = area.y + gap;
    const maxTop = Math.max(minTop, area.y + area.h - height - gap);
    const useBelow = above < minTop && below <= maxTop;
    const top = useBelow ? Math.max(minTop, below) : Math.max(minTop, Math.min(above, maxTop));
    bubble.style.setProperty('--desktop-todo-left', left - this.winOffset.x + 'px');
    bubble.style.setProperty('--desktop-todo-top', top - this.winOffset.y + 'px');
    bubble.style.setProperty('--desktop-todo-tail-x', Math.max(gap, Math.min(center - left, width - gap)) + 'px');
    bubble.classList.toggle('is-below-pet', useBelow);
    bubble.classList.toggle('is-over-pet', !useBelow && above < minTop);
  },

  /** 本体在窗口内的偏移落到 DOM；逐帧调用，值没变就不写样式。 */
  applyWinOffset(x, y) {
    if (this.winOffset.x === x && this.winOffset.y === y) return;
    this.winOffset.x = x;
    this.winOffset.y = y;
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
    window.__dshPetDebug.winOffset = { x, y };
  },

  /**
   * 把窗口落位连同宠物状态报给主进程：命中区判定与跨窗碰撞站场都读这一份。
   *
   * @param fit - fitWindow 的返回值。
   */
  reportWindow(fit) {
    if (!window.petBridge) return;
    // 完整状态一次捎带：size/bottomPad 让静止宠物从首帧起就登记进碰撞站场；
    // vx/vy 带当前速度（飞行中实时值、静止/拖拽 = 0），避免落地后残留旧速度干扰碰撞动量。
    const fly = this.throwState;
    window.petBridge.setBounds(
      toScreen(fit.x + VIEW.x),
      toScreen(fit.y + VIEW.y),
      toScreen(fit.width),
      toScreen(fit.height),
      toScreen(this.pos.x), // 包围盒左上角（碰撞站场用：窗口坐标 ≠ 包围盒坐标）
      toScreen(this.pos.y),
      toScreen(this.size),
      toScreen(this.bottomPad),
      fly ? toScreen(fly.vx) : 0,
      fly ? toScreen(fly.vy) : 0,
      // 窗口原点到本体原点的距离（DIP）：主进程据此算命中区，它不再恒等于余量——窗口被钳后
      // 偏移变大，只能按上报值算，不能按「窗口宽/4」反推（见 spriteHitRect）。
      toScreen(fit.offsetX),
      toScreen(fit.offsetY),
    );
  },
});
