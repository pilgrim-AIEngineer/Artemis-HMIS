/**
 * Node-only helpers (worker, tests): fonts embedded as data URIs so Chromium needs no network or
 * file access. `HMIS_FONT_DIR` overrides the directory (the worker image copies the fonts there).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontFaceCss } from './fonts';

const fontDir = () =>
  process.env.HMIS_FONT_DIR ?? fileURLToPath(new URL('../fonts/', import.meta.url));

let cached: string | undefined;

/** `@font-face` CSS with every font inlined as base64 (cached after the first call). */
export function embeddedFontCss(): string {
  cached ??= fontFaceCss(
    (file) => `data:font/woff2;base64,${readFileSync(join(fontDir(), file)).toString('base64')}`,
  );
  return cached;
}
