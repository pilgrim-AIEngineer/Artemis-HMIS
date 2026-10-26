import { describe, expect, it } from 'vitest';
import { CODE128_PATTERNS, code128BValues, code128BWidths, code128Svg } from './barcode';

describe('Code 128 subset B', () => {
  it('has 106 distinct symbol patterns of 11 modules with even bar parity', () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    expect(new Set(CODE128_PATTERNS).size).toBe(106);
    for (const p of CODE128_PATTERNS) {
      const w = [...p].map(Number);
      expect(w.reduce((a, b) => a + b, 0)).toBe(11);
      expect((w[0]! + w[2]! + w[4]!) % 2).toBe(0);
    }
  });

  it('computes the check symbol (Wikipedia example, start B)', () => {
    // "PJJ123C": 104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7 = 879; 879 mod 103 = 55.
    const v = code128BValues('PJJ123C');
    expect(v[0]).toBe(104);
    expect(v.at(-1)).toBe(55);
  });

  it('draws start, data, check and stop in 11-module symbols (13 for stop)', () => {
    const widths = code128BWidths('UH-000123');
    // start + 9 chars + check = 11 symbols × 11 modules + stop 13
    expect(widths.reduce((a, b) => a + b, 0)).toBe(11 * 11 + 13);
    expect(widths).toHaveLength(11 * 6 + 7);
  });

  it('renders a stretchable SVG with a quiet zone and rejects non-ASCII', () => {
    const svg = code128Svg('OP/26-27/004512');
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('aria-label="OP/26-27/004512"');
    expect(svg.match(/<rect /g)!.length).toBeGreaterThan(20);
    expect(() => code128Svg('नाम')).toThrow();
  });
});
