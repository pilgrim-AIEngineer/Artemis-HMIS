'use client';

import {
  DIPSTICK_GRADES,
  evaluateVitals,
  flagLevelByField,
  GRADE_SYMBOL,
  normaliseVitals,
  OEDEMA_GRADES,
  validateVitals,
  vitalsFieldsFor,
  type VitalsField,
  type VitalsFlag,
  type VitalsGroup,
  type VitalsValues,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { NumberPad } from '@hmis/ui/components/number-pad';
import { PatientHeader, type PatientHeaderFlag } from '@hmis/ui/components/patient-header';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { CheckCircle2, Keyboard } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRef, useState, type KeyboardEvent } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { PrintButton } from '@/components/print/print-button';
import { PrintOnMount } from '@/components/print/print-on-mount';
import { useAgeText } from '@/lib/use-age-text';
import { useErrorText, useFieldError } from '@/lib/use-error-text';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';

type Context = inferRouterOutputs<AppRouter>['vitals']['context'];
type Saved = inferRouterOutputs<AppRouter>['vitals']['record'];

interface NumericMeta {
  key: Exclude<VitalsField, 'oedema' | 'urineAlbumin' | 'urineSugar'>;
  unit: string;
  decimal: boolean;
  /** Flag field this input is judged under. */
  flag?: 'pulse' | 'temp' | 'spo2' | 'rbs';
}

/** Paper order: the tab order of the form (docs/11 §1). */
const NUMERIC: NumericMeta[] = [
  { key: 'pulse', unit: '/min', decimal: false, flag: 'pulse' },
  { key: 'tempF', unit: '°F', decimal: true, flag: 'temp' },
  { key: 'spo2', unit: '%', decimal: false, flag: 'spo2' },
  { key: 'rr', unit: '/min', decimal: false },
  { key: 'weightKg', unit: 'kg', decimal: true },
  { key: 'heightCm', unit: 'cm', decimal: true },
  { key: 'headCircCm', unit: 'cm', decimal: true },
  { key: 'muacCm', unit: 'cm', decimal: true },
  { key: 'rbsMgdl', unit: 'mg/dL', decimal: false, flag: 'rbs' },
  { key: 'fundalHeightCm', unit: 'cm', decimal: true },
  { key: 'fhr', unit: '/min', decimal: false },
];
const BP_FIELDS: VitalsField[] = ['bpSys', 'bpDia'];
const GRADE_FIELDS = ['oedema', 'urineAlbumin', 'urineSugar'] as const;
const NO_DECIMAL = new Set<VitalsField>([
  'bpSys',
  'bpDia',
  'pulse',
  'spo2',
  'rr',
  'rbsMgdl',
  'fhr',
]);

type VitalsT = ReturnType<typeof useTranslations<'vitals'>>;

/** Wording of a flag; codes and levels are a closed set, all of them present in the catalogue. */
const flagLabel = (t: VitalsT, f: Pick<VitalsFlag, 'code' | 'level'>) =>
  t(`flags.${f.code}.${f.level}` as Parameters<VitalsT>[0]);

const toneClass = {
  amber: 'border-amber-600 bg-amber-50 text-amber-950',
  red: 'border-destructive bg-red-50 text-red-950',
} as const;

/** A typed string → number, undefined when blank, NaN when it is not a number. */
const parse = (s: string | undefined): number | undefined => {
  const v = s?.trim();
  return v ? Number(v) : undefined;
};

function initialText(c: Context): Record<string, string> {
  const r = c.current;
  if (!r) return {};
  const out: Record<string, string> = {};
  const set = (k: string, v: number | string | null) => {
    if (v !== null) out[k] = String(v);
  };
  set('bpSys', r.bpSys);
  set('bpDia', r.bpDia);
  set('pulse', r.pulse);
  set('tempF', r.tempF);
  set('spo2', r.spo2);
  set('rr', r.rr);
  set('weightKg', r.weightKg);
  set('heightCm', r.heightCm);
  set('headCircCm', r.headCircCm);
  set('muacCm', r.muacCm);
  set('rbsMgdl', r.rbsMgdl);
  set('fundalHeightCm', r.fundalHeightCm);
  set('fhr', r.fhr);
  set('oedema', r.oedema);
  set('urineAlbumin', r.urineAlbumin);
  set('urineSugar', r.urineSugar);
  return out;
}

