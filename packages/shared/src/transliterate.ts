/**
 * Hindi-name suggestion for registration (docs/10 §3: "auto-transliterated suggestion, editable").
 * Names are looked up in a table of common Indian names first (reliable); anything else goes
 * through a rule-based Latin → Devanagari converter that is a best effort only. The receptionist
 * always sees and can edit the suggestion; it is never stored without being shown.
 */

const KNOWN: Readonly<Record<string, string>> = {
  sunita: 'सुनीता',
  anita: 'अनीता',
  poonam: 'पूनम',
  rekha: 'रेखा',
  meena: 'मीना',
  kavita: 'कविता',
  savita: 'सविता',
  pooja: 'पूजा',
  neha: 'नेहा',
  priya: 'प्रिया',
  shanti: 'शांति',
  geeta: 'गीता',
  seema: 'सीमा',
  radha: 'राधा',
  sarita: 'सरिता',
  asha: 'आशा',
  rani: 'रानी',
  kiran: 'किरण',
  manju: 'मंजू',
  nisha: 'निशा',
  devi: 'देवी',
  kumari: 'कुमारी',
  rajesh: 'राजेश',
  suresh: 'सुरेश',
  ramesh: 'रमेश',
  anil: 'अनिल',
  vijay: 'विजय',
  sanjay: 'संजय',
  manoj: 'मनोज',
  dinesh: 'दिनेश',
  rakesh: 'राकेश',
  ajay: 'अजय',
  mukesh: 'मुकेश',
  pradeep: 'प्रदीप',
  amit: 'अमित',
  rahul: 'राहुल',
  vikas: 'विकास',
  deepak: 'दीपक',
  sunil: 'सुनील',
  arun: 'अरुण',
  mohan: 'मोहन',
  gopal: 'गोपाल',
  ram: 'राम',
  shyam: 'श्याम',
  verma: 'वर्मा',
  singh: 'सिंह',
  yadav: 'यादव',
  gupta: 'गुप्ता',
  mishra: 'मिश्रा',
  sharma: 'शर्मा',
  pandey: 'पांडेय',
  tiwari: 'तिवारी',
  maurya: 'मौर्य',
  kushwaha: 'कुशवाहा',
  chauhan: 'चौहान',
  srivastava: 'श्रीवास्तव',
  dubey: 'दुबे',
  shukla: 'शुक्ला',
  patel: 'पटेल',
  kumar: 'कुमार',
  saxena: 'सक्सेना',
  rathore: 'राठौर',
  baby: 'बेबी',
  of: 'ऑफ़',
};

const CONSONANTS: readonly (readonly [string, string])[] = [
  ['chh', 'छ'],
  ['kh', 'ख'],
  ['gh', 'घ'],
  ['ch', 'च'],
  ['jh', 'झ'],
  ['th', 'थ'],
  ['dh', 'ध'],
  ['ph', 'फ'],
  ['bh', 'भ'],
  ['sh', 'श'],
  ['k', 'क'],
  ['g', 'ग'],
  ['c', 'क'],
  ['j', 'ज'],
  ['t', 'त'],
  ['d', 'द'],
  ['n', 'न'],
  ['p', 'प'],
  ['b', 'ब'],
  ['m', 'म'],
  ['y', 'य'],
  ['r', 'र'],
  ['l', 'ल'],
  ['v', 'व'],
  ['w', 'व'],
  ['s', 'स'],
  ['h', 'ह'],
  ['z', 'ज़'],
  ['f', 'फ़'],
  ['q', 'क़'],
  ['x', 'क्स'],
];

// Vowel spelling → [independent form, matra].
const VOWELS: readonly (readonly [string, string, string])[] = [
  ['aa', 'आ', 'ा'],
  ['ai', 'ऐ', 'ै'],
  ['au', 'औ', 'ौ'],
  ['ee', 'ई', 'ी'],
  ['oo', 'ऊ', 'ू'],
  ['a', 'अ', ''],
  ['i', 'इ', 'ि'],
  ['u', 'उ', 'ु'],
  ['e', 'ए', 'े'],
  ['o', 'ओ', 'ो'],
];

const HALANT = '्';
const ANUSVARA = 'ं';

function matchAt<T extends readonly [string, ...string[]]>(
  word: string,
  i: number,
  table: readonly T[],
): T | undefined {
  return table.find((e) => word.startsWith(e[0], i));
}

function wordToDevanagari(word: string): string {
  let out = '';
  let i = 0;
  while (i < word.length) {
    const v = matchAt(word, i, VOWELS);
    if (v) {
      out += v[1];
      i += v[0].length;
      continue;
    }
    const c = matchAt(word, i, CONSONANTS);
    if (!c) {
      i += 1; // not a letter we know
      continue;
    }
    i += c[0].length;
    const v2 = matchAt(word, i, VOWELS);
    const atEnd = i >= word.length;
    const nextIsConsonant = !v2 && !atEnd;
    // Nasal before another consonant reads as an anusvara (Pandey → पंडे).
    if ((c[0] === 'n' || c[0] === 'm') && nextIsConsonant && out !== '') {
      out += ANUSVARA;
      continue;
    }
    out += c[1];
    if (v2) {
      i += v2[0].length;
      const final = i >= word.length;
      // Word-final a → ā, i → ī, u → ū (Sunita → सुनीता, Rani → रानी).
      if (final && v2[0] === 'a' && word.length > 2) out += 'ा';
      else if (final && v2[0] === 'i') out += 'ी';
      else if (final && v2[0] === 'u') out += 'ू';
      else out += v2[2];
    } else if (nextIsConsonant) {
      out += HALANT;
    }
  }
  return out;
}

/** Devanagari suggestion for a Latin-script name (`''` when nothing convertible). */
export function transliterateToDevanagari(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .split(/[^a-zऀ-ॿ]+/)
    .filter(Boolean)
    .map((w) => (/[ऀ-ॿ]/.test(w) ? w : (KNOWN[w] ?? wordToDevanagari(w))))
    .join(' ');
}
