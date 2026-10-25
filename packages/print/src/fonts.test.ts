import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FONT_FACES, fontFaceCss } from './fonts';
import { embeddedFontCss } from './node';

const css = readFileSync(new URL('./fonts.css', import.meta.url), 'utf8');

describe('bundled fonts', () => {
  it('ships a woff2 file for every face, plus the licence', () => {
    for (const f of FONT_FACES) {
      expect(existsSync(new URL(`../fonts/${f.file}`, import.meta.url)), f.file).toBe(true);
    }
    expect(existsSync(new URL('../fonts/OFL.txt', import.meta.url))).toBe(true);
  });

  it('covers Latin and Devanagari in regular and bold', () => {
    const key = (f: (typeof FONT_FACES)[number]) => `${f.family}|${f.weight}`;
    expect(FONT_FACES.map(key).sort()).toEqual([
      'Noto Sans Devanagari|400 500',
      'Noto Sans Devanagari|600 700',
      'Noto Sans|400 500',
      'Noto Sans|600 700',
    ]);
  });

  it('fonts.css (web) declares the same faces as fonts.ts (print/worker)', () => {
    for (const f of FONT_FACES) {
      expect(css).toContain(`url('../fonts/${f.file}')`);
      expect(css).toContain(`font-family: '${f.family}'`);
      expect(css).toContain(`font-weight: ${f.weight}`);
    }
    expect(css.match(/@font-face/g)).toHaveLength(FONT_FACES.length);
  });

  it('never references a CDN', () => {
    const all = css + fontFaceCss((f) => `/fonts/${f}`) + embeddedFontCss();
    expect(all).not.toMatch(/https?:\/\//);
  });

  it('embeds fonts as data URIs for the worker', () => {
    const embedded = embeddedFontCss();
    expect(embedded.match(/data:font\/woff2;base64,/g)).toHaveLength(FONT_FACES.length);
  });
});
