'use client';

import { istDateString, type RxPhrasesOverride } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { PatientHeader, type PatientHeaderFlag } from '@hmis/ui/components/patient-header';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { CheckCircle2, Eraser, History } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { uuidv7 } from 'uuidv7';
import { FormStatus } from '@/components/form/text-field';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useAgeText } from '@/lib/use-age-text';
import { useErrorText } from '@/lib/use-error-text';
import { useShortcut } from '@/lib/use-shortcut';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';
import { MedicinesGrid, ShorthandEntry } from './medicines-tab';
import { FollowUpTab, NotesTab, OrdersTab, type ServiceInfo } from './other-tabs';
import {
  clearLocalDraft,
  emptyState,
  fromDraft,
  hasContent,
  pickDraft,
  readLocalDraft,
  rowsFromSaved,
  toDraft,
  toSaveInput,
  warningsOf,
  writeLocalDraft,
  type RxState,
  type StoredDraft,
} from './rx-state';
import { ScanPanel } from './scan-panel';

type Context = inferRouterOutputs<AppRouter>['rx']['context'];
type Saved = inferRouterOutputs<AppRouter>['rx']['save'];

const TABS = ['medicines', 'orders', 'notes', 'followUp'] as const;
type Tab = (typeof TABS)[number];

/** docs/01 §3: drafts go to the browser every 5 s and to the server every 20 s. */
const LOCAL_EVERY_MS = 5_000;
const SERVER_EVERY_MS = 20_000;

/** The screen's starting point: the saved Rx (a correction), else empty with the latest photo. */
function initialState(ctx: Context): RxState {
  const scanIds = ctx.scans.map((s) => s.id);
  const scan =
    ctx.current?.scanDocumentId && scanIds.includes(ctx.current.scanDocumentId)
      ? ctx.current.scanDocumentId
      : (scanIds.at(-1) ?? null);
  const admission = ctx.orders.find((o) => o.kind === 'admission');
  return {
    ...emptyState(scan),
    rows: ctx.current ? rowsFromSaved(ctx.current.items) : [],
    orders: ctx.orders.flatMap((o) => (o.kind !== 'admission' && o.serviceId ? [o.serviceId] : [])),
    admission: admission
      ? { advised: true, expectedDate: admission.expectedDate, note: admission.notes }
      : { advised: false, expectedDate: null, note: null },
    note: ctx.note
      ? {
          complaints: ctx.note.complaints,
          complaintsText: ctx.note.complaintsText,
          diagnosis: ctx.note.diagnosis,
          advice: ctx.note.advice,
          adviceText: ctx.note.adviceText,
        }
      : emptyState().note,
    followUpDate: ctx.note?.followUpDate ?? null,
  };
}

/**
 * Rx transcription screen (OPD-02 … OPD-04, docs/11 §2): paper photo on the left (40%), and on
 * the right the tabs in order of use — Medicines, Orders, Notes & diagnosis, Follow-up. The
 * shorthand line is the fastest path; every parsed field stays editable. The draft is kept in
 * the browser every 5 s and on the server every 20 s and offered back after a reload.
 */
