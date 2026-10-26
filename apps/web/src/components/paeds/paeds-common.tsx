'use client';

import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import type { AppRouter } from '@/server/trpc/root';

export type ImmunisationCard = inferRouterOutputs<AppRouter>['paeds']['card'];
export type GrowthOverview = inferRouterOutputs<AppRouter>['paeds']['growth'];
export type CardRow = ImmunisationCard['rows'][number];
export type PaedsT = ReturnType<typeof useTranslations<'paeds'>>;

/** Looks up a catalogue key built at run time (closed sets, all in the catalogue). */
export const key = (t: PaedsT) =>
  t as unknown as (k: string, v?: Record<string, string | number>) => string;

/**
 * The immunisation schedule, intervals, growth and dose rules are the draft of docs/33 / docs/11
 * until the paediatrician has reviewed them (build plan, `32 §5`).
 */
export function SignOffBanner({ signedOff }: { signedOff: boolean }) {
  const t = useTranslations('paeds');
  if (signedOff) return null;
  return (
    <p
      role="note"
      data-testid="paeds-pending-signoff"
      className="rounded-lg border-2 border-amber-600 bg-amber-50 p-3 text-base text-amber-950"
    >
      <strong>{t('pendingSignOff.title')}</strong> {t('pendingSignOff.body')}
    </p>
  );
}
