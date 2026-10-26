'use client';

import type { RiskCode } from '@hmis/shared';
import { cn } from '@hmis/ui/lib/utils';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import type { AppRouter } from '@/server/trpc/root';

export type PatientAnc = inferRouterOutputs<AppRouter>['anc']['forPatient'];
export type PregnancyView = NonNullable<PatientAnc['active']>;
export type AncT = ReturnType<typeof useTranslations<'anc'>>;

/** Wording of a risk flag; the codes are a closed set and all are in the catalogue. */
export const riskLabel = (t: AncT, code: RiskCode) =>
  (t as unknown as (key: string) => string)(`risk.${code}`);

/** Risk flags as bold chips: the serious band (`alert`) in red, the rest amber, always with words. */
export function RiskChips({
  risks,
  className,
}: {
  risks: PregnancyView['risks'];
  className?: string;
}) {
  const t = useTranslations('anc');
  if (risks.length === 0) return null;
  return (
    <ul className={cn('flex flex-wrap gap-2', className)} data-testid="anc-risks">
      {risks.map((r, i) => (
        <li
          key={`${r.code}-${i}`}
          data-code={r.code}
          data-level={r.level}
          className={cn(
            'rounded-full border-2 px-3 py-1 text-base font-bold',
            r.level === 'alert'
              ? 'border-destructive bg-red-50 text-red-950'
              : 'border-amber-600 bg-amber-50 text-amber-950',
          )}
        >
          {r.level === 'alert' ? '▲▲' : '▲'} {riskLabel(t, r.code)}
          {r.value ? ` (${r.value})` : ''}
          {r.text ? `: ${r.text}` : ''}
        </li>
      ))}
    </ul>
  );
}

/**
 * The clinical rules (schedule, re-dating table, risk thresholds) are the draft of docs/33 / docs/11
 * until the owner gynaecologist has reviewed them (build plan, `32 §5`).
 */
export function SignOffBanner({ signedOff }: { signedOff: boolean }) {
  const t = useTranslations('anc');
  if (signedOff) return null;
  return (
    <p
      role="note"
      data-testid="anc-pending-signoff"
      className="rounded-lg border-2 border-amber-600 bg-amber-50 p-3 text-base text-amber-950"
    >
      <strong>{t('pendingSignOff.title')}</strong> {t('pendingSignOff.body')}
    </p>
  );
}

export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export const numOrNull = (s: string): number | null => {
  const v = s.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function Section({
  id,
  title,
  children,
  aside,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      data-testid={id}
      className="space-y-3 rounded-lg border-2 bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-xl font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
