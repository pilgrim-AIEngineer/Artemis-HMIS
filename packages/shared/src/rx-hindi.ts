import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import type { DurationUnit, FrequencyCode, RxRoute, RxTiming } from './rx';

/**
 * Patient instructions for a prescription row (OPD-03, docs/11 §2.3): Hindi for the patient
 * (`1-0-1, खाने के बाद, 5 दिन`) and English for staff, built from the structured row. The Hindi
 * phrases are a mapping table the hospital can reword (setting `rx.hindiPhrases`, Admin →
 * Settings); drug names stay in English on prints (docs/05 §6).
 */

export const RX_PHRASE_KEYS = [
  'timing.af',
  'timing.bf',
  'timing.with_food',
  'timing.empty_stomach',
  'code.HS',
  'code.SOS',
  'code.STAT',
  'code.WEEKLY',
  'code.ALT',
  'route.im',
  'route.iv',
  'route.sc',
  'route.sl',
  'route.pv',
  'route.pr',
  'route.topical',
  'route.inhalation',
  'route.nasal',
  'route.eye',
  'route.ear',
  'duration.d',
  'duration.w',
  'duration.m1',
  'duration.m',
  'dose.tab',
  'dose.cap',
  'dose.ml',
  'dose.drops',
  'dose.puffs',
  'dose.units',
  'dose.sachet',
  'dose.tsf',
] as const;
export type RxPhraseKey = (typeof RX_PHRASE_KEYS)[number];
export type RxPhrases = Record<RxPhraseKey, string>;

/** `{n}` is replaced by the number. */
export const DEFAULT_RX_PHRASES_HI: RxPhrases = {
  'timing.af': 'खाने के बाद',
  'timing.bf': 'खाने से पहले',
  'timing.with_food': 'खाने के साथ',
  'timing.empty_stomach': 'खाली पेट',
  'code.HS': 'रात को सोते समय',
  'code.SOS': 'ज़रूरत पड़ने पर',
  'code.STAT': 'तुरंत, एक बार',
  'code.WEEKLY': 'हफ़्ते में एक बार',
  'code.ALT': 'एक दिन छोड़कर',
  'route.im': 'मांसपेशी में इंजेक्शन',
  'route.iv': 'नस में',
  'route.sc': 'त्वचा के नीचे',
  'route.sl': 'जीभ के नीचे',
  'route.pv': 'योनि मार्ग में',
  'route.pr': 'गुदा मार्ग में',
  'route.topical': 'लगाने के लिए',
  'route.inhalation': 'साँस से',
  'route.nasal': 'नाक में',
  'route.eye': 'आँख में',
  'route.ear': 'कान में',
  'duration.d': '{n} दिन',
  'duration.w': '{n} सप्ताह',
  'duration.m1': '{n} महीना',
  'duration.m': '{n} महीने',
  'dose.tab': '{n} गोली',
  'dose.cap': '{n} कैप्सूल',
  'dose.ml': '{n} ml',
  'dose.drops': '{n} बूँद',
  'dose.puffs': '{n} पफ़',
  'dose.units': '{n} यूनिट',
  'dose.sachet': '{n} पाउच',
  'dose.tsf': '{n} चम्मच',
};

export const RX_PHRASES_EN: RxPhrases = {
  'timing.af': 'after food',
  'timing.bf': 'before food',
  'timing.with_food': 'with food',
  'timing.empty_stomach': 'empty stomach',
  'code.HS': 'at bedtime',
  'code.SOS': 'when needed',
  'code.STAT': 'at once, single dose',
  'code.WEEKLY': 'once a week',
  'code.ALT': 'on alternate days',
  'route.im': 'IM injection',
  'route.iv': 'IV',
  'route.sc': 'under the skin (SC)',
  'route.sl': 'under the tongue',
  'route.pv': 'per vaginum',
  'route.pr': 'per rectum',
  'route.topical': 'apply locally',
  'route.inhalation': 'inhale',
  'route.nasal': 'in the nose',
  'route.eye': 'in the eye',
  'route.ear': 'in the ear',
  'duration.d': '{n} days',
  'duration.w': '{n} weeks',
  'duration.m1': '{n} month',
  'duration.m': '{n} months',
  'dose.tab': '{n} tab',
  'dose.cap': '{n} cap',
  'dose.ml': '{n} ml',
  'dose.drops': '{n} drops',
  'dose.puffs': '{n} puffs',
  'dose.units': '{n} units',
  'dose.sachet': '{n} sachet',
  'dose.tsf': '{n} tsf',
};

/** `rx.hindiPhrases`: only the phrases the hospital rewords; the rest keep the default. */
export const rxPhrasesOverrideSchema = z.partialRecord(
  z.enum(RX_PHRASE_KEYS),
  z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine(...noForbiddenTerms('always')),
);
export type RxPhrasesOverride = z.infer<typeof rxPhrasesOverrideSchema>;

export interface InstructionInput {
  doseText: string | null;
  frequencyCode: FrequencyCode | null;
  pattern: string | null;
  timing: RxTiming | null;
  route: RxRoute | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  /** Words the parser kept but did not understand; printed as typed. */
  extra?: string | null;
}

const fill = (phrase: string, n: string | number) => phrase.replaceAll('{n}', String(n));

/** `5 ml` → the dose phrase of its unit; anything else is shown as typed. */
function dosePhrase(doseText: string, phrases: RxPhrases): string {
  const m = /^(\S+)\s+(tab|cap|ml|drops|puffs|units|sachet|tsf)$/.exec(doseText.trim());
  if (!m) return doseText.trim();
  return fill(phrases[`dose.${m[2]}` as RxPhraseKey], m[1]!);
}

function durationPhrase(value: number, unit: DurationUnit, phrases: RxPhrases, en: boolean) {
  if (unit === 'm') return fill(phrases[value === 1 ? 'duration.m1' : 'duration.m'], value);
  if (en && value === 1) return unit === 'd' ? '1 day' : '1 week';
  return fill(phrases[`duration.${unit}`], value);
}

/**
 * `1-0-1, खाने के बाद, 5 दिन`: dose (when written), pattern or code, timing, route, duration,
 * then any extra words. Pure. A pattern is shown as written, since patients read `1-0-1` on paper;
 * HS / SOS / STAT / weekly / alternate days add their phrase.
 */
export function buildInstruction(
  i: InstructionInput,
  lang: 'hi' | 'en',
  overrides: RxPhrasesOverride = {},
): string {
  const phrases: RxPhrases =
    lang === 'hi' ? { ...DEFAULT_RX_PHRASES_HI, ...overrides } : RX_PHRASES_EN;
  const parts: string[] = [];
  if (i.doseText) parts.push(dosePhrase(i.doseText, phrases));
  if (i.pattern) parts.push(i.pattern);
  const code = i.frequencyCode;
  if (code === 'HS' || code === 'SOS' || code === 'STAT' || code === 'WEEKLY' || code === 'ALT') {
    parts.push(phrases[`code.${code}`]);
  }
  if (i.timing && i.timing !== 'any') parts.push(phrases[`timing.${i.timing}`]);
  if (i.route && i.route !== 'oral') parts.push(phrases[`route.${i.route}`]);
  if (i.durationValue && i.durationUnit) {
    parts.push(durationPhrase(i.durationValue, i.durationUnit, phrases, lang === 'en'));
  }
  if (i.extra?.trim()) parts.push(i.extra.trim());
  return parts.join(', ');
}
