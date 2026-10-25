import { z } from 'zod';

/**
 * Hospital brand accent colour (docs/05 §4, Q20: neutral until the hospital chooses). A `#rrggbb`
 * value; the readable text colour on top of it is derived, so any brand colour keeps WCAG AA
 * contrast (docs/05 §5) for button labels.
 */
export const accentColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'validation.color')
  .transform((v) => v.toLowerCase());

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or black, whichever reads better on `hex` (always ≥ 4.5:1). */
export function readableOn(hex: string): '#ffffff' | '#000000' {
  return contrastRatio(hex, '#ffffff') >= contrastRatio(hex, '#000000') ? '#ffffff' : '#000000';
}
