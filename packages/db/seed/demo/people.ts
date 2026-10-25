/**
 * Synthetic Indian people for demo data. Names are common first names and surnames combined at
 * random: any resemblance to a real person is coincidental. Mobiles are `9xxxxxxxxx` as required
 * by docs/02 §9; they are not guaranteed to be unassigned, so demo data must never send messages
 * (WhatsApp stays in log-only mode on demo machines).
 */
import { int, pick, type Rng } from './rng';

export const FEMALE_FIRST_NAMES = [
  'Sunita',
  'Anita',
  'Poonam',
  'Rekha',
  'Meena',
  'Kavita',
  'Savita',
  'Pooja',
  'Neha',
  'Priya',
  'Shanti',
  'Geeta',
  'Seema',
  'Radha',
  'Sarita',
  'Asha',
  'Rani',
  'Kiran',
  'Manju',
  'Nisha',
] as const;
export const MALE_FIRST_NAMES = [
  'Rajesh',
  'Suresh',
  'Ramesh',
  'Anil',
  'Vijay',
  'Sanjay',
  'Manoj',
  'Dinesh',
  'Rakesh',
  'Ajay',
  'Mukesh',
  'Pradeep',
  'Amit',
  'Rahul',
  'Vikas',
  'Deepak',
  'Sunil',
  'Arun',
  'Mohan',
  'Gopal',
] as const;
export const SURNAMES = [
  'Verma',
  'Singh',
  'Yadav',
  'Gupta',
  'Mishra',
  'Sharma',
  'Pandey',
  'Tiwari',
  'Maurya',
  'Kushwaha',
  'Chauhan',
  'Srivastava',
  'Dubey',
  'Shukla',
  'Patel',
  'Kumar',
  'Saxena',
  'Rathore',
] as const;

export type DemoSex = 'F' | 'M';

export interface DemoName {
  first: string;
  last: string;
  full: string;
}

export function indianName(rng: Rng, sex: DemoSex): DemoName {
  const first = pick(rng, sex === 'F' ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES);
  const last = pick(rng, SURNAMES);
  return { first, last, full: `${first} ${last}` };
}

/** `9xxxxxxxxx`: ten digits starting with 9. */
export function indianMobile(rng: Rng): string {
  return `9${String(int(rng, 0, 999_999_999)).padStart(9, '0')}`;
}
