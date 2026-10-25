/**
 * Indian-name search normalisation (docs/01 §6). Two derived values are stored per patient:
 *  - `search_name_norm`: lowercase, accent-stripped, punctuation removed, spaces collapsed;
 *  - `search_name_phonetic`: `normaliseName` followed by the phonetic folding below, so that
 *    spelling variants (Sunita/Suneeta, Vijay/Wijay, Shyam/Syam, Poonam/Punam) share a key.
 * Both feed GIN trigram indexes; the client and the DB must derive them with this one function.
 */

// Latin combining marks only; Devanagari matras (U+093E…) must survive normalisation.
const LATIN_COMBINING = /[̀-ͯ]/g;
// Letters/digits of any script and Devanagari combining marks stay; everything else is a separator.
const NON_NAME = /[^\p{L}\p{N}\p{M}]+/gu;

export function normaliseName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(LATIN_COMBINING, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(NON_NAME, ' ')
    .trim();
}

/** Folds one already-normalised word. Order matters: digraphs first, then `h` removal, then doubles. */
function phoneticWord(word: string): string {
  return word
    .replace(/ph/g, 'f')
    .replace(/aa/g, 'a')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/sh/g, 's')
    .replace(/v/g, 'w')
    .replace(/z/g, 'j')
    .replace(/([bcdfgjklmnpqrstwxy])h+/g, '$1') // kh→k, th→t, ch→c, gh→g, dh→d, bh→b … (all h's: idempotent)
    .replace(/(\p{L})\1+/gu, '$1');
}

export function phoneticKey(input: string): string {
  return normaliseName(input).split(' ').filter(Boolean).map(phoneticWord).join(' ');
}

export interface NameSearchKeys {
  /** → `patient.search_name_norm` */
  norm: string;
  /** → `patient.search_name_phonetic` */
  phonetic: string;
}

export function nameSearchKeys(fullName: string): NameSearchKeys {
  const norm = normaliseName(fullName);
  return { norm, phonetic: norm.split(' ').filter(Boolean).map(phoneticWord).join(' ') };
}

/** pg_trgm trigram set: each word padded with two leading spaces and one trailing space. */
export function trigrams(input: string): Set<string> {
  const set = new Set<string>();
  for (const word of input.split(/\s+/).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
  }
  return set;
}

/** pg_trgm `similarity()` of two already-normalised strings (0…1); used for the duplicate check. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Phonetic similarity of two person names (docs/10 §3 duplicate rule: ≥ 0.6). */
export function phoneticSimilarity(a: string, b: string): number {
  return trigramSimilarity(phoneticKey(a), phoneticKey(b));
}
