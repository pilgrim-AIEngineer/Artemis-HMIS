/**
 * PCPNDT forbidden-term list (docs/30-compliance.md §1, AGENTS.md rule 7).
 *
 * This file is the single source of truth for:
 *  - `pnpm check:forbidden` (CI scan of schema, templates, seed data, i18n, AI prompts), and
 *  - the runtime guard used by the USG template editor (`findForbiddenTerms`).
 *
 * It is the ONLY source file allow-listed by the checker, because it has to spell the terms out.
 * Every term carries `examples` so tests can prove the pattern works without repeating the
 * terms anywhere else in the repo.
 *
 * Tiers:
 *  - `always`: unambiguous references to the sex of a fetus. Applied to every scanned file.
 *  - `strict`: terms that are only forbidden in USG / Form F / AI-prompt scope (e.g. the Hindi
 *    word for "sex" is a normal patient-registration label, and newborn sex is normal data).
 *    Applied together with `always` terms inside that scope.
 */

export type ForbiddenTier = 'always' | 'strict';

export interface ForbiddenTerm {
  /** Neutral code (pn01…) so the id itself never spells a term. */
  id: string;
  tier: ForbiddenTier;
  pattern: RegExp;
  /** Strings that must match `pattern` (used by tests). */
  examples: readonly string[];
}

const term = (
  id: string,
  tier: ForbiddenTier,
  source: string,
  examples: readonly string[],
): ForbiddenTerm => ({
  id,
  tier,
  // NFC so Devanagari nukta forms (precomposed vs combining) compare equal.
  pattern: new RegExp(source.normalize('NFC'), 'iu'),
  examples,
});

// Building blocks shared by the patterns below. `s3x` covers the common leetspeak spelling.
const FETUS = String.raw`(?:fo?etus|fo?etal|fo?etuses|unborn(?:\s+(?:child|baby))?)`;
const SEX = String.raw`(?:s[e3]x|gender)`;
const BABY = String.raw`(?:baby|babies)`;
const GENDERED = String.raw`(?:male|female|boy|girl|m\s*/\s*f)`;

export const FORBIDDEN_TERMS: readonly ForbiddenTerm[] = [
  term('pn01', 'always', String.raw`fetal\s*sex`, ['fetal sex', 'Fetal  Sex']),
  term('pn02', 'always', String.raw`foetal\s*sex`, ['foetal sex']),
  term('pn03', 'always', String.raw`\bs[e3]x\s+of\s+(the\s+)?fo?etus`, [
    'sex of fetus',
    'sex of the foetus',
  ]),
  term('pn04', 'always', String.raw`\bgender\s+of\s+(the\s+)?fo?etus`, [
    'gender of the fetus',
    'gender of foetus',
  ]),
  term('pn05', 'always', String.raw`fo?etal\s*gender`, ['fetal gender', 'foetal gender']),
  term('pn06', 'always', String.raw`male\s+fo?etus`, ['male fetus', 'male foetus']),
  term('pn07', 'always', String.raw`female\s+fo?etus`, ['female fetus']),
  term('pn08', 'always', String.raw`भ्रूण.*लिंग`, ['भ्रूण का लिंग']),
  term('pn09', 'always', String.raw`\b${BABY}\s*${SEX}\b`, ['baby gender', 'baby sex']),
  term('pn10', 'strict', String.raw`boy\s+or\s+girl`, ['boy or girl', 'Boy Or Girl']),
  term('pn11', 'strict', String.raw`\bl(?:ar|ad|add)ka\b`, [
    'ladka',
    'LADKA hai',
    'laddka',
    'larka',
  ]),
  term('pn12', 'strict', String.raw`\bl(?:ar|ad|add)ki\b`, ['ladki', 'laddki', 'larki']),
  term('pn13', 'strict', 'लड़का', ['लड़का', '\u0932\u095C\u0915\u093E']),
  term('pn14', 'strict', 'लड़की', ['लड़की', '\u0932\u095C\u0915\u0940']),
  term('pn15', 'strict', 'लिंग', ['लिंग']),
  // Variants added for issue #13.
  term('pn16', 'always', String.raw`\b${FETUS}\s*[:=\-]?\s*${SEX}\b`, [
    'fetus sex',
    'fetus gender',
    'unborn child sex',
  ]),
  term('pn17', 'always', String.raw`\b${SEX}\s+of\s+(the\s+)?(${FETUS}|${BABY})`, [
    'sex of baby',
    'gender of the baby',
    'sex of the unborn child',
  ]),
  term('pn18', 'always', String.raw`\b${FETUS}\s*[:=\-]?\s*(is\s+)?${GENDERED}\b`, [
    'fetus: male',
    'fetus is girl',
  ]),
  term('pn19', 'always', String.raw`\b${GENDERED}\s+(${FETUS}|${BABY}\s+in\s+utero)`, [
    'M/F fetus',
    'girl unborn child',
  ]),
  term('pn20', 'always', String.raw`\bs[e3]x\s*determination\b`, ['sex determination']),
  term('pn21', 'always', 'बेटा|बेटी', ['बेटा', 'बेटी', 'पेट में बेटा']),
  term('pn22', 'always', 'लिंग\\s*(निर्धारण|परीक्षण|जांच|जाँच|पता)', [
    'लिंग निर्धारण',
    'लिंग परीक्षण',
  ]),
  term('pn23', 'always', String.raw`\b(?:garbh|bhrun|bhroon)\s+(?:ka|ki|ke)?\s*ling\b`, [
    'garbh ka ling',
    'bhrun ka ling',
  ]),
];

