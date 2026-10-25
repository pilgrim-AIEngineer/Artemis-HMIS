'use client';

import { ageFromDob } from '@hmis/shared';
import { useTranslations } from 'next-intl';

/** `28 years`, `6 months`, `12 days` for a DOB (docs/02 §3), in the user's language. */
export function useAgeText() {
  const t = useTranslations('age');
  return (dob: string): string => {
    const age = ageFromDob(dob);
    return t(age.unit, { count: age.value });
  };
}