/**
 * Vitals form (OPD-01, docs/11 §1): adapts to adult / pregnant / child, flags out-of-range values
 * as they are typed (amber / red, with words as well as colour), blocks impossible ones, and has a
 * big number pad for tablets. Enter moves to the next field in paper order; Enter on the last one
 * saves. The same shared rules run on the server, which has the final say.
 */
export function VitalsForm({ ctx }: { ctx: Context }) {
  const t = useTranslations('vitals');
  const tQ = useTranslations('queue');
  const errorText = useErrorText();
  const fieldError = useFieldError();
  const ageText = useAgeText();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [group, setGroup] = useState<VitalsGroup>(ctx.defaultGroup);
  const [text, setText] = useState<Record<string, string>>(() => initialText(ctx));
  const [active, setActive] = useState<VitalsField | null>(null);
  const [padOn, setPadOn] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [printN, setPrintN] = useState(0);
  const refs = useRef(new Map<VitalsField, HTMLElement>());

  const who = { age: ctx.patient.age, sex: ctx.patient.sex };
  const fields = vitalsFieldsFor(group, who);
  const has = (f: VitalsField) => fields.includes(f);

  // ---- values, problems and live flags
  const values: VitalsValues = {};
  const notNumber = new Set<VitalsField>();
  for (const f of fields) {
    const raw = text[f];
    if (raw === undefined || raw.trim() === '') continue;
    if ((GRADE_FIELDS as readonly string[]).includes(f)) {
      (values as Record<string, unknown>)[f] = raw;
      continue;
    }
    const n = parse(raw);
    if (n === undefined) continue;
    if (!Number.isFinite(n) || (NO_DECIMAL.has(f) && !Number.isInteger(n))) notNumber.add(f);
    else (values as Record<string, unknown>)[f] = n;
  }
  const issues = validateVitals(group, values, who);
  const problem = new Map<VitalsField, string>();
  for (const f of notNumber) problem.set(f, 'validation.vitals.number');
  for (const i of issues) if (!problem.has(i.field)) problem.set(i.field, i.key);
  const entered = Object.keys(values).length;
  const stored = normaliseVitals(group, values);
  const flags: VitalsFlag[] = evaluateVitals(group, stored, ctx.thresholds);
  const band = flagLevelByField(flags);
  const alert = flags.some((f) => f.code === 'raised_bp_pregnancy');
  const canSave = ctx.token.open && entered > 0 && problem.size === 0;

  // ---- focus and keys
  // Paper order: the shared field list of the group is also the tab and Enter order.
  const numeric = fields.flatMap((f) => NUMERIC.filter((n) => n.key === f));
  const order: VitalsField[] = fields.filter(
    (f) => BP_FIELDS.includes(f) || NUMERIC.some((n) => n.key === f),
  );
  const focusNext = (from: VitalsField) => {
    const next = order[order.indexOf(from) + 1];
    if (next) refs.current.get(next)?.focus();
    else document.getElementById('vitals-save')?.focus();
  };

  const save = useMutation(
    trpc.vitals.record.mutationOptions({
      onSuccess: (r) => {
        setSaved(r);
        setError(null);
        if (r.printSheet) setPrintN((n) => n + 1);
        void queryClient.invalidateQueries({ queryKey: [['vitals']] });
        void queryClient.invalidateQueries({ queryKey: [['queue']] });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const submit = () => {
    if (!canSave || save.isPending) return;
    save.mutate({ tokenId: ctx.token.id, group, values });
  };

  const onKey = (f: VitalsField) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (order.indexOf(f) === order.length - 1) submit();
    else focusNext(f);
  };

  const padKey = (k: string) => {
    if (!active || (GRADE_FIELDS as readonly string[]).includes(active)) return;
    setText((s) => {
      const cur = s[active] ?? '';
      if (k === '.' && (cur.includes('.') || NO_DECIMAL.has(active))) return s;
      return { ...s, [active]: cur + k };
    });
  };
  const padBack = () =>
    active && setText((s) => ({ ...s, [active]: (s[active] ?? '').slice(0, -1) }));
  const padNext = () => active && focusNext(active);

  // ---- pieces
  const unitOf = (f: VitalsField) => NUMERIC.find((n) => n.key === f)?.unit ?? 'mmHg';
  const flagText = (field: keyof typeof band) => {
    const level = band[field];
    if (!level) return null;
    const code = flags.find((f) => f.field === field && f.level === level)!.code;
    return (
      <p
        className={cn(
          'flex items-center gap-1 text-sm font-semibold',
          level === 'red' ? 'text-destructive' : 'text-amber-900',
        )}
        data-testid={`flag-${field}`}
        data-level={level}
      >
        {level === 'red' ? '▲▲' : '▲'} {flagLabel(t, { code, level })}
      </p>
    );
  };

  const numberInput = (f: VitalsField, flagField?: keyof typeof band) => {
    const level = flagField ? band[flagField] : undefined;
    const msg = problem.get(f);
    return (
      <div key={f} className="space-y-1">
        <Label htmlFor={`v-${f}`}>{t(`fields.${f}`)}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={`v-${f}`}
            ref={(el) => {
              if (el) refs.current.set(f, el);
            }}
            value={text[f] ?? ''}
            inputMode={padOn ? 'none' : NO_DECIMAL.has(f) ? 'numeric' : 'decimal'}
            autoComplete="off"
            aria-invalid={!!msg || undefined}
            aria-describedby={msg ? `v-${f}-err` : undefined}
            className={cn('h-14 text-2xl font-semibold tabular-nums', level && toneClass[level])}
            data-level={level}
            onFocus={() => setActive(f)}
            onChange={(e) => setText((s) => ({ ...s, [f]: e.target.value }))}
            onKeyDown={onKey(f)}
          />
          <span className="w-14 text-muted-foreground">{unitOf(f)}</span>
        </div>
        {msg && (
          <p id={`v-${f}-err`} role="alert" className="text-sm font-medium text-destructive">
            {fieldError(msg)}
          </p>
        )}
      </div>
    );
  };

  const gradeInput = (f: (typeof GRADE_FIELDS)[number]) => {
    const options = f === 'oedema' ? OEDEMA_GRADES : DIPSTICK_GRADES;
    return (
      <fieldset key={f} className="space-y-1">
        <legend className="text-base font-medium">{t(`fields.${f}`)}</legend>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={text[f] === o}
              onClick={() => setText((s) => ({ ...s, [f]: s[f] === o ? '' : o }))}
              className={cn(
                'min-h-12 min-w-14 rounded-md border-2 px-3 text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60',
                text[f] === o
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-card',
              )}
            >
              {o === 'none' ? t('grades.none') : GRADE_SYMBOL[o]}
            </button>
          ))}
        </div>
      </fieldset>
    );
  };

  const headerFlags: PatientHeaderFlag[] = [];
  if (group === 'pregnant') headerFlags.push({ label: t('pregnantTag'), tone: 'warn' });
  const header = (
    <PatientHeader
      name={ctx.patient.fullName}
      nameHi={ctx.patient.nameHi}
      ageSex={`${ageText(ctx.patient.dob)} / ${tQ(`sex.${ctx.patient.sex as 'F' | 'M' | 'O'}`)}`}
      uhid={ctx.patient.uhid}
      mobileLast4={ctx.patient.mobileLast4}
      mobileLabel={t('mobile')}
      flags={headerFlags}
    />
  );

  // ---- saved
  if (saved) {
    return (
      <div className="space-y-5">
        {header}
        {printN > 0 && (
          <PrintOnMount key={printN} template="opd-sheet" entityId={saved.encounterId} />
        )}
        <section
          aria-live="polite"
          data-testid="vitals-saved"
          className="space-y-4 rounded-lg border-2 border-money bg-card p-5"
        >
          <h2 className="flex items-center gap-2 text-2xl font-semibold text-money">
            <CheckCircle2 aria-hidden className="size-7" />
            {t('saved', { no: saved.tokenNo })}
          </h2>
          {saved.flags.length === 0 ? (
            <p className="text-lg">{t('allInRange')}</p>
          ) : (
            <ul className="space-y-1" data-testid="saved-flags">
              {saved.flags.map((f) => (
                <li
                  key={f.code}
                  className={cn(
                    'rounded-md border-2 px-3 py-2 text-lg font-semibold',
                    f.level === 'red' ? toneClass.red : toneClass.amber,
                  )}
                >
                  {f.level === 'red' ? '▲▲' : '▲'} {flagLabel(t, f)}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap justify-end gap-3">
            <PrintButton
              template="opd-sheet"
              entityId={saved.encounterId}
              label={t('printSheet')}
              variant="outline"
              shortcut={false}
            />
            <Button asChild autoFocus>
              <Link href="/nursing/vitals">{t('nextPatient')}</Link>
            </Button>
          </div>
        </section>
      </div>
    );
  }

  const showHeight = has('heightCm');
  return (
    <div className="space-y-5">
      {header}

      {!ctx.token.open && (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
          {t('closed')}
        </p>
      )}
      {ctx.current && (
        <p className="rounded-lg border-2 bg-muted p-3" data-testid="vitals-correction">
          {t('correction')}
        </p>
      )}

      {ctx.allowedGroups.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="text-base font-medium">{t('formFor')}</legend>
          <div className="flex flex-wrap gap-2">
            {ctx.allowedGroups.map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={group === g}
                onClick={() => setGroup(g)}
                className={cn(
                  'min-h-12 rounded-md border-2 px-4 text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60',
                  group === g
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-card',
                )}
              >
                {t(`groups.${g}`)}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {alert && (
        <p
          role="status"
          data-testid="alert-raised-bp"
          className="rounded-lg border-2 border-destructive bg-red-50 p-3 text-lg font-semibold text-red-950"
        >
          ▲ {t('flags.raised_bp_pregnancy.alert')}
        </p>
      )}

      {showHeight && ctx.heightDue && (
        <p
          className="rounded-lg border-2 border-amber-600 bg-amber-50 p-3 text-amber-950"
          data-testid="height-prompt"
        >
          {t('heightDue')}
          {ctx.lastHeight && (
            <>
              {' '}
              {t('heightLast', { cm: ctx.lastHeight.cm, date: ctx.lastHeight.on })}{' '}
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => setText((s) => ({ ...s, heightCm: String(ctx.lastHeight!.cm) }))}
              >
                {t('heightUse', { cm: ctx.lastHeight.cm })}
              </button>
            </>
          )}
        </p>
      )}

      <form
        className="grid gap-6 lg:grid-cols-[1fr_20rem]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-5">
          {has('bpSys') && (
            <div className="space-y-1">
              <p className="text-base font-medium">{t('fields.bp')}</p>
              <div className="grid grid-cols-2 gap-4">{BP_FIELDS.map((f) => numberInput(f))}</div>
              {flagText('bp')}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {numeric.map((n) => (
              <div key={n.key} className="space-y-1">
                {numberInput(n.key, n.flag)}
                {n.flag && flagText(n.flag)}
              </div>
            ))}
          </div>
          {GRADE_FIELDS.filter(has).length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {GRADE_FIELDS.filter(has).map(gradeInput)}
            </div>
          )}

          <FormStatus error={error} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setPadOn((v) => !v)}
              aria-pressed={padOn}
            >
              <Keyboard aria-hidden />
              {padOn ? t('padHide') : t('padShow')}
            </Button>
            <div className="flex items-center gap-3">
              <Button asChild variant="outline">
                <Link href="/nursing/vitals">{t('cancel')}</Link>
              </Button>
              <Button
                id="vitals-save"
                type="submit"
                size="lg"
                disabled={!canSave || save.isPending}
              >
                {t('save')}
              </Button>
            </div>
          </div>
        </div>

        {padOn && (
          <div className="lg:sticky lg:top-24 lg:self-start">
            <NumberPad
              allowDecimal={!!active && !NO_DECIMAL.has(active)}
              disabled={!active || (GRADE_FIELDS as readonly string[]).includes(active)}
              onKey={padKey}
              onBackspace={padBack}
              onNext={padNext}
              labels={{
                pad: t('pad.label'),
                backspace: t('pad.backspace'),
                decimalPoint: t('pad.point'),
                next: t('pad.next'),
              }}
            />
          </div>
        )}
      </form>
    </div>
  );
}

/** Loads the form context for a token and shows the form (or why it cannot be shown). */
export function VitalsFormLoader({ tokenId }: { tokenId: string }) {
  const t = useTranslations('vitals');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const ctx = useQuery(
    trpc.vitals.context.queryOptions(
      { tokenId },
      { refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 0 },
    ),
  );
  if (ctx.isError) {
    return (
      <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
        {errorText(ctx.error)}
      </p>
    );
  }
  if (!ctx.data) return <p className="text-lg text-muted-foreground">{t('loading')}</p>;
  return <VitalsForm ctx={ctx.data} />;
}
