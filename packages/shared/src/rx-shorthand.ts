import type { DrugForm } from './masters';
import {
  CODE_PATTERN,
  PATTERN_RE,
  type DurationUnit,
  type FrequencyCode,
  type RxRoute,
  type RxTiming,
} from './rx';

/**
 * Rx shorthand line (OPD-02, docs/11 §2.3, docs/05 §2): the assistant types one line per drug the
 * way doctors abbreviate it, e.g. `dolo 650 1-0-1 af 5d`, `folvite bd x1m`, `syp calpol 5ml tds 3d`,
 * `inj tt im stat`. Grammar: `<drug words> [dose] [pattern|code] [timing] [route] [duration]`; the
 * parts after the drug words may come in any order. The parser is pure and never throws: a word it
 * does not know is kept in `extra` (and the whole line in `raw`), so a failed parse falls back to a
 * manual row without losing anything (docs/11 §5).
 *
 * Built from synthetic fixtures (docs/50 §4): extend the tables below when the hospital's real Rx
 * lines arrive, and add each new line to the fixture test.
 */

export interface ParsedRxLine {
  raw: string;
  /** Words to look the drug up with (form prefix removed, strength kept: `dolo 650`). */
  drugText: string;
  /** Form named by a word of the line (`tab`, `syp`, `inj`…). */
  form: DrugForm | null;
  /** Amount per administration when written: `5 ml`, `½ tab`, `2 puffs`, `10 units`. */
  doseText: string | null;
  /** Units per administration of a solid form (`½ tab bd` → 0.5), for the quantity. */
  unitsPerDose: number | null;
  frequencyCode: FrequencyCode | null;
  pattern: string | null;
  timing: RxTiming | null;
  route: RxRoute | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  /** Words after the drug that were not understood, in the order typed. */
  extra: string | null;
  /** A drug and a frequency (pattern or code) were found. */
  complete: boolean;
}

// ---------------------------------------------------------------- word tables

const FORM_WORDS: Record<string, DrugForm> = {
  tab: 'tab',
  tabs: 'tab',
  tablet: 'tab',
  cap: 'cap',
  caps: 'cap',
  capsule: 'cap',
  syp: 'syp',
  syr: 'syp',
  syrup: 'syp',
  susp: 'syp',
  suspension: 'syp',
  inj: 'inj',
  injection: 'inj',
  drop: 'drops',
  drops: 'drops',
  drp: 'drops',
  gtt: 'drops',
  cream: 'cream',
  crm: 'cream',
  oint: 'cream',
  ointment: 'cream',
  gel: 'cream',
  lotion: 'cream',
  pess: 'pessary',
  pessary: 'pessary',
  sachet: 'sachet',
  sach: 'sachet',
  inh: 'inhaler',
  inhaler: 'inhaler',
};

const CODE_WORDS: Record<string, FrequencyCode> = {
  od: 'OD',
  qd: 'OD',
  daily: 'OD',
  bd: 'BD',
  bid: 'BD',
  tds: 'TDS',
  tid: 'TDS',
  qid: 'QID',
  qds: 'QID',
  hs: 'HS',
  sos: 'SOS',
  prn: 'SOS',
  stat: 'STAT',
  weekly: 'WEEKLY',
  wkly: 'WEEKLY',
  alt: 'ALT',
  eod: 'ALT',
};

const TIMING_WORDS: Record<string, RxTiming> = {
  af: 'af',
  'a/f': 'af',
  pc: 'af',
  bf: 'bf',
  'b/f': 'bf',
  ac: 'bf',
  wf: 'with_food',
  'w/f': 'with_food',
  es: 'empty_stomach',
  'e/s': 'empty_stomach',
};

const ROUTE_WORDS: Record<string, RxRoute> = {
  po: 'oral',
  oral: 'oral',
  im: 'im',
  iv: 'iv',
  sc: 'sc',
  's/c': 'sc',
  sl: 'sl',
  pv: 'pv',
  pr: 'pr',
  la: 'topical',
  local: 'topical',
  neb: 'inhalation',
  nasal: 'nasal',
  eye: 'eye',
  ear: 'ear',
};

/** Dose units as typed → as shown. */
const DOSE_UNITS: Record<string, string> = {
  ml: 'ml',
  tsf: 'tsf',
  tsp: 'tsf',
  drop: 'drops',
  drops: 'drops',
  puff: 'puffs',
  puffs: 'puffs',
  u: 'units',
  iu: 'units',
  unit: 'units',
  units: 'units',
  tab: 'tab',
  tabs: 'tab',
  cap: 'cap',
  caps: 'cap',
  sachet: 'sachet',
};
/** Unit counts of solid forms; more than this many tablets in one dose is a strength, not a dose. */
const SOLID_DOSE_UNITS: Record<string, DrugForm> = { tab: 'tab', cap: 'cap', sachet: 'sachet' };
const MAX_SOLID_COUNT = 4;

