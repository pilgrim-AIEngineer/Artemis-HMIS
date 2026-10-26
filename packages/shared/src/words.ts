import { PAISE_PER_RUPEE, type Paise } from './money';

/**
 * Amount in words for money confirmations and receipts (docs/05 §1.9: "₹1,250 — एक हज़ार दो सौ
 * पचास रुपये"). Indian grouping: thousand, lakh, crore (crores repeat above 99 crore). Pure and
 * bigint-only, like the rest of the money code.
 */

const EN_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;
const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;

/** Hindi has a distinct word for every number 0–99. */
const HI_0_99 = [
  'शून्य',
  'एक',
  'दो',
  'तीन',
  'चार',
  'पाँच',
  'छह',
  'सात',
  'आठ',
  'नौ',
  'दस',
  'ग्यारह',
  'बारह',
  'तेरह',
  'चौदह',
  'पंद्रह',
  'सोलह',
  'सत्रह',
  'अठारह',
  'उन्नीस',
  'बीस',
  'इक्कीस',
  'बाईस',
  'तेईस',
  'चौबीस',
  'पच्चीस',
  'छब्बीस',
  'सत्ताईस',
  'अट्ठाईस',
  'उनतीस',
  'तीस',
  'इकतीस',
  'बत्तीस',
  'तैंतीस',
  'चौंतीस',
  'पैंतीस',
  'छत्तीस',
  'सैंतीस',
  'अड़तीस',
  'उनतालीस',
  'चालीस',
  'इकतालीस',
  'बयालीस',
  'तैंतालीस',
  'चवालीस',
  'पैंतालीस',
  'छियालीस',
  'सैंतालीस',
  'अड़तालीस',
  'उनचास',
  'पचास',
  'इक्यावन',
  'बावन',
  'तिरपन',
  'चौवन',
  'पचपन',
  'छप्पन',
  'सत्तावन',
  'अट्ठावन',
  'उनसठ',
  'साठ',
  'इकसठ',
  'बासठ',
  'तिरसठ',
  'चौंसठ',
  'पैंसठ',
  'छियासठ',
  'सड़सठ',
  'अड़सठ',
  'उनहत्तर',
  'सत्तर',
  'इकहत्तर',
  'बहत्तर',
  'तिहत्तर',
  'चौहत्तर',
  'पचहत्तर',
  'छिहत्तर',
  'सतहत्तर',
  'अठहत्तर',
  'उन्यासी',
  'अस्सी',
  'इक्यासी',
  'बयासी',
  'तिरासी',
  'चौरासी',
  'पचासी',
  'छियासी',
  'सत्तासी',
  'अट्ठासी',
  'नवासी',
  'नब्बे',
  'इक्यानवे',
  'बानवे',
  'तिरानवे',
  'चौरानवे',
  'पचानवे',
  'छियानवे',
  'सत्तानवे',
  'अट्ठानवे',
  'निन्यानवे',
] as const;

interface Lang {
  small: (n: number) => string;
  hundred: string;
  thousand: string;
  lakh: string;
  crore: string;
}

const EN: Lang = {
  small: (n) => {
    if (n < 20) return EN_ONES[n]!;
    const t = EN_TENS[Math.floor(n / 10)]!;
    return n % 10 ? `${t}-${EN_ONES[n % 10]}` : t;
  },
  hundred: 'hundred',
  thousand: 'thousand',
  lakh: 'lakh',
  crore: 'crore',
};

const HI: Lang = {
  small: (n) => HI_0_99[n]!,
  hundred: 'सौ',
  thousand: 'हज़ार',
  lakh: 'लाख',
  crore: 'करोड़',
};

/** Words for a positive integer in the Indian system (no "zero"; callers handle 0). */
function integerWords(n: bigint, l: Lang): string[] {
  const out: string[] = [];
  const crore = n / 10_000_000n;
  let rest = n % 10_000_000n;
  if (crore > 0n) out.push(...integerWords(crore, l), l.crore);
  const lakh = Number(rest / 100_000n);
  rest %= 100_000n;
  if (lakh) out.push(l.small(lakh), l.lakh);
  const thousand = Number(rest / 1000n);
  rest %= 1000n;
  if (thousand) out.push(l.small(thousand), l.thousand);
  const hundred = Number(rest / 100n);
  const below = Number(rest % 100n);
  if (hundred) out.push(l.small(hundred), l.hundred);
  if (below) out.push(l.small(below));
  return out;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `125000n → "One thousand two hundred fifty rupees"`; paise as "and five paise". */
export function amountInWordsEn(paise: Paise): string {
  const neg = paise < 0n;
  const a = neg ? -paise : paise;
  const rupees = a / PAISE_PER_RUPEE;
  const p = Number(a % PAISE_PER_RUPEE);
  const parts: string[] = [];
  if (rupees > 0n || p === 0) {
    parts.push(
      rupees === 0n ? 'zero' : integerWords(rupees, EN).join(' '),
      rupees === 1n ? 'rupee' : 'rupees',
    );
  }
  if (p) parts.push(rupees > 0n ? 'and' : '', EN.small(p), p === 1 ? 'paisa' : 'paise');
  const text = parts.filter(Boolean).join(' ');
  return capitalise(neg ? `minus ${text}` : text);
}

/** `125000n → "एक हज़ार दो सौ पचास रुपये"`; paise as "और पाँच पैसे". */
export function amountInWordsHi(paise: Paise): string {
  const neg = paise < 0n;
  const a = neg ? -paise : paise;
  const rupees = a / PAISE_PER_RUPEE;
  const p = Number(a % PAISE_PER_RUPEE);
  const parts: string[] = [];
  if (rupees > 0n || p === 0) {
    parts.push(rupees === 0n ? HI.small(0) : integerWords(rupees, HI).join(' '), 'रुपये');
  }
  if (p) parts.push(rupees > 0n ? 'और' : '', HI.small(p), 'पैसे');
  const text = parts.filter(Boolean).join(' ');
  return neg ? `ऋण ${text}` : text;
}

export function amountInWords(paise: Paise, locale: 'en' | 'hi'): string {
  return locale === 'hi' ? amountInWordsHi(paise) : amountInWordsEn(paise);
}