/**
 * Exact key paths that may contain `strict` terms. `[]` marks an array element; it is matched
 * with or without the brackets so the same key works in schema JSON and in i18n objects.
 * Only `strict` terms are waived; `always` terms are never allowed.
 */
export const ALLOWED_KEY_PATHS: readonly string[] = [
  // Form F: sex of the woman's already-born living children (required by the form).
  'living_children[].sex',
];

export interface ForbiddenHit {
  termId: string;
  tier: ForbiddenTier;
  match: string;
}

/**
 * Text variants that are matched: the raw text plus a version with identifiers split into
 * words, so `fetalSex`, `fetal_sex`, `FETAL-SEX` are caught like `fetal sex`.
 */
export function matchVariants(text: string): string[] {
  const nfc = foldText(text);
  const split = nfc
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/[_\-./]+/g, ' ');
  return split === nfc ? [nfc] : [nfc, split];
}

// Cyrillic / Greek letters that render like Latin ones (lowercase and uppercase).
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  ѕ: 's',
  ј: 'j',
  һ: 'h',
  ԁ: 'd',
  ɡ: 'g',
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  І: 'I',
  Ѕ: 'S',
  ο: 'o',
  α: 'a',
  ε: 'e',
  ι: 'i',
  ν: 'v',
  τ: 't',
  ρ: 'p',
  Ο: 'O',
  Α: 'A',
  Ε: 'E',
  Ι: 'I',
  Τ: 'T',
  Μ: 'M',
};
const LIGATURES: Readonly<Record<string, string>> = { œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE' };

/**
 * Defeats trivial evasions: compatibility forms (full-width, ligature glyphs), invisible format
 * characters (zero-width space/joiner, soft hyphen, bidi marks), Latin diacritics and
 * Cyrillic/Greek look-alikes. Devanagari combining marks are preserved.
 */
function foldText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[œŒæÆ]/gu, (c) => LIGATURES[c] ?? c)
    .replace(/[\u0370-\u03ff\u0400-\u04ff\u0500-\u052f\u0250-\u02af]/gu, (c) => CONFUSABLES[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC');
}

/**
 * Returns every forbidden term found in `text`. `tier: 'strict'` checks all terms,
 * `tier: 'always'` only the unambiguous ones. Used by the CI scan and by runtime guards
 * (USG template editor field labels/keys, AI output).
 */
export function findForbiddenTerms(
  text: string,
  options: { tier?: ForbiddenTier } = {},
): ForbiddenHit[] {
  const tier = options.tier ?? 'strict';
  const variants = matchVariants(text);
  const hits: ForbiddenHit[] = [];
  for (const t of FORBIDDEN_TERMS) {
    if (tier === 'always' && t.tier !== 'always') continue;
    for (const v of variants) {
      const m = t.pattern.exec(v);
      if (m) {
        hits.push({ termId: t.id, tier: t.tier, match: m[0] });
        break;
      }
    }
  }
  return hits;
}

export function containsForbiddenTerm(text: string, options: { tier?: ForbiddenTier } = {}) {
  return findForbiddenTerms(text, options).length > 0;
}

/** i18n key returned when free text carries a forbidden term; never echoes the text (rule 15). */
export const FORBIDDEN_TERM_MESSAGE = 'validation.forbiddenTerm';

/**
 * zod `.refine` arguments for the runtime input guard (AGENTS.md rule 7, docs/30 §1, D-10).
 * `always` for general free text; `strict` for USG/ANC/MTP/Form F contexts.
 */
export const noForbiddenTerms = (tier: ForbiddenTier = 'always') =>
  [
    (s: string) => !containsForbiddenTerm(s, { tier }),
    { message: FORBIDDEN_TERM_MESSAGE },
  ] as const;

export function isAllowedKeyPath(keyPath: string): boolean {
  const strip = (p: string) => p.replaceAll('[]', '');
  const path = strip(keyPath);
  return ALLOWED_KEY_PATHS.some((allowed) => {
    const a = strip(allowed);
    return path === a || path.endsWith(`.${a}`);
  });
}
