import { describe, expect, it } from 'vitest';
import { PAPER_SIZES, isPaperSize, pageCss } from './paper';

describe('paper sizes', () => {
  it('defines the four sizes from docs/01 §4', () => {
    expect(Object.keys(PAPER_SIZES).sort()).toEqual(['a4', 'a5', 'label50x25', 'thermal80']);
  });

  it('renders @page rules', () => {
    expect(pageCss('a5')).toBe('@page { size: 148mm 210mm; margin: 8mm; }');
    // `size: 80mm auto` is invalid CSS; the roll width comes from the printer driver.
    expect(pageCss('thermal80')).toBe('@page { margin: 3mm; }');
  });

  it('narrows template names', () => {
    expect(isPaperSize('a4')).toBe(true);
    expect(isPaperSize('letter')).toBe(false);
    expect(isPaperSize('toString')).toBe(false);
  });
});
