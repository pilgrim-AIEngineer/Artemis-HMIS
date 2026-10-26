import { describe, expect, it } from 'vitest';
import { amountInWords, amountInWordsEn, amountInWordsHi } from './words';

describe('amount in words (docs/05 §1.9)', () => {
  it('matches the spec example in Hindi and English', () => {
    expect(amountInWordsHi(125_000n)).toBe('एक हज़ार दो सौ पचास रुपये');
    expect(amountInWordsEn(125_000n)).toBe('One thousand two hundred fifty rupees');
  });

  it('uses lakh and crore, not million', () => {
    expect(amountInWordsEn(1_234_567_00n)).toBe(
      'Twelve lakh thirty-four thousand five hundred sixty-seven rupees',
    );
    expect(amountInWordsHi(1_234_567_00n)).toBe('बारह लाख चौंतीस हज़ार पाँच सौ सड़सठ रुपये');
    expect(amountInWordsEn(10_00_00_000_00n)).toBe('Ten crore rupees');
    expect(amountInWordsEn(10n ** 14n)).toBe('One lakh crore rupees');
  });

  it('handles paise, zero, one rupee and negatives', () => {
    expect(amountInWordsEn(50_005n)).toBe('Five hundred rupees and five paise');
    expect(amountInWordsHi(50_099n)).toBe('पाँच सौ रुपये और निन्यानवे पैसे');
    expect(amountInWordsEn(1n)).toBe('One paisa');
    expect(amountInWordsEn(0n)).toBe('Zero rupees');
    expect(amountInWordsHi(0n)).toBe('शून्य रुपये');
    expect(amountInWordsEn(100n)).toBe('One rupee');
    expect(amountInWordsEn(-20_000n)).toBe('Minus two hundred rupees');
    expect(amountInWordsHi(-20_000n)).toBe('ऋण दो सौ रुपये');
  });

  it('has a distinct Hindi word for every number below 100', () => {
    const words = new Set<string>();
    for (let n = 1n; n < 100n; n++) words.add(amountInWordsHi(n * 100n));
    expect(words.size).toBe(99);
    expect(amountInWordsHi(4_500n)).toBe('पैंतालीस रुपये');
    expect(amountInWords(9_900n, 'hi')).toBe('निन्यानवे रुपये');
    expect(amountInWords(9_900n, 'en')).toBe('Ninety-nine rupees');
  });
});
