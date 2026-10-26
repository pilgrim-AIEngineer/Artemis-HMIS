'use client';

import type { RxWarning } from '@hmis/shared';
import { useTranslations } from 'next-intl';

type Loose = (key: string, values?: Record<string, string | number>) => string;

/**
 * The text of one Rx warning. A paediatric dose warning names the range for the child's weight
 * ("Expected 4.5–6.0 ml per dose for 14 kg", docs/11 §4.4); the dose itself is never changed.
 */
export function WarningText({ warning }: { warning: RxWarning }) {
  const t = useTranslations('rx') as unknown as Loose;
  const p = warning.paeds;
  if (warning.code !== 'paeds_dose' || !p) return <>{t(`warnings.${warning.code}`)}</>;
  if (p.verdict === 'too_many_doses') {
    return (
      <>{t('warnings.paeds_too_many_doses', { max: p.maxDosesPerDay ?? 0, kg: p.weightKg })}</>
    );
  }
  const range =
    p.expectedMin !== null && p.expectedMax !== null
      ? `${p.expectedMin}–${p.expectedMax} ${t(`warnings.paedsUnit.${p.unit}`)}`
      : `${p.expectedMgMin}–${p.expectedMgMax} mg`;
  return <>{t(`warnings.paeds_${p.verdict}`, { range, kg: p.weightKg })}</>;
}
