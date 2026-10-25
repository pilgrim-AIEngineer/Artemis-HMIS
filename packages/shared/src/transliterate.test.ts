import { describe, expect, it } from 'vitest';
import { transliterateToDevanagari } from './transliterate';

describe('transliterateToDevanagari', () => {
  it('uses the dictionary for common names', () => {
    expect(transliterateToDevanagari('Sunita Verma')).toBe('सुनीता वर्मा');
    expect(transliterateToDevanagari('  RAKESH   kumar ')).toBe('राकेश कुमार');
  });

  it('falls back to rules for unknown names, producing only Devanagari', () => {
    for (const n of ['Bhavna', 'Tanvi Rastogi', 'Omkar']) {
      const out = transliterateToDevanagari(n);
      expect(out).not.toBe('');
      expect(out).toMatch(/^[ऀ-ॿ ]+$/u);
    }
  });

  it('returns empty for nothing convertible and keeps existing Devanagari', () => {
    expect(transliterateToDevanagari('123 -')).toBe('');
    expect(transliterateToDevanagari('सुनीता Devi')).toBe('सुनीता देवी');
  });
});
