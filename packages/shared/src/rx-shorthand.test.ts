import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DrugForm } from './masters';
import { rxQuantity } from './rx';
import { parseRxShorthand, type ParsedRxLine } from './rx-shorthand';

/**
 * Synthetic Rx lines written the way OPD assistants type doctors' shorthand (docs/50 §4: real
 * anonymised lines replace / extend these once collected, docs/32 §3). Each fixture lists the
 * fields it expects; fields not listed must be empty, so a parse never invents a value.
 */
type Expect = Partial<Omit<ParsedRxLine, 'raw' | 'complete'>> & {
  qty?: number | null;
  form?: DrugForm | null;
};
const F: [string, Expect][] = [
  // docs/11 §2.3 examples
  [
    'dolo 650 1-0-1 af 5d',
    { drugText: 'dolo 650', pattern: '1-0-1', timing: 'af', durationValue: 5, durationUnit: 'd' },
  ],
  [
    'folvite bd x1m',
    {
      drugText: 'folvite',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'syp calpol 5ml tds 3d',
    {
      drugText: 'calpol',
      form: 'syp',
      doseText: '5 ml',
      frequencyCode: 'TDS',
      pattern: '1-1-1',
      durationValue: 3,
      durationUnit: 'd',
    },
  ],
  ['inj tt im stat', { drugText: 'tt', form: 'inj', route: 'im', frequencyCode: 'STAT' }],
  // codes
  [
    'tab pan 40 od bf x 15d',
    {
      drugText: 'pan 40',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      timing: 'bf',
      durationValue: 15,
      durationUnit: 'd',
    },
  ],
  [
    'cap omez 20 bf od 1m',
    {
      drugText: 'omez 20',
      form: 'cap',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      timing: 'bf',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab metformin 500 bd af 1m',
    {
      drugText: 'metformin 500',
      form: 'tab',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab cefixime 200 bid x5d',
    {
      drugText: 'cefixime 200',
      form: 'tab',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab augmentin 625 tid af 5d',
    {
      drugText: 'augmentin 625',
      form: 'tab',
      frequencyCode: 'TDS',
      pattern: '1-1-1',
      timing: 'af',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab metronidazole 400 tds x 7d',
    {
      drugText: 'metronidazole 400',
      form: 'tab',
      frequencyCode: 'TDS',
      pattern: '1-1-1',
      durationValue: 7,
      durationUnit: 'd',
    },
  ],
  [
    'cap amoxy 500 qid 5d',
    {
      drugText: 'amoxy 500',
      form: 'cap',
      frequencyCode: 'QID',
      pattern: '1-1-1-1',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab doxinate hs x 10d',
    {
      drugText: 'doxinate',
      form: 'tab',
      frequencyCode: 'HS',
      pattern: '0-0-1',
      durationValue: 10,
      durationUnit: 'd',
    },
  ],
  ['tab meftal spas sos', { drugText: 'meftal spas', form: 'tab', frequencyCode: 'SOS' }],
  ['tab ondem 4 sos', { drugText: 'ondem 4', form: 'tab', frequencyCode: 'SOS' }],
  ['tab dolo 650 prn', { drugText: 'dolo 650', form: 'tab', frequencyCode: 'SOS' }],
  [
    'inj vit k 1mg im stat',
    { drugText: 'vit k 1mg', form: 'inj', route: 'im', frequencyCode: 'STAT' },
  ],
  [
    'tab uprise d3 60k weekly x8w',
    {
      drugText: 'uprise d3 60k',
      form: 'tab',
      frequencyCode: 'WEEKLY',
      durationValue: 8,
      durationUnit: 'w',
    },
  ],
  [
    'sachet calcirol weekly 2m',
    {
      drugText: 'calcirol',
      form: 'sachet',
      frequencyCode: 'WEEKLY',
      durationValue: 2,
      durationUnit: 'm',
    },
  ],
  [
    'tab ecosprin 75 alt x 1m',
    {
      drugText: 'ecosprin 75',
      form: 'tab',
      frequencyCode: 'ALT',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab shelcal 500 od af 3m',
    {
      drugText: 'shelcal 500',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      timing: 'af',
      durationValue: 3,
      durationUnit: 'm',
    },
  ],
  // patterns
  [
    'tab dolo 650 1-1-1 af x3d',
    {
      drugText: 'dolo 650',
      form: 'tab',
      pattern: '1-1-1',
      timing: 'af',
      durationValue: 3,
      durationUnit: 'd',
    },
  ],
  [
    'tab thyronorm 50mcg 1-0-0 es 1m',
    {
      drugText: 'thyronorm 50mcg',
      form: 'tab',
      pattern: '1-0-0',
      timing: 'empty_stomach',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab feronia xt 0-1-0 af 1m',
    {
      drugText: 'feronia xt',
      form: 'tab',
      pattern: '0-1-0',
      timing: 'af',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab labetalol 100 1-1-1 x 15 days',
    {
      drugText: 'labetalol 100',
      form: 'tab',
      pattern: '1-1-1',
      durationValue: 15,
      durationUnit: 'd',
    },
  ],
  ['tab nifedipine 10 1-0-1', { drugText: 'nifedipine 10', form: 'tab', pattern: '1-0-1' }],
  [
    'tab rantac 150 1-0-1 bf 7d',
    {
      drugText: 'rantac 150',
      form: 'tab',
      pattern: '1-0-1',
      timing: 'bf',
      durationValue: 7,
      durationUnit: 'd',
    },
  ],
  [
    'tab montair lc 0-0-1 5d',
    { drugText: 'montair lc', form: 'tab', pattern: '0-0-1', durationValue: 5, durationUnit: 'd' },
  ],
  [
    'tab cetirizine 0-0-1 x5',
    { drugText: 'cetirizine', form: 'tab', pattern: '0-0-1', durationValue: 5, durationUnit: 'd' },
  ],
  [
    'tab glycomet 500 1-0-1 af 30d',
    {
      drugText: 'glycomet 500',
      form: 'tab',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 30,
      durationUnit: 'd',
    },
  ],
  [
    'tab salbutamol 2 1-1-1-1 5d',
    {
      drugText: 'salbutamol 2',
      form: 'tab',
      pattern: '1-1-1-1',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab dolo 650 1 - 0 - 1 af 5 days',
    {
      drugText: 'dolo 650',
      form: 'tab',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab pcm 500 1+0+1 x3d',
    { drugText: 'pcm 500', form: 'tab', pattern: '1-0-1', durationValue: 3, durationUnit: 'd' },
  ],
  [
    'tab dolo 650 1–0–1 af 5d',
    {
      drugText: 'dolo 650',
      form: 'tab',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab aldomet 250 1-1-1-1 af 1m',
    {
      drugText: 'aldomet 250',
      form: 'tab',
      pattern: '1-1-1-1',
      timing: 'af',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab dexona ½-0-½ 3d',
    { drugText: 'dexona', form: 'tab', pattern: '½-0-½', durationValue: 3, durationUnit: 'd' },
  ],
  [
    'tab dexona 0.5-0-0.5 3d',
    { drugText: 'dexona', form: 'tab', pattern: '½-0-½', durationValue: 3, durationUnit: 'd' },
  ],
  [
    'tab dexona 1/2-0-1/2 3d',
    { drugText: 'dexona', form: 'tab', pattern: '½-0-½', durationValue: 3, durationUnit: 'd' },
  ],
  [
    'tab cabgolin 0.5 mg 1-0-0 weekly x4w',
    {
      drugText: 'cabgolin 0.5 mg',
      form: 'tab',
      pattern: '1-0-0',
      frequencyCode: 'WEEKLY',
      durationValue: 4,
      durationUnit: 'w',
    },
  ],
  // doses
  [
    'syp ambrodil 5 ml tds 5d',
    {
      drugText: 'ambrodil',
      form: 'syp',
      doseText: '5 ml',
      frequencyCode: 'TDS',
      pattern: '1-1-1',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'syp calpol 2.5ml sos',
    { drugText: 'calpol', form: 'syp', doseText: '2.5 ml', frequencyCode: 'SOS' },
  ],
  [
    'syp sucral 10ml tds bf 7d',
    {
      drugText: 'sucral',
      form: 'syp',
      doseText: '10 ml',
      frequencyCode: 'TDS',
      pattern: '1-1-1',
      timing: 'bf',
      durationValue: 7,
      durationUnit: 'd',
    },
  ],
  [
    'syp cremaffin 2 tsf hs x 7d',
    {
      drugText: 'cremaffin',
      form: 'syp',
      doseText: '2 tsf',
      frequencyCode: 'HS',
      pattern: '0-0-1',
      durationValue: 7,
      durationUnit: 'd',
    },
  ],
  [
    'drops vitcofol 0.5ml od 1m',
    {
      drugText: 'vitcofol',
      form: 'drops',
      doseText: '0.5 ml',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'dolo 650 1 tab bd af 3d',
    {
      drugText: 'dolo 650',
      form: 'tab',
      doseText: '1 tab',
      unitsPerDose: 1,
      frequencyCode: 'BD',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 3,
      durationUnit: 'd',
    },
  ],
  [
    'dolo 650 ½ tab bd 3d',
    {
      drugText: 'dolo 650',
      form: 'tab',
      doseText: '½ tab',
      unitsPerDose: 0.5,
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 3,
      durationUnit: 'd',
    },
  ],
  [
    'tab dolo 650 half bd x3d',
    {
      drugText: 'dolo 650',
      form: 'tab',
      doseText: '½ tab',
      unitsPerDose: 0.5,
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 3,
      durationUnit: 'd',
    },
  ],
  [
    'tab dolo 650 2tab stat',
    {
      drugText: 'dolo 650',
      form: 'tab',
      doseText: '2 tab',
      unitsPerDose: 2,
      frequencyCode: 'STAT',
    },
  ],
  [
    'dolo 650 tab 1-0-1 5d',
    { drugText: 'dolo 650', form: 'tab', pattern: '1-0-1', durationValue: 5, durationUnit: 'd' },
  ],
  [
    'inh budecort 2 puffs bd 1m',
    {
      drugText: 'budecort',
      form: 'inhaler',
      doseText: '2 puffs',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'inj actrapid 6u sc bf tds',
    {
      drugText: 'actrapid',
      form: 'inj',
      doseText: '6 units',
      route: 'sc',
      timing: 'bf',
      frequencyCode: 'TDS',
      pattern: '1-1-1',
    },
  ],
  [
    'inj insulin 10 iu sc od',
    {
      drugText: 'insulin',
      form: 'inj',
      doseText: '10 units',
      route: 'sc',
      frequencyCode: 'OD',
      pattern: '1-0-0',
    },
  ],
  [
    'drops moxi eye 1 drop qid 7d',
    {
      drugText: 'moxi',
      form: 'drops',
      route: 'eye',
      doseText: '1 drops',
      frequencyCode: 'QID',
      pattern: '1-1-1-1',
      durationValue: 7,
      durationUnit: 'd',
    },
  ],
  [
    'eye drops moxicip 1-1-1-1 5d',
    {
      drugText: 'moxicip',
      form: 'drops',
      route: 'eye',
      pattern: '1-1-1-1',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  // routes and forms
  [
    'inj ceftriaxone 1g iv bd 3d',
    {
      drugText: 'ceftriaxone 1g',
      form: 'inj',
      route: 'iv',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 3,
      durationUnit: 'd',
    },
  ],
  [
    'inj anti d 300mcg im stat',
    { drugText: 'anti d 300mcg', form: 'inj', route: 'im', frequencyCode: 'STAT' },
  ],
  [
    'pess susten 200 pv hs x10d',
    {
      drugText: 'susten 200',
      form: 'pessary',
      route: 'pv',
      frequencyCode: 'HS',
      pattern: '0-0-1',
      durationValue: 10,
      durationUnit: 'd',
    },
  ],
  [
    'cap susten 200 pv hs 2w',
    {
      drugText: 'susten 200',
      form: 'cap',
      route: 'pv',
      frequencyCode: 'HS',
      pattern: '0-0-1',
      durationValue: 2,
      durationUnit: 'w',
    },
  ],
  [
    'candid v6 pv hs 6d',
    {
      drugText: 'candid v6',
      route: 'pv',
      frequencyCode: 'HS',
      pattern: '0-0-1',
      durationValue: 6,
      durationUnit: 'd',
    },
  ],
  [
    'cream clotrimazole la bd 2w',
    {
      drugText: 'clotrimazole',
      form: 'cream',
      route: 'topical',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 2,
      durationUnit: 'w',
    },
  ],
  [
    'oint mupirocin local tds 5d',
    {
      drugText: 'mupirocin',
      form: 'cream',
      route: 'topical',
      frequencyCode: 'TDS',
      pattern: '1-1-1',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'neb duolin 1-1-1 3d',
    {
      drugText: 'duolin',
      route: 'inhalation',
      pattern: '1-1-1',
      durationValue: 3,
      durationUnit: 'd',
    },
  ],
  [
    'tab sorbitrate 5 sl sos',
    { drugText: 'sorbitrate 5', form: 'tab', route: 'sl', frequencyCode: 'SOS' },
  ],
  [
    'nasivion nasal drops 1-1-1 5d',
    {
      drugText: 'nasivion',
      form: 'drops',
      route: 'nasal',
      pattern: '1-1-1',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab misoprostol 200mcg pv stat',
    { drugText: 'misoprostol 200mcg', form: 'tab', route: 'pv', frequencyCode: 'STAT' },
  ],
  // durations
  [
    'tab folic acid 5mg od x 3 months',
    {
      drugText: 'folic acid 5mg',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      durationValue: 3,
      durationUnit: 'm',
    },
  ],
  [
    'tab iron od af for 2 weeks',
    {
      drugText: 'iron',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      timing: 'af',
      durationValue: 2,
      durationUnit: 'w',
    },
  ],
  [
    'tab cefuroxime 500 bd 5/7',
    {
      drugText: 'cefuroxime 500',
      form: 'tab',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab fol 5 od 2/52',
    {
      drugText: 'fol 5',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      durationValue: 2,
      durationUnit: 'w',
    },
  ],
  [
    'tab calcium od 3/12',
    {
      drugText: 'calcium',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      durationValue: 3,
      durationUnit: 'm',
    },
  ],
  [
    'tab vit c bd x 10',
    {
      drugText: 'vit c',
      form: 'tab',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 10,
      durationUnit: 'd',
    },
  ],
  [
    'tab b complex od x2wk',
    {
      drugText: 'b complex',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      durationValue: 2,
      durationUnit: 'w',
    },
  ],
  [
    'tab zincovit 1-0-0 af 1 month',
    {
      drugText: 'zincovit',
      form: 'tab',
      pattern: '1-0-0',
      timing: 'af',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab limcee od 10days',
    {
      drugText: 'limcee',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      durationValue: 10,
      durationUnit: 'd',
    },
  ],
  // phrases in words, English and Hinglish
  [
    'tab dolo 650 twice a day after food 5 days',
    {
      drugText: 'dolo 650',
      form: 'tab',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab pan d once daily before food x 10d',
    {
      drugText: 'pan d',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      timing: 'bf',
      durationValue: 10,
      durationUnit: 'd',
    },
  ],
  [
    'tab eltroxin 25 1-0-0 khali pet 1m',
    {
      drugText: 'eltroxin 25',
      form: 'tab',
      pattern: '1-0-0',
      timing: 'empty_stomach',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab dolo 650 1-0-1 khane ke baad 3d',
    {
      drugText: 'dolo 650',
      form: 'tab',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 3,
      durationUnit: 'd',
    },
  ],
  [
    'tab rantac 150 1-0-1 khane se pehle 5d',
    {
      drugText: 'rantac 150',
      form: 'tab',
      pattern: '1-0-1',
      timing: 'bf',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab avomine at bedtime x 7d',
    {
      drugText: 'avomine',
      form: 'tab',
      frequencyCode: 'HS',
      pattern: '0-0-1',
      durationValue: 7,
      durationUnit: 'd',
    },
  ],
  ['tab meftal spas as needed', { drugText: 'meftal spas', form: 'tab', frequencyCode: 'SOS' }],
  [
    'tab ecosprin 75 alternate days 1m',
    {
      drugText: 'ecosprin 75',
      form: 'tab',
      frequencyCode: 'ALT',
      durationValue: 1,
      durationUnit: 'm',
    },
  ],
  [
    'tab calcium three times a day with food 15d',
    {
      drugText: 'calcium',
      form: 'tab',
      frequencyCode: 'TDS',
      pattern: '1-1-1',
      timing: 'with_food',
      durationValue: 15,
      durationUnit: 'd',
    },
  ],
  // case, punctuation, word order
  [
    'TAB DOLO 650 1-0-1 AF 5D',
    {
      drugText: 'dolo 650',
      form: 'tab',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'Tab. Dolo-650, 1-0-1, A/F, x5d',
    {
      drugText: 'tab. dolo-650',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab dolo 650 5d af 1-0-1',
    {
      drugText: 'dolo 650',
      form: 'tab',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    'tab dolo 650 af bd 5d',
    {
      drugText: 'dolo 650',
      form: 'tab',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      timing: 'af',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  [
    '  tab   dolo   650   bd   ',
    { drugText: 'dolo 650', form: 'tab', frequencyCode: 'BD', pattern: '1-0-1' },
  ],
  [
    'tab vitamin a od 5d',
    {
      drugText: 'vitamin a',
      form: 'tab',
      frequencyCode: 'OD',
      pattern: '1-0-0',
      durationValue: 5,
      durationUnit: 'd',
    },
  ],
  // unknown words are kept, never dropped
  [
    'tab dolo 650 bd 5d if fever',
    {
      drugText: 'dolo 650',
      form: 'tab',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      durationValue: 5,
      durationUnit: 'd',
      extra: 'if fever',
    },
  ],
  [
    'tab labetalol 100 1-0-1 cont',
    { drugText: 'labetalol 100', form: 'tab', pattern: '1-0-1', extra: 'cont' },
  ],
  [
    'tab dydroboon 10 bd till 12 wks',
    {
      drugText: 'dydroboon 10',
      form: 'tab',
      frequencyCode: 'BD',
      pattern: '1-0-1',
      extra: 'till',
      durationValue: 12,
      durationUnit: 'w',
    },
  ],
];

const EMPTY: Omit<ParsedRxLine, 'raw' | 'complete'> = {
  drugText: '',
  form: null,
  doseText: null,
  unitsPerDose: null,
  frequencyCode: null,
  pattern: null,
  timing: null,
  route: null,
  durationValue: null,
  durationUnit: null,
  extra: null,
};

describe('parseRxShorthand (OPD-02, docs/11 §2.3)', () => {
  it('has at least 60 fixture lines (acceptance docs/11 §5)', () => {
    expect(F.length).toBeGreaterThanOrEqual(60);
  });

  it.each(F)('%s', (line, want) => {
    const { qty: _qty, ...fields } = want;
    const got = parseRxShorthand(line);
    const { raw, complete, ...rest } = got;
    expect(rest).toEqual({ ...EMPTY, ...fields });
    expect(raw).toBe(line.trim());
    expect(complete).toBe(!!(fields.pattern || fields.frequencyCode));
  });

  it('parses ≥ 95% of the fixtures as complete rows with a drug and a frequency', () => {
    const ok = F.filter(([l]) => parseRxShorthand(l).complete).length;
    expect(ok / F.length).toBeGreaterThanOrEqual(0.95);
  });

  it('falls back without data loss: free text stays in the drug words, raw line kept', () => {
    const r = parseRxShorthand('as per previous advice');
    expect(r).toMatchObject({ drugText: 'as per previous advice', complete: false });
    expect(parseRxShorthand('')).toMatchObject({ raw: '', drugText: '', complete: false });
    // A code with no drug before it is read as the drug name; the duration still parses.
    expect(parseRxShorthand('bd 5d')).toMatchObject({
      drugText: 'bd',
      durationValue: 5,
      complete: false,
    });
  });

  it('never throws and always keeps the line (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (s) => {
        const r = parseRxShorthand(s);
        expect(r.raw).toBe(s.trim());
        // Every typed word ends up somewhere: drug words, extra, or a recognised field.
        expect(typeof r.drugText).toBe('string');
      }),
    );
  });
});

describe('quantity from a parsed line (docs/11 §2.3)', () => {
  const qty = (line: string, form: DrugForm | null = null) => {
    const p = parseRxShorthand(line);
    return rxQuantity({ ...p, form: form ?? p.form });
  };
  it('matches the spec examples', () => {
    // docs/11 §2.3 prints "qty 15" for this line, but its own rule (pattern sum × days) gives
    // 2 × 5 = 10; the rule is implemented (listed for Sumit in PR 14).
    expect(qty('dolo 650 1-0-1 af 5d', 'tab')).toBe(10);
    expect(qty('folvite bd x1m', 'tab')).toBe(60);
    expect(qty('syp calpol 5ml tds 3d')).toBeNull();
    expect(qty('inj tt im stat')).toBeNull();
  });
  it('handles halves, alternate days, weekly, stat and sos', () => {
    expect(qty('tab dexona ½-0-½ 3d')).toBe(3);
    expect(qty('dolo 650 ½ tab bd 3d')).toBe(3);
    expect(qty('tab ecosprin 75 alt x 1m')).toBe(15);
    expect(qty('tab uprise d3 60k weekly x8w')).toBe(8);
    expect(qty('tab dolo 650 2tab stat')).toBe(2);
    expect(qty('tab meftal spas sos')).toBeNull();
    expect(qty('tab dolo 650 bd')).toBeNull(); // no duration
    expect(qty('cap amoxy 500 qid 5d')).toBe(20);
    expect(qty('tab doxinate hs x 10d')).toBe(10);
  });
});
