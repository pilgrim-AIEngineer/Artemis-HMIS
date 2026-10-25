'use client';

import { formatDate, formatDateTime, type Permission } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { PatientHeader, type PatientHeaderFlag } from '@hmis/ui/components/patient-header';
import { skipToken, useQuery } from '@tanstack/react-query';
import { Pencil, Search, UserRoundPlus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useSession } from '@/components/auth/session-provider';
import { Section } from '@/components/section';
import { useAgeText } from '@/lib/use-age-text';
import { useTRPC } from '@/trpc/client';

/** Patient page: identity strip, details, the family on the same mobile, and the next actions. */
export function PatientSummary({ id, registeredUhid }: { id: string; registeredUhid?: string }) {
  const t = useTranslations('reception');
  const tSum = useTranslations('reception.summary');
  const tEnum = useTranslations('reception.enums');
  const ageText = useAgeText();
  const trpc = useTRPC();
  const { me } = useSession();
  const can = (p: Permission) => me.permissions.includes(p);

  const patient = useQuery(trpc.patients.get.queryOptions({ id }));
  const p = patient.data;
  const family = useQuery(
    trpc.patients.search.queryOptions(p?.mobile ? { q: p.mobile } : skipToken),
  );

  if (patient.isPending)
    return <div className="h-40 animate-pulse rounded-lg bg-muted" aria-busy="true" />;
  if (patient.isError || !p) {
    return (
      <div className="space-y-4">
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-destructive">
          {tSum('notFound')}
        </p>
        <Button asChild variant="outline">
          <Link href="/reception">{tSum('backToSearch')}</Link>
        </Button>
      </div>
    );
  }

  const flags: PatientHeaderFlag[] = [];
  if (p.isDeceased) flags.push({ label: t('search.deceased'), tone: 'muted' });
  if (p.identityChangedAt) flags.push({ label: tSum('changed'), tone: 'warn' });

  const rows: [string, string | null][] = [
    ['uhid', p.uhid],
    ['name', p.fullName],
    ['nameHi', p.nameHi],
    ['ageSex', `${ageText(p.dob)} / ${t(`sex.${p.sex as 'F' | 'M' | 'O'}`)}`],
    ['dob', `${formatDate(p.dob)}${p.dobIsEstimated ? ` (${tSum('estimated')})` : ''}`],
    ['mobile', p.mobile ?? null],
    ['altMobile', p.altMobile],
    [
      'relationToMobileOwner',
      p.relationToMobileOwner
        ? tEnum(`relationToMobileOwner.${p.relationToMobileOwner as 'self'}`)
        : null,
    ],
    [
      'guardian',
      p.guardianName
        ? `${p.guardianName}${p.guardianRelation ? ` (${tEnum(`guardianRelation.${p.guardianRelation as 'husband'}`)})` : ''}`
        : null,
    ],
    ['address', p.addressLine],
    ['locality', p.localityName],
    ['district', [p.district, p.state].filter(Boolean).join(', ') || null],
    ['pincode', p.pincode],
    ['bloodGroup', p.bloodGroup],
    [
      'maritalStatus',
      p.maritalStatus ? tEnum(`maritalStatus.${p.maritalStatus as 'single'}`) : null,
    ],
    ['occupation', p.occupation],
    ['referredBy', p.referredBy],
    ['registered', formatDateTime(p.createdAt)],
  ];
  const others = (family.data?.rows ?? []).filter((r) => r.id !== id);

  return (
    <div className="space-y-5">
      {registeredUhid && (
        <p
          role="status"
          className="rounded-lg border-2 border-money p-4 text-xl font-semibold text-money"
        >
          {tSum('registered', { uhid: registeredUhid })}
        </p>
      )}
      <PatientHeader
        name={p.fullName}
        nameHi={p.nameHi}
        ageSex={`${ageText(p.dob)} / ${t(`sex.${p.sex as 'F' | 'M' | 'O'}`)}`}
        uhid={p.uhid}
        mobileLast4={p.mobile?.slice(-4)}
        mobileLabel={t('columns.mobile')}
        flags={flags}
      />
      <div className="flex flex-wrap gap-3">
        {can('patient.update') && !p.isDeceased && (
          <Button asChild variant="outline">
            <Link href={`/reception/patients/${id}/edit`}>
              <Pencil aria-hidden />
              {tSum('edit')}
            </Link>
          </Button>
        )}
        {can('patient.create') && (
          <Button asChild variant="outline">
            <Link href={`/reception/patients/new?familyOf=${id}`}>
              <UserRoundPlus aria-hidden />
              {t('addFamily')}
            </Link>
          </Button>
        )}
        <Button asChild>
          <Link href="/reception">
            <Search aria-hidden />
            {tSum('backToSearch')}
          </Link>
        </Button>
      </div>

      <Section title={tSum('details')}>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt className="text-sm text-muted-foreground">
                  {tSum(`fields.${k}` as 'fields.uhid')}
                </dt>
                <dd className="text-lg tabular-nums">{v}</dd>
              </div>
            ))}
        </dl>
      </Section>

      {p.mobile && (
        <Section title={tSum('family')}>
          {others.length === 0 ? (
            <p className="text-muted-foreground">{tSum('familyNone')}</p>
          ) : (
            <ul className="divide-y">
              {others.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <Link
                    href={`/reception/patients/${r.id}`}
                    className="rounded text-lg font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/60"
                  >
                    {r.fullName}
                  </Link>
                  <span className="text-muted-foreground tabular-nums">
                    {ageText(r.dob)} / {t(`sexShort.${r.sex as 'F' | 'M' | 'O'}`)} · {r.uhid}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