export function RxScreen({ ctx, onReload }: { ctx: Context; onReload: () => void }) {
  const t = useTranslations('rx');
  const tQ = useTranslations('queue');
  const ageText = useAgeText();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const encounterId = ctx.encounter.id;
  const phrases = ctx.settings.hindiPhrases as RxPhrasesOverride;

  const [state, setState] = useState<RxState>(() => initialState(ctx));
  const [tab, setTab] = useState<Tab>('medicines');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [cleared, setCleared] = useState<RxState['rows'] | null>(null);
  const [savedAt, setSavedAt] = useState<{ local: Date | null; server: Date | null }>({
    local: null,
    server: null,
  });
  const lineRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());

  // ---- draft restore offer (decided once, on the first render)
  const [offer, setOffer] = useState<(StoredDraft & { from: 'local' | 'server' }) | null>(() => {
    if (typeof window === 'undefined') return null;
    const server = ctx.draft
      ? { savedAt: new Date(ctx.draft.savedAt).toISOString(), payload: ctx.draft.payload }
      : null;
    const d = pickDraft(readLocalDraft(encounterId), server, ctx.current?.enteredAt ?? null);
    return d && hasContent(fromDraft(d.payload)) ? d : null;
  });
  const discard = useMutation(trpc.rx.discardDraft.mutationOptions());

  // ---- known services (names for the order chips)
  const [known, setKnown] = useState(() => {
    const m = new Map<string, ServiceInfo>();
    for (const q of ctx.quickOrders) for (const s of q.services) m.set(s.id, s);
    for (const o of ctx.orders) {
      if (o.serviceId && o.name)
        m.set(o.serviceId, { id: o.serviceId, name: o.name, kind: o.kind });
    }
    return m;
  });
  const locked = useMemo(
    () => new Set(ctx.orders.flatMap((o) => (o.onBill && o.serviceId ? [o.serviceId] : []))),
    [ctx.orders],
  );

  // ---- autosave
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
  const [startJson] = useState(() => JSON.stringify(toDraft(state)));
  const lastLocal = useRef(startJson);
  const lastServer = useRef(startJson);
  const saveDraft = useMutation(trpc.rx.saveDraft.mutationOptions());
  const autosaving = !saved && !offer && ctx.encounter.open;
  useEffect(() => {
    if (!autosaving) return;
    const local = setInterval(() => {
      const json = JSON.stringify(toDraft(latest.current));
      if (json === lastLocal.current) return;
      lastLocal.current = json;
      const at = new Date();
      writeLocalDraft(encounterId, { savedAt: at.toISOString(), payload: toDraft(latest.current) });
      setSavedAt((s) => ({ ...s, local: at }));
    }, LOCAL_EVERY_MS);
    const server = setInterval(() => {
      const payload = toDraft(latest.current);
      const json = JSON.stringify(payload);
      if (json === lastServer.current || !hasContent(latest.current)) return;
      saveDraft.mutate(
        { encounterId, payload },
        {
          onSuccess: (r) => {
            lastServer.current = json;
            setSavedAt((s) => ({ ...s, server: new Date(r.savedAt) }));
          },
        },
      );
    }, SERVER_EVERY_MS);
    return () => {
      clearInterval(local);
      clearInterval(server);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intervals read the latest state via a ref
  }, [autosaving, encounterId]);

  // ---- save
  const warnings = useMemo(() => warningsOf(state.rows), [state.rows]);
  const payloadJson = JSON.stringify(toDraft(state));
  // One key per content: a double click or a retry of the same Rx replays the first result.
  const idemKey = useMemo(() => uuidv7(), [payloadJson]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation(
    trpc.rx.save.mutationOptions({
      onSuccess: (r) => {
        setSaved(r);
        setError(null);
        clearLocalDraft(encounterId);
        // The list only: refetching this visit's context now would replace the "saved" panel.
        void queryClient.invalidateQueries({ queryKey: trpc.rx.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.queue.pathKey() });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const needPhoto = ctx.settings.requirePhoto && !state.scanDocumentId;
  const canSave =
    ctx.encounter.open && !needPhoto && !save.isPending && !offer && hasContent(state);
  const submit = () => {
    if (!canSave) return;
    if (state.line.trim()) {
      setError(t('lineNotAdded'));
      setTab('medicines');
      lineRef.current?.focus();
      return;
    }
    save.mutate(toSaveInput(state, encounterId, idemKey, phrases));
  };
  useShortcut('Ctrl+Enter', submit, !saved);

  // ---- repeat last Rx / clear
  const repeatLast = async () => {
    const last = await queryClient.fetchQuery(trpc.rx.lastRx.queryOptions({ encounterId }));
    if (!last) return;
    setState((s) => ({ ...s, rows: [...s.rows, ...rowsFromSaved(last.items)] }));
  };
  useEffect(() => {
    if (!cleared) return;
    const id = setTimeout(() => setCleared(null), 10_000);
    return () => clearTimeout(id);
  }, [cleared]);

  const header = (
    <PatientHeader
      name={ctx.patient.fullName}
      nameHi={ctx.patient.nameHi}
      ageSex={`${ageText(ctx.patient.dob)} / ${tQ(`sex.${ctx.patient.sex as 'F' | 'M' | 'O'}`)}`}
      uhid={ctx.patient.uhid}
      mobileLast4={ctx.patient.mobileLast4}
      mobileLabel={t('mobile')}
      flags={[
        ...(ctx.pregnantForm ? [{ label: t('pregnant'), tone: 'warn' } as PatientHeaderFlag] : []),
        ...(ctx.weightKg
          ? [{ label: t('weight', { kg: ctx.weightKg }), tone: 'muted' } as PatientHeaderFlag]
          : []),
      ]}
    />
  );

  if (saved) {
    return (
      <div className="space-y-5">
        {header}
        <section
          aria-live="polite"
          data-testid="rx-saved"
          className="space-y-3 rounded-lg border-2 border-money bg-card p-5"
        >
          <h2 className="flex items-center gap-2 text-2xl font-semibold text-money">
            <CheckCircle2 aria-hidden className="size-7" />
            {saved.version > 1
              ? t('saved.corrected', { version: saved.version })
              : t('saved.title')}
          </h2>
          {saved.tokenNo !== null && (
            <p className="text-lg">{t('saved.token', { no: saved.tokenNo })}</p>
          )}
          {saved.ordersAdded > 0 && (
            <p className="text-lg">{t('saved.orders', { count: saved.ordersAdded })}</p>
          )}
          {saved.needsVerification && <p className="text-lg">{t('saved.verify')}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="outline" onClick={onReload}>
              {t('saved.editAgain')}
            </Button>
            <Button asChild autoFocus size="lg">
              <Link href="/assistant/rx">{t('saved.next')}</Link>
            </Button>
          </div>
        </section>
      </div>
    );
  }

  const tabKey = (e: KeyboardEvent, i: number) => {
    const n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!n) return;
    e.preventDefault();
    const next = TABS[(i + n + TABS.length) % TABS.length]!;
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };
  const countOf: Record<Tab, number> = {
    medicines: state.rows.length,
    orders: state.orders.length + (state.admission.advised ? 1 : 0),
    notes: state.note.complaints.length + state.note.advice.length + (state.note.diagnosis ? 1 : 0),
    followUp: state.followUpDate ? 1 : 0,
  };

  return (
    <div className="space-y-4">
      {header}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {ctx.current ? t('titleCorrect', { version: ctx.current.version }) : t('title')}
        </h1>
        <p className="text-muted-foreground">
          {t('visitLine', {
            number: ctx.encounter.number,
            doctor: ctx.doctor.displayName,
            token: ctx.token?.tokenNo ?? '—',
          })}
        </p>
      </div>

      {!ctx.encounter.open && (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
          {t('closed')}
        </p>
      )}

      {offer && (
        <section
          role="alertdialog"
          aria-labelledby="rx-restore-title"
          data-testid="rx-restore"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-amber-600 bg-amber-50 p-4 text-amber-950"
        >
          <p id="rx-restore-title" className="text-lg font-semibold">
            {t('restore.question', {
              time: new Date(offer.savedAt).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
              }),
            })}
          </p>
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                clearLocalDraft(encounterId);
                if (ctx.draft) discard.mutate({ encounterId });
                setOffer(null);
              }}
            >
              {t('restore.discard')}
            </Button>
            <Button
              type="button"
              autoFocus
              onClick={() => {
                setState(fromDraft(offer.payload));
                setOffer(null);
              }}
            >
              {t('restore.restore')}
            </Button>
          </div>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-[2fr_3fr]">
        <ScanPanel
          encounterId={encounterId}
          documentId={state.scanDocumentId}
          disabled={!ctx.encounter.open}
          onAttached={(id) => setState((s) => ({ ...s, scanDocumentId: id }))}
        />

        <div className="min-w-0 space-y-4">
          <div
            role="tablist"
            aria-label={t('tabsLabel')}
            className="flex flex-wrap gap-2 border-b-2 pb-2"
          >
            {TABS.map((k, i) => (
              <button
                key={k}
                ref={(el) => {
                  if (el) tabRefs.current.set(k, el);
                }}
                id={`rx-tab-${k}`}
                type="button"
                role="tab"
                aria-selected={tab === k}
                aria-controls={`rx-panel-${k}`}
                tabIndex={tab === k ? 0 : -1}
                onClick={() => setTab(k)}
                onKeyDown={(e) => tabKey(e, i)}
                className={cn(
                  'min-h-12 rounded-md px-4 text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60',
                  tab === k ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                {t(`tabs.${k}`)}
                {countOf[k] > 0 && <span className="ml-2 tabular-nums">({countOf[k]})</span>}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`rx-panel-${tab}`}
            aria-labelledby={`rx-tab-${tab}`}
            className="space-y-4"
          >
            {tab === 'medicines' && (
              <>
                <ShorthandEntry
                  encounterId={encounterId}
                  line={state.line}
                  onLineChange={(line) => setState((s) => ({ ...s, line }))}
                  onAdd={(row) => setState((s) => ({ ...s, rows: [...s.rows, row] }))}
                  phrases={phrases}
                  inputRef={lineRef}
                  disabled={!ctx.encounter.open || !!offer}
                />
                <div className="flex flex-wrap gap-2">
                  {ctx.hasLastRx && (
                    <Button type="button" variant="outline" onClick={() => void repeatLast()}>
                      <History aria-hidden />
                      {t('med.repeatLast')}
                    </Button>
                  )}
                  {state.rows.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setCleared(state.rows);
                        setState((s) => ({ ...s, rows: [] }));
                      }}
                    >
                      <Eraser aria-hidden />
                      {t('med.clear')}
                    </Button>
                  )}
                  {cleared && (
                    <p role="status" className="flex items-center gap-2">
                      {t('med.cleared')}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setState((s) => ({ ...s, rows: [...cleared, ...s.rows] }));
                          setCleared(null);
                        }}
                      >
                        {t('med.undo')}
                      </Button>
                    </p>
                  )}
                </div>
                <MedicinesGrid
                  encounterId={encounterId}
                  rows={state.rows}
                  warnings={warnings}
                  phrases={phrases}
                  disabled={!ctx.encounter.open}
                  onChange={(rows) => setState((s) => ({ ...s, rows }))}
                />
              </>
            )}
            {tab === 'orders' && (
              <OrdersTab
                quick={ctx.quickOrders}
                orders={state.orders}
                locked={locked}
                known={known}
                onKnown={(s) => setKnown((m) => new Map(m).set(s.id, s))}
                onOrders={(orders) => setState((s) => ({ ...s, orders }))}
                admission={state.admission}
                onAdmission={(admission) => setState((s) => ({ ...s, admission }))}
                today={istDateString(new Date())}
              />
            )}
            {tab === 'notes' && (
              <NotesTab
                note={state.note}
                chips={ctx.chips}
                required={ctx.settings.notesRequired}
                onNote={(note) => setState((s) => ({ ...s, note }))}
              />
            )}
            {tab === 'followUp' && (
              <FollowUpTab
                date={state.followUpDate}
                now={new Date()}
                onDate={(followUpDate) => setState((s) => ({ ...s, followUpDate }))}
              />
            )}
          </div>

          <div className="sticky bottom-0 space-y-2 border-t-2 bg-background pt-3">
            {needPhoto && (
              <p className="font-medium text-amber-900" data-testid="rx-need-photo">
                ▲ {t('needPhoto')}
              </p>
            )}
            {warnings.length > 0 && (
              <p className="font-medium text-amber-900">
                {t('warningsSummary', { count: warnings.length })}
              </p>
            )}
            <FormStatus error={error} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p
                className="text-sm text-muted-foreground"
                aria-live="polite"
                data-testid="rx-autosave"
              >
                {savedAt.server
                  ? t('draft.server', { time: hhmm(savedAt.server) })
                  : savedAt.local
                    ? t('draft.local', { time: hhmm(savedAt.local) })
                    : t('draft.none')}
              </p>
              <div className="flex gap-3">
                <Button asChild variant="outline">
                  <Link href="/assistant/rx">{t('back')}</Link>
                </Button>
                <Button id="rx-save" type="button" size="lg" disabled={!canSave} onClick={submit}>
                  {save.isPending ? t('saving') : t('save')}
                  <ShortcutHint keys="Ctrl+Enter" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const hhmm = (d: Date) =>
  d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

/** Loads the context of a visit and shows the screen (or why it cannot be shown). */
export function RxScreenLoader({ encounterId }: { encounterId: string }) {
  const t = useTranslations('rx');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const ctx = useQuery(
    trpc.rx.context.queryOptions(
      { encounterId },
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
  return (
    <RxScreen
      key={`${ctx.data.encounter.id}:${ctx.data.current?.version ?? 0}`}
      ctx={ctx.data}
      onReload={() => void ctx.refetch()}
    />
  );
}
