/**
 * 动画素材的字节缓存，以及「当前没在播」的那一路视频怎么丢掉。
 *
 * 换源时会把整段 webm 取成 blob。这里按地址留一份，同一段再次播放不必重新下载；
 * 清理时只丢掉没有视频元素还指着的那几份，并让动画链松开后台那一路的解码器。
 * 不决定何时清理（归 memory-cleanup），也不管语音缓存。
 * @module dsh-pet/src/client/pet/animation/media-cache
 */

/** 一条缓存：blob 本身、字节数、还有几个 object URL 指着它。 */
interface CacheEntry {
  blob: Blob;
  bytes: number;
  retainers: number;
}

/** 后台槽位：清理时由动画链把没在前台的那一路松开。 */
export interface AnimationSlot {
  /** 松开后台视频并撤销它的 object URL。返回松开的路数（0 或 1）。 */
  releaseBack: () => number;
}

const byUrl = new Map<string, CacheEntry>();
const objectToUrl = new Map<string, string>();
const slots = new Set<AnimationSlot>();

/**
 * 记住一次取到的素材。同一地址已有缓存时不覆盖，避免把还被引用的 blob 换掉。
 *
 * @param url - 素材的 HTTP 地址。
 * @param blob - 整段文件。
 */
export function rememberBlob(url: string, blob: Blob): void {
  if (byUrl.has(url)) return;
  byUrl.set(url, { blob, bytes: blob.size, retainers: 0 });
}

/**
 * 取已缓存的素材。
 *
 * @param url - 素材的 HTTP 地址。
 * @returns 缓存的 blob；没有则 undefined。
 */
export function cachedBlob(url: string): Blob | undefined {
  return byUrl.get(url)?.blob;
}

/**
 * 一个 object URL 开始指着某段素材。
 *
 * @param objectUrl - `URL.createObjectURL` 的结果。
 * @param url - 对应的 HTTP 地址。
 */
export function bindObjectUrl(objectUrl: string, url: string): void {
  objectToUrl.set(objectUrl, url);
  const entry = byUrl.get(url);
  if (entry) entry.retainers += 1;
}

/**
 * object URL 已经 revoke，不再占着这段素材。
 *
 * @param objectUrl - 被释放的地址。
 */
export function unbindObjectUrl(objectUrl: string): void {
  const url = objectToUrl.get(objectUrl);
  objectToUrl.delete(objectUrl);
  if (url === undefined) return;
  const entry = byUrl.get(url);
  if (!entry) return;
  entry.retainers = Math.max(0, entry.retainers - 1);
}

/** 当前缓存着的素材一共多少字节（含仍在播放的）。 */
export function animationCacheBytes(): number {
  let total = 0;
  for (const entry of byUrl.values()) total += entry.bytes;
  return total;
}

/**
 * 丢掉没有视频还在用的素材。
 *
 * @returns 释放的字节数。
 */
export function evictUnretainedBlobs(): number {
  let freed = 0;
  for (const [url, entry] of byUrl) {
    if (entry.retainers > 0) continue;
    freed += entry.bytes;
    byUrl.delete(url);
  }
  return freed;
}

/**
 * 登记一条动画链，清理时会叫它松开后台视频。
 *
 * @param slot - 动画链提供的松开动作。
 * @returns 卸载时调用，把自己从名单里拿掉。
 */
export function registerAnimationSlot(slot: AnimationSlot): () => void {
  slots.add(slot);
  return () => {
    slots.delete(slot);
  };
}

/**
 * 松开所有后台视频，再丢掉没人用的 blob。
 *
 * 前台正在播的那一路保留：retainers 仍大于 0，缓存不会被清掉。
 *
 * @returns 松开的视频路数，以及丢掉的字节数。
 */
export function releaseDetachedAnimationMedia(): { videos: number; bytes: number } {
  let videos = 0;
  for (const slot of slots) videos += slot.releaseBack();
  return { videos, bytes: evictUnretainedBlobs() };
}

/** 清空缓存与登记。只给测试用，避免用例之间串状态。 */
export function resetAnimationMediaCache(): void {
  byUrl.clear();
  objectToUrl.clear();
  slots.clear();
}
