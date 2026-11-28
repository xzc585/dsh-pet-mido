/** Persist files by replacing the target only after writing a complete sibling file. */
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';

export async function writeTextAtomically(path: string, text: string): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function writeTextAtomicallySync(path: string, text: string): void {
  writeFileAtomicallySync(path, text);
}

/** Optionally recheck the old file immediately before replacing it. */
export function writeFileAtomicallySync(path: string, data: string | Uint8Array, canReplace?: () => boolean): void {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    if (!canReplace || canReplace()) renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 保留原始写入错误。
    }
  }
}