const DURATION_WORDS: Record<string, DurationUnit> = {
  d: 'd',
  day: 'd',
  days: 'd',
  w: 'w',
  wk: 'w',
  wks: 'w',
  week: 'w',
  weeks: 'w',
  m: 'm',
  mo: 'm',
  mon: 'm',
  month: 'm',
  months: 'm',
};
/** Medical shorthand `5/7` = 5 days, `2/52` = 2 weeks, `1/12` = 1 month. */
const DURATION_DENOMINATORS: Record<string, DurationUnit> = { '7': 'd', '52': 'w', '12': 'm' };

/** Connecting words with no meaning of their own. */
const FILLER = new Set(['x', 'for', '-', '+', 'then']);
/** Strength units: a number followed by one of these is part of the drug name (`0.5 mg`). */
const STRENGTH_UNITS = new Set(['mg', 'mcg', 'g', 'gm', 'k', 'iu/ml', 'mg/ml', '%']);

/**
 * Phrases written in words (English and Hinglish) → the code they mean. Applied to the lower-cased
 * line before it is split into words.
 */
const PHRASES: [RegExp, string][] = [
  [/\b(?:after (?:food|meals?)|khane ke baad|khana ke baad|khane ke bad)\b/g, ' af '],
  [/\b(?:before (?:food|meals?)|khane se pehle|khane se pahle)\b/g, ' bf '],
  [/\b(?:with (?:food|meals?)|khane ke saath|khane ke sath)\b/g, ' wf '],
  [/\b(?:empty stomach|khali pet)\b/g, ' es '],
  [/\b(?:once (?:a|per) week|once weekly)\b/g, ' weekly '],
  [/\b(?:once (?:a|per) day|once daily)\b/g, ' od '],
  [/\b(?:twice (?:a|per) day|twice daily)\b/g, ' bd '],
  [/\b(?:thrice (?:a|per) day|thrice daily|three times (?:a|per) day)\b/g, ' tds '],
  [/\b(?:four times (?:a|per) day)\b/g, ' qid '],
  [/\b(?:at bed ?time|at night)\b/g, ' hs '],
  [/\b(?:as needed|if needed|when required|if required)\b/g, ' sos '],
  [/\b(?:alternate days?|every other day)\b/g, ' alt '],
];

const SLOT = '(?:\\d(?:\\.\\d{1,2})?|½|¼|¾|1\\/2)';
/** `1 - 0 - 1` / `1+0+1` written with spaces or plus signs → `1-0-1`. */
const SPACED_PATTERN = new RegExp(
  `(?<![\\w.\\/])(${SLOT})\\s*[-+]\\s*(${SLOT})\\s*[-+]\\s*(${SLOT})(?:\\s*[-+]\\s*(${SLOT}))?(?![\\w.\\/])`,
  'g',
);

const NUM = '(\\d{1,3}(?:\\.\\d{1,2})?|½|¼|¾|1\\/2|1\\/4)';
const RE_DOSE = new RegExp(`^${NUM}(${Object.keys(DOSE_UNITS).join('|')})$`);
const RE_DURATION = new RegExp(`^x?(\\d{1,3})(${Object.keys(DURATION_WORDS).join('|')})$`);
const RE_DURATION_SLASH = /^x?(\d{1,2})\/(7|52|12)$/;
const RE_X_NUMBER = /^x(\d{1,3})$/;
const RE_INT = /^\d{1,3}$/;
const RE_FRACTION = /^(?:½|¼|¾|1\/2|1\/4|0\.5|0\.25)$/;
const RE_NUMBER = new RegExp(`^${NUM}$`);

const numberValue = (s: string): number => {
  if (s === '½' || s === '1/2') return 0.5;
  if (s === '¼' || s === '1/4') return 0.25;
  if (s === '¾') return 0.75;
  return Number(s);
};
/** `1/2` and `0.5` show as `½`. */
const prettyNumber = (s: string) =>
  s === '1/2' || s === '0.5' ? '½' : s === '1/4' || s === '0.25' ? '¼' : s;

const normalisePattern = (p: string) => p.split('-').map(prettyNumber).join('-');

function tokenize(line: string): string[] {
  let s = line.normalize('NFKC').toLowerCase().replace(/[–—−]/g, '-').replace(/1⁄2/g, '½');
  for (const [re, code] of PHRASES) s = s.replace(re, code);
  s = s.replace(SPACED_PATTERN, (_m, a: string, b: string, c: string, d?: string) =>
    [a, b, c, d].filter(Boolean).join('-'),
  );
  return s.split(/[\s,;]+/).filter(Boolean);
}

