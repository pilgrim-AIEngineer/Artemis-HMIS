/**
 * Paper sizes used by print templates (docs/01 §4). One template serves both browser print and
 * worker PDF; templates (React → HTML) and fonts arrive with FND-06.
 */
export const PAPER_SIZES = {
  thermal80: { widthMm: 80, heightMm: null, marginMm: 3 },
  a5: { widthMm: 148, heightMm: 210, marginMm: 8 },
  a4: { widthMm: 210, heightMm: 297, marginMm: 12 },
  label50x25: { widthMm: 50, heightMm: 25, marginMm: 1 },
} as const satisfies Record<string, { widthMm: number; heightMm: number | null; marginMm: number }>;

export type PaperSize = keyof typeof PAPER_SIZES;

export const isPaperSize = (v: string): v is PaperSize => Object.hasOwn(PAPER_SIZES, v);

/**
 * CSS `@page` rule for a paper size. Thermal rolls have no fixed height, and `size: 80mm auto` is
 * not valid CSS (a length cannot be mixed with `auto`; Chromium then falls back to Letter), so the
 * roll rule sets only the margin: the paper is the 80 mm roll chosen in the printer driver. PDFs
 * of rolls get an explicit size from the worker, cut to the measured content height.
 */
export function pageCss(size: PaperSize): string {
  const p = PAPER_SIZES[size];
  if (p.heightMm === null) return `@page { margin: ${p.marginMm}mm; }`;
  return `@page { size: ${p.widthMm}mm ${p.heightMm}mm; margin: ${p.marginMm}mm; }`;
}
