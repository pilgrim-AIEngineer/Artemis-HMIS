'use client';

import { formatINR, VISIT_TYPES } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Select } from '@hmis/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMastersT } from '@/lib/masters-t';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useMastersCall, type ListPage } from './api';

interface RuleRow {
  id: string;
  visitType: string;
  serviceId: string;
  serviceName: string;
  followUpValidityDays: number | null;
  freeFollowUpsCount: number | null;
  feePaise: bigint | null;
}

const toInt = (s: string): number | null | undefined => {
  const v = s.trim();
  if (v === '') return null;
  return /^\d{1,3}$/.test(v) ? Number(v) : undefined;
};

/**
 * Consultation fee and follow-up rules of one doctor (docs/04 §2 `consultation_rule`): which
 * service is billed for each visit type, how long a follow-up stays valid and how many are free.
 * Blank validity/free count means "use the hospital default" (settings `opd.followUpValidityDays`,
 * `opd.freeFollowUps`, docs/40 Q6). The fee shown is the service's current rate in the default
 * tariff, edited under Tariffs → Rates.
 */
export function ConsultationRules({ doctorId }: { doctorId: string }) {
  const t = useMastersT();
  const errorText = useErrorText();
  const call = useMastersCall();
  const qc = useQueryClient();
  const key = ['masters', 'rules', doctorId];
  const rules = useQuery({
    queryKey: key,
    queryFn: () => call('listConsultationRules', 'query', { doctorId }) as Promise<RuleRow[]>,
  });
  const services = useQuery({
    queryKey: ['masters', 'lookup', 'consultationServices'],
    staleTime: 30_000,
    queryFn: async () =>
      ((await call('listServices', 'query', { category: 'consultation', limit: 200 })) as ListPage)
        .rows,
  });
  const [visitType, setVisitType] = useState<string>(VISIT_TYPES[0]);
  const [serviceId, setServiceId] = useState('');
  const [validity, setValidity] = useState('');
  const [free, setFree] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; reason: string } | null>(null);

  const save = useMutation({
    mutationFn: (input: unknown) => call('setConsultationRule', 'mutate', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (input: unknown) => call('cancelConsultationRule', 'mutate', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const submit = async () => {
    setError(null);
    const validityDays = toInt(validity);
    const freeCount = toInt(free);
    if (!serviceId || validityDays === undefined || freeCount === undefined) {
      setError(t('rules.invalid'));
      return;
    }
    try {
      await save.mutateAsync({
        doctorId,
        visitType,
        serviceId,
        followUpValidityDays: validityDays,
        freeFollowUpsCount: freeCount,
      });
      setValidity('');
      setFree('');
    } catch (e) {
      setError(errorText(e));
    }
  };

  const rows = rules.data ?? [];
  return (
    <section aria-labelledby="rules-title" className="space-y-3 border-t pt-4">
      <div className="space-y-1">
        <h3 id="rules-title" className="text-xl font-semibold">
          {t('rules.title')}
        </h3>
        <p className="text-muted-foreground">{t('rules.help')}</p>
      </div>
      {rules.isPending ? (
        <div className="h-16 animate-pulse rounded-md bg-muted" aria-busy="true" />
      ) : rows.length === 0 ? (
        <p className="rounded-md border bg-background p-3">{t('rules.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left">
            <thead className="bg-secondary">
              <tr>
                <th className="px-3 py-2 font-semibold">{t('rules.visitType')}</th>
                <th className="px-3 py-2 font-semibold">{t('rules.service')}</th>
                <th className="px-3 py-2 text-right font-semibold">{t('rules.fee')}</th>
                <th className="px-3 py-2 text-right font-semibold">{t('rules.validity')}</th>
                <th className="px-3 py-2 text-right font-semibold">{t('rules.free')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t even:bg-muted/40">
                  <td className="px-3 py-2">{t(`enums.visitType.${r.visitType}`)}</td>
                  <td className="px-3 py-2">{r.serviceName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.feePaise === null ? t('rules.noRate') : formatINR(r.feePaise)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.followUpValidityDays ?? t('rules.default')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.freeFollowUpsCount ?? t('rules.default')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {removing?.id === r.id ? (
                      <span className="inline-flex flex-wrap items-center justify-end gap-2">
                        <Input
                          aria-label={t('cancelReasonLabel')}
                          className="w-48"
                          autoFocus
                          value={removing.reason}
                          placeholder={t('cancelReasonPlaceholder')}
                          onChange={(e) => setRemoving({ id: r.id, reason: e.target.value })}
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={removing.reason.trim().length < 3}
                          onClick={() =>
                            void remove
                              .mutateAsync({ id: r.id, reason: removing.reason })
                              .then(() => setRemoving(null))
                              .catch((e: unknown) => setError(errorText(e)))
                          }
                        >
                          {t('confirmCancel')}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemoving({ id: r.id, reason: '' })}
                      >
                        {t('cancelRecord')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="rule-visit">{t('rules.visitType')}</Label>
          <Select id="rule-visit" value={visitType} onChange={(e) => setVisitType(e.target.value)}>
            {VISIT_TYPES.map((v) => (
              <option key={v} value={v}>
                {t(`enums.visitType.${v}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2 lg:col-span-3">
          <Label htmlFor="rule-service">{t('rules.service')}</Label>
          <Select
            id="rule-service"
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
          >
            <option value="">—</option>
            {(services.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {String(s.name)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="rule-validity">{t('rules.validity')}</Label>
          <Input
            id="rule-validity"
            inputMode="numeric"
            value={validity}
            placeholder={t('rules.default')}
            onChange={(e) => setValidity(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rule-free">{t('rules.free')}</Label>
          <Input
            id="rule-free"
            inputMode="numeric"
            value={free}
            placeholder={t('rules.default')}
            onChange={(e) => setFree(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="button" disabled={save.isPending} onClick={() => void submit()}>
            {t('rules.save')}
          </Button>
        </div>
      </div>
      <FormStatus error={error} />
    </section>
  );
}
