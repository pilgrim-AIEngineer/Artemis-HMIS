import { describe, expect, it } from 'vitest';
import { findForbiddenTerms } from './compliance/forbidden-terms';
import {
  buildInstruction,
  DEFAULT_RX_PHRASES_HI,
  RX_PHRASE_KEYS,
  RX_PHRASES_EN,
  rxPhrasesOverrideSchema,
} from './rx-hindi';
import { parseRxShorthand } from './rx-shorthand';

const hi = (line: string) => buildInstruction(parseRxShorthand(line), 'hi');
const en = (line: string) => buildInstruction(parseRxShorthand(line), 'en');

describe('Hindi instruction builder (OPD-03, docs/11 §2.3)', () => {
  it('builds the spec example', () => {
    expect(hi('dolo 650 1-0-1 af 5d')).toBe('1-0-1, खाने के बाद, 5 दिन');
    expect(en('dolo 650 1-0-1 af 5d')).toBe('1-0-1, after food, 5 days');
  });

  it('covers doses, codes, timings, routes and durations', () => {
    expect(hi('folvite bd x1m')).toBe('1-0-1, 1 महीना');
    expect(hi('tab shelcal od af 3m')).toBe('1-0-0, खाने के बाद, 3 महीने');
    expect(hi('syp calpol 5ml tds 3d')).toBe('5 ml, 1-1-1, 3 दिन');
    expect(hi('inj tt im stat')).toBe('तुरंत, एक बार, मांसपेशी में इंजेक्शन');
    expect(hi('tab doxinate hs x 10d')).toBe('0-0-1, रात को सोते समय, 10 दिन');
    expect(hi('tab meftal spas sos')).toBe('ज़रूरत पड़ने पर');
    expect(hi('tab uprise d3 60k weekly x8w')).toBe('हफ़्ते में एक बार, 8 सप्ताह');
    expect(hi('tab ecosprin 75 alt x 1m')).toBe('एक दिन छोड़कर, 1 महीना');
    expect(hi('tab eltroxin 25 1-0-0 es 1m')).toBe('1-0-0, खाली पेट, 1 महीना');
    expect(hi('pess susten 200 pv hs x10d')).toBe('0-0-1, रात को सोते समय, योनि मार्ग में, 10 दिन');
    expect(hi('dolo 650 ½ tab bd 3d')).toBe('½ गोली, 1-0-1, 3 दिन');
    expect(hi('inh budecort 2 puffs bd 1m')).toBe('2 पफ़, 1-0-1, 1 महीना');
    expect(hi('tab dolo 650 bd 5d if fever')).toBe('1-0-1, 5 दिन, if fever');
    expect(en('tab iron od af for 1 week')).toBe('1-0-0, after food, 1 week');
    expect(en('tab limcee od 1d')).toBe('1-0-0, 1 day');
  });

  it('is empty when nothing is known, and uses the hospital wording when set', () => {
    expect(hi('some unknown words')).toBe('');
    const r = buildInstruction(parseRxShorthand('dolo 650 1-0-1 af 5d'), 'hi', {
      'timing.af': 'भोजन के बाद',
    });
    expect(r).toBe('1-0-1, भोजन के बाद, 5 दिन');
  });

  it('has a Hindi and English phrase for every key, and no forbidden wording', () => {
    for (const k of RX_PHRASE_KEYS) {
      expect(DEFAULT_RX_PHRASES_HI[k].length, k).toBeGreaterThan(0);
      expect(RX_PHRASES_EN[k].length, k).toBeGreaterThan(0);
      expect(findForbiddenTerms(DEFAULT_RX_PHRASES_HI[k], { tier: 'strict' }), k).toEqual([]);
    }
  });

  it('validates the rewording setting', () => {
    expect(rxPhrasesOverrideSchema.safeParse({ 'timing.af': 'भोजन के बाद' }).success).toBe(true);
    expect(rxPhrasesOverrideSchema.safeParse({ nope: 'x' }).success).toBe(false);
    expect(rxPhrasesOverrideSchema.safeParse({ 'timing.af': '' }).success).toBe(false);
  });
});
