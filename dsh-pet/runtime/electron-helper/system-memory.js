/** Renderer-scoped system memory polling and the passive badge on each sprite. */
'use strict';

const SYSTEM_MEMORY_REFRESH_MS = 4000;
const SYSTEM_MEMORY_TIMEOUT_MS = 5000;
const MEMORY_USAGE_GAP = 5;

function startSystemMemoryPolling() {
  const lifetime = new AbortController();
  let timer;
  window.addEventListener(
    'pagehide',
    () => {
      lifetime.abort();
      clearTimeout(timer);
    },
    { once: true },
  );

  const poll = async () => {
    let usage = null;
    try {
      const response = await fetch(BASE + '/system-memory', {
        cache: 'no-store',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(SYSTEM_MEMORY_TIMEOUT_MS)]),
      });
      if (response.ok) {
        const status = await response.json();
        if (
          status?.ok === true &&
          status.available === true &&
          status.config?.showUsage === true &&
          (status.totalBytes === undefined || (Number.isFinite(status.totalBytes) && status.totalBytes > 0)) &&
          Number.isFinite(status.usedPercent) &&
          status.usedPercent >= 0 &&
          status.usedPercent <= 100
        ) {
          usage = status.usedPercent;
        }
      }
    } catch {
      // The optional helper may be unavailable. Remove the old reading and try again.
    }
    if (lifetime.signal.aborted) return;
    for (const sprite of sprites) sprite.setMemoryUsage(usage);
    timer = setTimeout(() => void poll(), SYSTEM_MEMORY_REFRESH_MS);
  };
  void poll();
}

Object.assign(PetSprite.prototype, {
  setMemoryUsage(usage) {
    const badge = this.memoryBadge;
    if (usage === null) {
      if (badge) {
        badge.remove();
        this.memoryBadge = null;
        this.refreshPopupBounds();
      }
      return;
    }
    const label = '内存 ' + usage.toFixed(1) + '%';
    if (badge?.textContent === label) return;
    if (!badge) {
      this.memoryBadge = document.createElement('span');
      this.memoryBadge.className = 'pet-memory-usage';
      this.el.appendChild(this.memoryBadge);
    }
    this.memoryBadge.textContent = label;
    // 布局尺寸仅在文本变化时测量，移动/抛掷的逐帧位置更新直接用缓存。
    this.memoryBadgeSize = { width: this.memoryBadge.offsetWidth, height: this.memoryBadge.offsetHeight };
    if (badge) this.layoutMemoryUsage();
    else this.refreshPopupBounds();
  },

  layoutMemoryUsage() {
    const badge = this.memoryBadge;
    const area = this.visibleClampRect();
    const gap = MEMORY_USAGE_GAP;
    const { width, height } = this.memoryBadgeSize;
    if (!area || !width || area.w < width + gap * 2) {
      badge.classList.toggle('is-placed', false);
      return;
    }
    const center = this.winOffset.x + this.halfW;
    const left = Math.max(area.x + gap, Math.min(center - width / 2, area.x + area.w - width - gap));
    // Prefer the space above the animation canvas, which is also safe when a
    // jump or pose brings the top of the head close to the edge of the artwork.
    const above = this.winOffset.y + this.bottomPad - height - gap;
    const below = this.winOffset.y + this.winH + gap;
    const top = above >= area.y + gap ? above : below;
    if (top < area.y + gap || top + height > area.y + area.h - gap) {
      badge.classList.toggle('is-placed', false);
      return;
    }
    const x = left - this.winOffset.x + 'px';
    const y = top - this.winOffset.y + 'px';
    if (badge.style.left !== x) badge.style.left = x;
    if (badge.style.top !== y) badge.style.top = y;
    badge.classList.toggle('is-placed', true);
  },
});
