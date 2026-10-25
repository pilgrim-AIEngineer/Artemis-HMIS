/**
 * Bundled fonts (docs/01 §4: Noto Sans + Noto Sans Devanagari, no CDN). The woff2 files live in
 * `packages/print/fonts` (SIL OFL, see OFL.txt). The web app loads them through `fonts.css`; the
 * worker embeds them as data URIs (`./node`) because Chromium renders its HTML from memory.
 * `fonts.test.ts` keeps this list and `fonts.css` in sync.
 */

export interface FontFace {
  family: 'Noto Sans' | 'Noto Sans Devanagari';
  file: string;
  /** CSS font-weight (a range lets the bold file also serve semibold headings). */
  weight: string;
  unicodeRange: string;
}

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const DEVANAGARI =
  'U+0900-097F,U+1CD0-1CF9,U+200C-200D,U+20A8,U+20B9,U+20F0,U+25CC,U+A830-A839,U+A8E0-A8FF,U+11B00-11B09';

export const FONT_FACES: readonly FontFace[] = [
  {
    family: 'Noto Sans',
    file: 'noto-sans-latin-400.woff2',
    weight: '400 500',
    unicodeRange: LATIN,
  },
  {
    family: 'Noto Sans',
    file: 'noto-sans-latin-700.woff2',
    weight: '600 700',
    unicodeRange: LATIN,
  },
  {
    family: 'Noto Sans Devanagari',
    file: 'noto-sans-devanagari-400.woff2',
    weight: '400 500',
    unicodeRange: DEVANAGARI,
  },
  {
    family: 'Noto Sans Devanagari',
    file: 'noto-sans-devanagari-700.woff2',
    weight: '600 700',
    unicodeRange: DEVANAGARI,
  },
];

/** The CSS `font-family` stack for printouts: Latin first, Devanagari for Hindi text. */
export const PRINT_FONT_STACK = "'Noto Sans', 'Noto Sans Devanagari', sans-serif";

/** `@font-face` rules; `urlFor` turns a file name into a URL or `data:` URI. */
export function fontFaceCss(urlFor: (file: string) => string): string {
  return FONT_FACES.map(
    (f) =>
      `@font-face { font-family: '${f.family}'; font-style: normal; font-weight: ${f.weight}; font-display: block; src: url('${urlFor(f.file)}') format('woff2'); unicode-range: ${f.unicodeRange}; }`,
  ).join('\n');
}
