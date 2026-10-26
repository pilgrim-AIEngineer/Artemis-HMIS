'use client';

import {
  VACCINE_ROUTES,
  VACCINE_SITES,
  type DoseTimingProblem,
  type VaccineRoute,
  type VaccineSite,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@hmis/ui/components/dialog';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Checkbox, Select } from '@hmis/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Syringe } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { today } from '@/components/anc/anc-common';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { key, type CardRow } from './paeds-common';

/** What the form starts with for a vaccine: oral vaccines by mouth, BCG into the skin, the rest in the thigh. */
function defaultsFor(vaccineCode: string | null): { site: VaccineSite; route: VaccineRoute } {
  if (vaccineCode === 'OPV' || vaccineCode === 'ROTA') return { site: 'oral', route: 'oral' };
  if (vaccineCode === 'BCG') return { site: 'intradermal_left_arm', route: 'id' };
  return { site: 'left_thigh', route: 'im' };
}

/**
 * Records one dose given (docs/11 §4.1): vaccine, brand, batch, expiry, site, route and date. A
 * dose of the schedule comes with its row; "another vaccine" is typed in. Timing problems (too
 * early, after the maximum age, an earlier dose missing) show before saving and have to be
 * confirmed; a date before birth or in the future, and an expired batch, are refused.
 */
export function DoseDialog({
  patientId,
  row,
  other,
  onClose,
}: {
  patientId: string;
  /** The schedule dose being recorded; null for a vaccine outside the schedule. */
  row: CardRow | null;
  other: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('paeds');
  const locale = useLocale();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const defaults = defaultsFor(row?.item.vaccineCode ?? null);
  const name = row ? (locale === 'hi' ? row.item.labelHi : row.item.label) : '';
  const [idem] = useState(uuidv7);
  const [vaccineName, setVaccineName] = useState(row ? row.item.label : '');
  const [givenOn, setGivenOn] = useState(today());
  const [brand, setBrand] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [expiry, setExpiry] = useState('');
  const [site, setSite] = useState<VaccineSite>(defaults.site);
  const [route, setRoute] = useState<VaccineRoute>(defaults.route);
  // The confirmation belongs to one date: another date asks again.
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirm = confirmedFor === givenOn;
  const [error, setError] = useState<string | null>(null);

  const itemCode = row?.code ?? null;
  const check = useQuery(
    trpc.paeds.checkDose.queryOptions(
      { patientId, itemCode, givenOn },
      { enabled: !!givenOn && !other },
    ),
  );
  const recent = useQuery(
    trpc.paeds.recentBatches.queryOptions(
      { vaccineName: vaccineName.trim() || 'x' },
      { enabled: vaccineName.trim().length > 0 },
    ),
  );

  const warnings: DoseTimingProblem[] = check.data?.warnings ?? [];
  const blocking: DoseTimingProblem[] = check.data?.blocking ?? [];
  const save = useMutation(
    trpc.paeds.recordDose.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: [['paeds']] });
        onClose();
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const submit = () => {
    setError(null);
    save.mutate({
      idempotencyKey: idem,
      patientId,
      encounterId: null,
      itemCode,
      vaccineName: vaccineName.trim(),
      brand: brand.trim() || null,
      batchNo: batchNo.trim(),
      expiry,
      site,
      route,
      givenOn,
      confirmWarnings: confirm,
    });
  };
  const needsConfirm = warnings.length > 0 && !confirm;
  const canSave =
    vaccineName.trim() !== '' &&
    batchNo.trim() !== '' &&
    expiry !== '' &&
    blocking.length === 0 &&
    !needsConfirm &&
    !save.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('dialog.close')} data-testid="dose-dialog">
        <DialogTitle>{row ? t('dialog.titleFor', { name }) : t('dialog.titleOther')}</DialogTitle>
        <DialogDescription>{t('dialog.hint')}</DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {other && (
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="dose-vaccine">{t('dialog.vaccine')}</Label>
                <Input
                  id="dose-vaccine"
                  value={vaccineName}
                  onChange={(e) => setVaccineName(e.target.value)}
                  autoFocus
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="dose-given-on">{t('dialog.givenOn')}</Label>
              <Input
                id="dose-given-on"
                type="date"
                max={today()}
                value={givenOn}
                onChange={(e) => setGivenOn(e.target.value)}
                autoFocus={!other}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dose-brand">{t('dialog.brand')}</Label>
              <Input id="dose-brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dose-batch">{t('dialog.batch')}</Label>
              <Input
                id="dose-batch"
                value={batchNo}
                onChange={(e) => setBatchNo(e.target.value)}
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dose-expiry">{t('dialog.expiry')}</Label>
              <Input
                id="dose-expiry"
                type="date"
                min={givenOn}
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                required
              />
            </div>
            {recent.data && recent.data.length > 0 && (
              <div className="space-y-1 sm:col-span-2" data-testid="dose-recent-batches">
                <p className="text-sm text-muted-foreground">{t('dialog.recentBatches')}</p>
                <ul className="flex flex-wrap gap-2">
                  {recent.data.map((b) => (
                    <li key={`${b.batchNo}-${b.expiry}`}>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setBatchNo(b.batchNo);
                          setExpiry(b.expiry);
                          if (b.brand) setBrand(b.brand);
                        }}
                      >
                        {b.batchNo} · {b.expiry}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="dose-site">{t('dialog.site')}</Label>
              <Select
                id="dose-site"
                value={site}
                onChange={(e) => setSite(e.target.value as VaccineSite)}
              >
                {VACCINE_SITES.map((s) => (
                  <option key={s} value={s}>
                    {key(t)(`site.${s}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dose-route">{t('dialog.route')}</Label>
              <Select
                id="dose-route"
                value={route}
                onChange={(e) => setRoute(e.target.value as VaccineRoute)}
              >
                {VACCINE_ROUTES.map((r) => (
                  <option key={r} value={r}>
                    {key(t)(`route.${r}`)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {blocking.length > 0 && (
            <ul role="alert" className="space-y-1" data-testid="dose-blocking">
              {blocking.map((b) => (
                <li
                  key={b}
                  className="rounded-md border-2 border-destructive bg-red-50 px-3 py-1 font-medium text-red-950"
                >
                  ▲▲ {key(t)(`timing.${b}`)}
                </li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <div className="space-y-2" data-testid="dose-warnings">
              <ul className="space-y-1">
                {warnings.map((w) => (
                  <li
                    key={w}
                    className="rounded-md border-2 border-amber-600 bg-amber-50 px-3 py-1 font-medium text-amber-950"
                  >
                    ▲ {key(t)(`timing.${w}`)}
                  </li>
                ))}
              </ul>
              <label className="flex min-h-11 items-center gap-3 text-lg">
                <Checkbox
                  checked={confirm}
                  onChange={(e) => setConfirmedFor(e.target.checked ? givenOn : null)}
                />
                {t('dialog.confirmWarnings')}
              </label>
            </div>
          )}
          <FormStatus error={error} />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>
              {t('dialog.cancel')}
            </Button>
            <Button type="submit" size="lg" disabled={!canSave}>
              <Syringe aria-hidden />
              {t('dialog.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
