'use client';

import { formatDate } from '@hmis/shared';
import { PatientHeader, type PatientHeaderFlag } from '@hmis/ui/components/patient-header';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { PrintButton } from '@/components/print/print-button';
import { useAgeText } from '@/lib/use-age-text';
import { useTRPC } from '@/trpc/client';
import { AncCreate } from './anc-create';
import { CloseSection } from './anc-close';
import {
  RiskChips,
  Section,
  SignOffBanner,
  type PatientAnc,
  type PregnancyView,
} from './anc-common';
import { DatingSection } from './anc-dating';
import { DetailsSection, HistorySection } from './anc-details';
import { ScheduleSection } from './anc-schedule';
import { VisitsSection } from './anc-visits';

/**
 * One woman's ANC card (OPD-05, docs/11 §3): summary with GA / EDD / G P A L / risk flags on every
 * screen, dating, visits, schedule, history and closing. Keyboard order follows the page top to
 * bottom; every action has a labelled button of at least 44 px.
 */
export function AncRecord({
  patientId,
  canEdit,
  canMtp,
}: {
  patientId: string;
  canEdit: boolean;
  canMtp: boolean;
}) {
  const t = useTranslations('anc');
  const tQ = useTranslations('queue');
  const ageText = useAgeText();
  const trpc = useTRPC();
  const data = useQuery(trpc.anc.forPatient.queryOptions({ patientId }));
  const rules = useQuery(trpc.anc.rules.queryOptions());

  if (data.isError) {
    return (
      <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
        {t('loadFailed')}
      </p>
    );
  }
  if (!data.data) return <p className="text-lg text-muted-foreground">{t('loading')}</p>;
  const d: PatientAnc = data.data;
  const v = d.active;

  const flags: PatientHeaderFlag[] = [];
  if (v?.ga) flags.push({ label: `${t('ga')} ${v.ga.label}`, tone: 'warn' });
  if (v?.highRisk) flags.push({ label: t('highRisk'), tone: 'danger' });

  return (
    <div className="space-y-5">
      <PatientHeader
        name={d.patient.fullName}
        nameHi={d.patient.nameHi}
        ageSex={`${v ? ageText(v.patient.dob) : ''}${v ? ' / ' : ''}${tQ(`sex.${d.patient.sex as 'F' | 'M' | 'O'}`)}`}
        uhid={d.patient.uhid}
        mobileLast4={v?.patient.mobileLast4 ?? null}
        mobileLabel={t('mobile')}
        flags={flags}
      />
      {rules.data && <SignOffBanner signedOff={rules.data.signedOff} />}

      {!d.eligible && (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
          {t('notEligible')}
        </p>
      )}

      {d.eligible && !v && (
        <>
          {canEdit ? (
            <AncCreate data={d} />
          ) : (
            <p className="rounded-lg border-2 border-dashed p-6 text-lg text-muted-foreground">
              {t('noPregnancy')}
            </p>
          )}
        </>
      )}

      {v && (
        <>
          <Summary v={v} />
          <DatingSection
            key={`${v.dating.eddFinal}-${v.dating.scanDate}`}
            v={v}
            canEdit={canEdit}
          />
          <VisitsSection v={v} canEdit={canEdit} />
          <ScheduleSection v={v} canEdit={canEdit} />
          <DetailsSection
            key={`${v.bloodGroupRh}-${v.plurality}-${JSON.stringify(v.manualRisks)}`}
            v={v}
            canEdit={canEdit}
          />
          <HistorySection key={`${v.history.length}-${v.gpal.text}`} v={v} canEdit={canEdit} />
          {canEdit && <CloseSection v={v} canMtp={canMtp} />}
        </>
      )}

      {d.past.length > 0 && (
        <Section id="anc-past" title={t('past.title')}>
          <ul className="space-y-1" data-testid="anc-past-list">
            {d.past.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-lg">
                  {t('edd')} {formatDate(p.eddFinal)} ·{' '}
                  {t(`outcome.${p.status}` as 'outcome.delivered')}
                  {p.outcomeDate ? ` · ${formatDate(p.outcomeDate)}` : ''}
                </span>
                {canEdit && p.status !== 'closed' && (
                  <PrintButton
                    template="anc-card"
                    entityId={p.id}
                    label={t('printCard')}
                    variant="outline"
                    size="sm"
                    shortcut={false}
                  />
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Summary({ v }: { v: PregnancyView }) {
  const t = useTranslations('anc');
  const next = v.nextVisit;
  return (
    <Section
      id="anc-summary"
      title={t('summary.title')}
      aside={
        <PrintButton template="anc-card" entityId={v.id} label={t('printCard')} variant="outline" />
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4">
        <Fact label={t('ga')} value={v.ga?.label ?? '—'} testId="anc-ga" strong />
        <Fact label={t('edd')} value={formatDate(v.dating.eddFinal)} testId="anc-edd" strong />
        <Fact label={t('gpal.label')} value={v.gpal.text} />
        <Fact label={t('bloodGroup')} value={v.bloodGroupRh ?? t('notKnown')} />
        <Fact label={t('plurality.label')} value={t(`plurality.${v.plurality}`)} />
        <Fact label={t('booked')} value={formatDate(v.bookingDate)} />
        <Fact
          label={t('nextVisit')}
          value={
            next ? `${formatDate(next.date)}${next.overdue ? ` · ${t('state.overdue')}` : ''}` : '—'
          }
          testId="anc-next-visit"
        />
      </dl>
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{t('risks')}</p>
        {v.risks.length === 0 ? (
          <p className="text-lg" data-testid="anc-no-risks">
            {t('noRisks')}
          </p>
        ) : (
          <RiskChips risks={v.risks} />
        )}
      </div>
    </Section>
  );
}

function Fact({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={strong ? 'text-2xl font-semibold' : 'text-lg'} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
