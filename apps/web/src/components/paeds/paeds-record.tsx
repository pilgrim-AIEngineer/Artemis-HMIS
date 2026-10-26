'use client';

import { PatientHeader, type PatientHeaderFlag } from '@hmis/ui/components/patient-header';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useAgeText } from '@/lib/use-age-text';
import { useTRPC } from '@/trpc/client';
import { GrowthSection } from './growth-section';
import { GivenSection, ImmunisationSummary, ScheduleSection } from './immunisation-section';
import { SignOffBanner } from './paeds-common';

/**
 * One child's vaccination and growth card (OPD-06, docs/11 §4): next due date, schedule, doses
 * given with batch, WhatsApp reminder, growth charts. Keyboard order follows the page top to
 * bottom; every action has a labelled button of at least 44 px.
 */
export function PaedsRecord({ patientId, canEdit }: { patientId: string; canEdit: boolean }) {
  const t = useTranslations('paeds');
  const tQ = useTranslations('queue');
  const ageText = useAgeText();
  const trpc = useTRPC();
  const card = useQuery(trpc.paeds.card.queryOptions({ patientId }));
  const growth = useQuery(trpc.paeds.growth.queryOptions({ patientId }));

  if (card.isError || growth.isError) {
    return (
      <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
        {t('loadFailed')}
      </p>
    );
  }
  if (!card.data || !growth.data) {
    return <p className="text-lg text-muted-foreground">{t('loading')}</p>;
  }
  const c = card.data;
  const flags: PatientHeaderFlag[] = [];
  const overdue = c.rows.filter((r) => r.status === 'overdue' && !r.item.isOptional).length;
  if (overdue > 0) flags.push({ label: t('overdueCount', { count: overdue }), tone: 'danger' });

  return (
    <div className="space-y-5">
      <PatientHeader
        name={c.patient.name}
        nameHi={c.patient.nameHi}
        ageSex={`${ageText(c.patient.dob)} / ${tQ(`sex.${c.patient.sex}`)}`}
        uhid={c.patient.uhid}
        mobileLast4={c.patient.mobile ? c.patient.mobile.slice(-4) : null}
        mobileLabel={t('mobile')}
        flags={flags}
      />
      <SignOffBanner signedOff={c.rules.signedOff} />
      <ImmunisationSummary card={c} canEdit={canEdit} />
      <ScheduleSection card={c} canEdit={canEdit} />
      <GivenSection card={c} canEdit={canEdit} />
      <GrowthSection growth={growth.data} canEdit={canEdit} />
    </div>
  );
}
