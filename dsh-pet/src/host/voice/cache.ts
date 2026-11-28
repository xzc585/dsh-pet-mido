/**
 * 语音缓存：按「限定音色 + 语速 + 文本」算键，落盘为音频文件，并按总量与条数淘汰最旧的。
 *
 * 命中即免合成——同一句话不管是自动播报还是手动点播都只合成一次。扩展名与 MIME 由
 * {@link FORMAT_INFO} 统一给出：两处各写一份就会出现「存成 .mp3、应答说 wav」。
 * 不负责合成与队列；删除任意文件都不影响正确性，下一次请求会重新合成。
 * @module dsh-pet/src/host/voice/cache
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { VoiceFormat } from './types.ts';

/** 缓存总量上限（字节）：超过后从最旧的开始删。 */
export const CACHE_MAX_BYTES = 20 * 1024 * 1024;
/** 缓存文件条数上限。 */
export const CACHE_MAX_FILES = 200;

/** 各格式的落盘扩展名与应答 MIME；缓存路径、淘汰白名单与路由应答都读这一份。 */
export const FORMAT_INFO: Record<VoiceFormat, { readonly ext: string; readonly mime: string }> = {
  mp3: { ext: '.mp3', mime: 'audio/mpeg' },
  wav: { ext: '.wav', mime: 'audio/wav' },
};

/** 淘汰时要统计的扩展名；漏掉一种，那种文件就永远删不掉。 */
const CACHED_EXTENSIONS: readonly string[] = Object.values(FORMAT_INFO).map((info) => info.ext);

/**
 * 缓存文件的完整路径：`<userRoot>/voice-cache/<key><ext>`。
 * @param userRoot - 用户数据根。
 * @param key - {@link cacheKey} 的结果。
 * @param format - 音频格式；决定扩展名。
 */
export function cachePath(userRoot: string, key: string, format: VoiceFormat): string {
  return join(userRoot, 'voice-cache', key + FORMAT_INFO[format].ext);
}

/**
 * 计算缓存键。
 *
 * 三个输入都影响音频内容。`voiceId` 是限定 id（含 provider 前缀），所以换实现、换音色、
 * 换语速、换文本里的任何一项都不会命中旧音频；`text` 不做归一化——同一句话多一个空格
 * 就是另一份音频，宁可多存也不冒「听起来不对」的风险。
 *
 * @param voiceId - 限定音色 id，如 `edge/zh-CN-XiaoyiNeural`。
 * @param rate - 语速偏移百分比，由入口解析成数字后传入。
 * @param text - 待合成文本。
 * @returns 十六进制 sha1。
 */
export function cacheKey(voiceId: string, rate: number, text: string): string {
  return createHash('sha1').update(`${voiceId}\n${rate}\n${text}`).digest('hex');
}

/**
 * 确保缓存目录存在。
 * @param userRoot - 用户数据根。
 * @returns 缓存目录绝对路径。
 */
export async function ensureCacheDir(userRoot: string): Promise<string> {
  const dir = join(userRoot, 'voice-cache');
  await mkdir(dir, { recursive: true });
  return dir;
}

interface CacheEntry {
  file: string;
  size: number;
  mtimeMs: number;
}

interface CacheSnapshot {
  dir: string;
  entries: CacheEntry[];
  bytes: number;
}

type CacheLimits = { maxBytes?: number; maxFiles?: number };
type RemovedCache = { files: number; bytes: number };
const pendingPrunes = new Map<string, Promise<RemovedCache>>();

/** 扫描一次普通音频文件，供统计和淘汰共用。 */
export async function scanVoiceCache(dir: string): Promise<CacheSnapshot> {
  const snapshot: CacheSnapshot = { dir: resolve(dir), entries: [], bytes: 0 };
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return snapshot;
  }
  for (const entry of names) {
    if (!entry.isFile() || !CACHED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    const file = join(dir, entry.name);
    try {
      const info = await lstat(file);
      if (!info.isFile()) continue;
      snapshot.entries.push({ file, size: info.size, mtimeMs: info.mtimeMs });
      snapshot.bytes += info.size;
    } catch {
      /* 这条正被别的请求删掉，跳过 */
    }
  }
  return snapshot;
}

/** 淘汰快照中的文件，并统计实际删除的数量和字节。 */
export async function pruneScannedCache(snapshot: CacheSnapshot, limits: CacheLimits = {}): Promise<RemovedCache> {
  const { dir } = snapshot;
  const previous = pendingPrunes.get(dir);
  // Windows 同时删除同一个文件时，两次调用有可能都报告成功，按目录串行删除。
  const prune = (async () => {
    await previous;
    return pruneCacheEntries(snapshot, limits);
  })();
  pendingPrunes.set(dir, prune);
  try {
    return await prune;
  } finally {
    if (pendingPrunes.get(dir) === prune) pendingPrunes.delete(dir);
  }
}

async function pruneCacheEntries(snapshot: CacheSnapshot, limits: CacheLimits): Promise<RemovedCache> {
  const maxBytes = limits.maxBytes ?? CACHE_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? CACHE_MAX_FILES;
  const { entries, bytes } = snapshot;
  const removed = { files: 0, bytes: 0 };
  if (bytes <= maxBytes && entries.length <= maxFiles) return removed;
  if (maxFiles !== 0) entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = bytes;
  let totalFiles = entries.length;
  for (const entry of entries) {
    if (totalBytes <= maxBytes && totalFiles <= maxFiles) break;
    try {
      await unlink(entry.file);
      removed.files += 1;
      removed.bytes += entry.size;
    } catch (error) {
      // 文件已被其它进程删除也不再占用本次限额，但不能算到本次释放量里。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
    totalBytes -= entry.size;
    totalFiles -= 1;
  }
  return removed;
}

/** 按「总量 + 条数」淘汰最旧的文件，返回实际删除的文件数。 */
export async function pruneCache(dir: string, limits: CacheLimits = {}): Promise<number> {
  return (await pruneScannedCache(await scanVoiceCache(dir), limits)).files;
}
