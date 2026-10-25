import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  nameSearchKeys,
  normaliseName,
  phoneticKey,
  phoneticSimilarity,
  trigramSimilarity,
  trigrams,
} from './search';

describe('normaliseName', () => {
  it('lowercases, trims and collapses spaces', () => {
    expect(normaliseName('  Sunita   DEVI ')).toBe('sunita devi');
  });

  it('turns punctuation into spaces', () => {
    expect(normaliseName('Smt. Anita-Kumari (W/o Ram)')).toBe('smt anita kumari w o ram');
    expect(normaliseName("D'Souza")).toBe('d souza');
  });

  it('strips Latin accents but keeps Devanagari intact', () => {
    expect(normaliseName('Rénu Çhaudhary')).toBe('renu chaudhary');
    expect(normaliseName('सुनीता देवी')).toBe('सुनीता देवी');
  });

  it('is empty for empty or symbol-only input', () => {
    expect(normaliseName('')).toBe('');
    expect(normaliseName(' . - ')).toBe('');
  });

  it('property: idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        expect(normaliseName(normaliseName(s))).toBe(normaliseName(s));
      }),
    );
  });
});

describe('phoneticKey (docs/01 §6 rules)', () => {
  it.each([
    ['Baaraat', 'barat'], // aa→a, double a dropped
    ['Suneeta', 'sunita'], // ee→i
    ['Poonam', 'punam'], // oo→u
    ['Shyam', 'syam'], // sh→s
    ['Sphurti', 'sfurti'], // ph→f
    ['Vijay', 'wijay'], // v→w
    ['Zeenat', 'jinat'], // z→j, ee→i
    ['Khushboo', 'kusbu'], // kh→k, sh→s, oo→u
    ['Ruthvik', 'rutwik'], // th→t, v→w
    ['Bharat', 'barat'], // bh→b
    ['Dhiraj', 'diraj'], // dh→d
    ['Gharana', 'garana'],
    ['Anna', 'ana'], // double letters dropped
    ['Rahul', 'rahul'], // h after a vowel stays
    ['Mohan', 'mohan'],
  ])('%s → %s', (name, key) => {
    expect(phoneticKey(name)).toBe(key);
  });

  it('groups common spelling variants under one key', () => {
    const groups = [
      ['Sunita', 'Suneeta', 'Sunitaa', 'Suneetha'],
      ['Poonam', 'Punam', 'Poonaam'],
      ['Vijay', 'Wijay'],
      ['Shyam', 'Syam'],
      ['Mohammad', 'Mohamad', 'Mohamaad'],
      ['Zeenat', 'Jeenat', 'Jinat'],
      ['Pratibha', 'Pratiba'],
      ['Kumari', 'Kumaree', 'Kumaari'],
      ['Rakesh', 'Rakes'],
    ];
    for (const g of groups) {
      expect(new Set(g.map(phoneticKey)).size, g.join('/')).toBe(1);
    }
  });

  it('keeps different names apart', () => {
    expect(phoneticKey('Sunita')).not.toBe(phoneticKey('Sunil'));
    expect(phoneticKey('Ram')).not.toBe(phoneticKey('Rama'));
    expect(phoneticKey('Rahul')).not.toBe(phoneticKey('Raul'));
  });

  it('works per word and keeps word order', () => {
    expect(phoneticKey('Sunita  DEVI')).toBe('sunita dewi');
    expect(phoneticKey('Ram Prakash')).toBe('ram prakas');
  });

  it('leaves Devanagari untouched', () => {
    expect(phoneticKey('सुनीता')).toBe('सुनीता');
  });

  it('regression: repeated h after a consonant folds in one pass (found by the property test)', () => {
    expect(phoneticKey('bhh')).toBe('b');
    expect(phoneticKey(phoneticKey('bhh'))).toBe(phoneticKey('bhh'));
    expect(phoneticKey('Rakhhi')).toBe(phoneticKey('Rakhi'));
  });

  it('property: idempotent and never longer than the normalised name', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z ]{0,30}$/), (s) => {
        const k = phoneticKey(s);
        expect(phoneticKey(k)).toBe(k);
        expect(k.length).toBeLessThanOrEqual(normaliseName(s).length);
      }),
      { numRuns: 2000 },
    );
  });

  it('property: no double letters remain', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z ]{0,30}$/), (s) => {
        expect(phoneticKey(s)).not.toMatch(/([a-z])\1/);
      }),
    );
  });
});

describe('nameSearchKeys', () => {
  it('returns both stored columns', () => {
    expect(nameSearchKeys('  Suneeta  Kumari ')).toEqual({
      norm: 'suneeta kumari',
      phonetic: 'sunita kumari',
    });
  });
});

describe('trigram similarity (pg_trgm compatible)', () => {
  it('builds trigrams with two leading and one trailing space', () => {
    expect([...trigrams('cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat'].sort());
    expect(trigrams('').size).toBe(0);
  });

  it('matches known pg_trgm values', () => {
    // select similarity('word','two words') = 0.36363637
    expect(trigramSimilarity('word', 'two words')).toBeCloseTo(4 / 11, 5);
    expect(trigramSimilarity('abc', 'abc')).toBe(1);
    expect(trigramSimilarity('abc', 'xyz')).toBe(0);
    expect(trigramSimilarity('', '')).toBe(0);
  });

  it('is symmetric and in [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z ]{0,20}$/),
        fc.stringMatching(/^[a-z ]{0,20}$/),
        (a, b) => {
          const s = trigramSimilarity(a, b);
          expect(s).toBe(trigramSimilarity(b, a));
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it('phoneticSimilarity: spelling variants pass the 0.6 duplicate threshold, strangers do not', () => {
    expect(phoneticSimilarity('Suneeta Devi', 'Sunita Devi')).toBe(1);
    expect(phoneticSimilarity('Poonam Verma', 'Punam Werma')).toBe(1);
    expect(phoneticSimilarity('Sunita Devi', 'Rekha Singh')).toBeLessThan(0.6);
    expect(phoneticSimilarity('Anita Sharma', 'Sunita Sharma')).toBeLessThan(0.9);
  });
});
