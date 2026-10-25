import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { uuidv7 } from 'uuidv7';

/** Local file volume (docs/01 §2): `<root>/<facility>/<yyyy>/<mm>/<uuid>.<ext>`. */
export const DEFAULT_FILES_DIR = '/data/files';

export const filesDirFromEnv = (env: NodeJS.ProcessEnv = process.env): string =>
  env.HMIS_FILES_DIR || DEFAULT_FILES_DIR;

export interface StoredFile {
  /** Relative to the files root; what `document.file_path` holds. */
  relPath: string;
  sizeBytes: number;
  sha256: string;
}

/** The IST month the file is filed under is irrelevant; UTC keeps paths stable. */
export function newFilePath(facilityId: string, ext: string, now: Date): string {
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${facilityId}/${now.getUTCFullYear()}/${mm}/${uuidv7()}.${ext}`;
}

/** Absolute path for a relative one; refuses anything that would leave the root. */
export function absolutePath(root: string, relPath: string): string {
  const base = resolve(root);
  const full = resolve(base, relPath);
  if (!full.startsWith(base + sep)) throw new Error('path escapes the files directory');
  return full;
}

export async function storeFile(
  root: string,
  facilityId: string,
  ext: string,
  bytes: Uint8Array,
  now: Date,
): Promise<StoredFile> {
  const relPath = newFilePath(facilityId, ext, now);
  const full = absolutePath(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  // 'wx': a path is never overwritten.
  await writeFile(full, bytes, { flag: 'wx' });
  return {
    relPath,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function removeFile(root: string, relPath: string): Promise<void> {
  await rm(absolutePath(root, relPath), { force: true });
}

export const readPath = (root: string, relPath: string) => join(resolve(root), relPath);