/** Parses one shorthand line. Pure; never throws. */
export function parseRxShorthand(line: string): ParsedRxLine {
  const raw = line.trim();
  const words = tokenize(raw);
  const out: ParsedRxLine = {
    raw,
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
    complete: false,
  };
  const drug: string[] = [];
  const extra: string[] = [];
  /** False once the first instruction word is read: later unknown words are `extra`. */
  let inDrug = true;
  const hasDrug = () => drug.length > 0;

  const setDose = (n: string, unit: string) => {
    const shown = DOSE_UNITS[unit]!;
    const solid = SOLID_DOSE_UNITS[shown];
    // `½ tab` for tablets; liquids keep the decimals as typed (`0.5 ml`).
    out.doseText = `${solid ? prettyNumber(n) : n} ${shown}`;
    if (solid) {
      out.unitsPerDose = numberValue(n);
      out.form ??= solid;
    }
  };
  const setDuration = (n: string, unit: DurationUnit) => {
    out.durationValue = Number(n);
    out.durationUnit = unit;
  };
  /** A count of tablets/capsules is small; `650 tab` is a strength followed by the form word. */
  const isDoseCount = (n: string, unit: string) =>
    !SOLID_DOSE_UNITS[DOSE_UNITS[unit] ?? ''] || numberValue(n) <= MAX_SOLID_COUNT;

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    const instruction = () => {
      inDrug = false;
    };

    if (PATTERN_RE.test(w)) {
      out.pattern = normalisePattern(w);
      instruction();
      continue;
    }
    if (inDrug && RE_NUMBER.test(w) && next && STRENGTH_UNITS.has(next)) {
      drug.push(w, next);
      i++;
      continue;
    }
    if (hasDrug()) {
      // Instruction words only count once there is a drug name to apply them to.
      if (CODE_WORDS[w]) {
        out.frequencyCode = CODE_WORDS[w]!;
        instruction();
        continue;
      }
      if (TIMING_WORDS[w]) {
        out.timing = TIMING_WORDS[w]!;
        instruction();
        continue;
      }
      let m = RE_DURATION.exec(w) ?? null;
      if (m) {
        setDuration(m[1]!, DURATION_WORDS[m[2]!]!);
        instruction();
        continue;
      }
      m = RE_DURATION_SLASH.exec(w);
      if (m) {
        setDuration(m[1]!, DURATION_DENOMINATORS[m[2]!]!);
        instruction();
        continue;
      }
      m = RE_X_NUMBER.exec(w);
      if (m) {
        // `x5` (days), or `x5 days`.
        if (next && DURATION_WORDS[next]) {
          setDuration(m[1]!, DURATION_WORDS[next]);
          i++;
        } else setDuration(m[1]!, 'd');
        instruction();
        continue;
      }
      m = RE_DOSE.exec(w);
      if (m && isDoseCount(m[1]!, m[2]!)) {
        setDose(m[1]!, m[2]!);
        instruction();
        continue;
      }
      if (RE_NUMBER.test(w) && next) {
        if (DOSE_UNITS[next] && isDoseCount(w, next)) {
          setDose(w, next);
          instruction();
          i++;
          continue;
        }
        if (RE_INT.test(w) && DURATION_WORDS[next]) {
          setDuration(w, DURATION_WORDS[next]);
          instruction();
          i++;
          continue;
        }
      }
      if (RE_INT.test(w) && words[i - 1] === 'x') {
        setDuration(w, 'd');
        instruction();
        continue;
      }
      if (RE_FRACTION.test(w) || w === 'half') {
        const n = w === 'half' ? '½' : w;
        out.unitsPerDose = numberValue(n);
        out.doseText = prettyNumber(n);
        instruction();
        continue;
      }
    }
    if (ROUTE_WORDS[w]) {
      out.route = ROUTE_WORDS[w]!;
      if (hasDrug()) instruction();
      continue;
    }
    if (FORM_WORDS[w]) {
      // A form word anywhere names the form (`tab dolo`, `moxi eye drops`); repeats are ignored.
      out.form ??= FORM_WORDS[w];
      continue;
    }
    if (FILLER.has(w) && (hasDrug() || !inDrug)) continue;
    if (inDrug) drug.push(w);
    else extra.push(w);
  }

  // A code with a pattern fills it in (`bd` → 1-0-1); an explicit pattern wins.
  if (!out.pattern && out.frequencyCode) out.pattern = CODE_PATTERN[out.frequencyCode] ?? null;
  // A bare fraction is a part of a tablet when the form is solid (`dolo ½ bd`).
  if (out.doseText && /^[½¼¾\d.]+$/.test(out.doseText) && out.form && SOLID_DOSE_UNITS[out.form]) {
    out.doseText = `${out.doseText} ${out.form}`;
  }
  out.drugText = drug.join(' ');
  out.extra = extra.length > 0 ? extra.join(' ') : null;
  out.complete = out.drugText.length > 0 && (!!out.pattern || !!out.frequencyCode);
  return out;
}
