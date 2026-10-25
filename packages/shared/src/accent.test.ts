import { describe, expect, it } from 'vitest';
import { accentColorSchema, contrastRatio, readableOn } from './accent';

describe('accent colour', () => {
  it('accepts #rrggbb and lowercases it', () => {
    expect(accentColorSchema.parse(' #1A5FB4 ')).toBe('#1a5fb4');
    expect(accentColorSchema.safeParse('blue').success).toBe(false);
    expect(accentColorSchema.safeParse('#fff').success).toBe(false);
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('picks a text colour that is AA readable on every brand colour', () => {
    expect(readableOn('#1a5fb4')).toBe('#ffffff');
    expect(readableOn('#ffd54f')).toBe('#000000');
    for (let i = 0; i < 4096; i += 7) {
      const hex = `#${((i * 4099) % 0x1000000).toString(16).padStart(6, '0')}`;
      expect(contrastRatio(hex, readableOn(hex)), hex).toBeGreaterThanOrEqual(4.5);
    }
  });
});
