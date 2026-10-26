import { ageFromDob, type Age } from '@hmis/shared';
import { L } from '../labels';
import type { Bilingual } from '../types';

/** `28y`, `6m`, `12d`: the same in Hindi and English, short enough for a sticker. */
export function shortAge(age: Age): string {
  return `${age.value}${age.unit === 'years' ? 'y' : age.unit === 'months' ? 'm' : 'd'}`;
}

export const SEX_LABELS: Record<string, Bilingual> = { F: L.sexF, M: L.sexM, O: L.sexO };

/** `28y / F` — age from the DOB on `at`, sex letter as stored (the patient's own sex). */
export function ageSex(dob: string, sex: string, at: Date): string {
  try {
    return `${shortAge(ageFromDob(dob, at))} / ${sex}`;
  } catch {
    return sex; // a DOB in the future is a data error; never stop a print for it
  }
}

/** Last four digits of a mobile number, or null; the full number is never printed on stickers. */
export const mobileLast4 = (mobile: string | null | undefined): string | null =>
  mobile && mobile.length >= 4 ? mobile.slice(-4) : null;
