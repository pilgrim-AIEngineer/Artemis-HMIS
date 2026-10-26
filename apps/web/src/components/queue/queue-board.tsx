'use client';

import { formatINR, URGENT_PRIORITIES, type QueuePriority, type QueueState } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import {
  BellRing,
  Check,
  Megaphone,
  SkipForward,
  UserX,
  ArrowRightLeft,
  Flag,
  Undo2,
  Ticket,
  HeartPulse,
  NotebookPen,
} from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { PrintButton } from '@/components/print/print-button';
import { PrintOnMount } from '@/components/print/print-on-mount';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useAgeText } from '@/lib/use-age-text';
import { useErrorText } from '@/lib/use-error-text';
import { useLiveQueue } from '@/lib/use-live-queue';
import { useShortcut } from '@/lib/use-shortcut';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';
import { NoShowDialog, PriorityDialog, TransferDialog } from './queue-dialogs';

type Board = inferRouterOutputs<AppRouter>['queue']['board'];
type Card = Board['columns'][number]['active'][number];
type Dialogue = { kind: 'noShow' | 'transfer' | 'priority'; card: Card; doctorId: string } | null;

const DOCTOR_KEY = 'hmis.queue.doctor';
const PENDING: QueueState[] = ['waiting', 'vitals_done'];
/** The doctor has seen the patient: the paper Rx can be typed (OPD-02), or corrected. */
const RX_STATES: QueueState[] = ['with_doctor', 'seen', 'rx_entered', 'billed_orders'];

const stateTone: Record<QueueState, string> = {
  waiting: 'border-input bg-muted text-foreground',
  vitals_done: 'border-primary text-primary',
  with_doctor: 'border-money bg-money text-money-foreground',
  seen: 'border-money text-money',
  rx_entered: 'border-money text-money',
  billed_orders: 'border-money text-money',
  done: 'border-input text-muted-foreground',
  no_show: 'border-destructive text-destructive',
  cancelled: 'border-destructive text-destructive',
};

/**
 * Queue screen (REG-04, docs/10 §5) for reception, the vitals desk and the doctor room: one column
 * per doctor, cards ordered by priority then token, and the actions each role may do. Updates
 * arrive over SSE; without a stream the board polls every 5 s (see `useLiveQueue`). `mode = room`
 * adds the one-doctor picker and the big "Call next" for a doctor-room tablet. The server checks
 * every action again; the buttons shown here follow the session's permissions only for tidiness.
 */
export function QueueBoard({ mode }: { mode: 'desk' | 'room' }) {
  const t = useTranslations('queue');
  const errorText = useErrorText();
  const ageText = useAgeText();
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { me } = useSession();
  const can = (p: string) => me.permissions.includes(p as never);
  const canCall = can('queue.call');
  const canManage = can('queue.manage');
  const canRelease = can('billing.payment.collect');
  const canVitals = can('vitals.record');
  const canRx = can('rx.transcribe');
  const canPrint = can('patient.view');

  const { live, refetchInterval } = useLiveQueue();
  const board = useQuery(trpc.queue.board.queryOptions({}, { refetchInterval }));

  // The doctor last chosen on this workstation; read only once the board has loaded (client only).
  const [picked, setPicked] = useState<string | null>(null);
  const doctorId = picked ?? (board.data ? window.localStorage.getItem(DOCTOR_KEY) : null) ?? 'all';
  const chooseDoctor = (id: string) => {
    setPicked(id);
    window.localStorage.setItem(DOCTOR_KEY, id);
  };

  // Waiting minutes tick once a minute without a request.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const [message, setMessage] = useState<string | null>(null);
  const [dialogue, setDialogue] = useState<Dialogue>(null);
  // OPD sheet to print right now (after the vitals); a new `n` prints again.
  const [sheet, setSheet] = useState<{ encounterId: string; n: number } | null>(null);
  const done = () => {
    setMessage(null);
    setDialogue(null);
    void queryClient.invalidateQueries({ queryKey: [['queue']] });
  };
  const opts = { onSuccess: done, onError: (e: unknown) => setMessage(errorText(e)) };
  const vitalsDone = useMutation(
    trpc.queue.vitalsDone.mutationOptions({
      onSuccess: (r) => {
        done();
        if (r.printSheet) setSheet((s) => ({ encounterId: r.encounterId, n: (s?.n ?? 0) + 1 }));
      },
      onError: opts.onError,
    }),
  );
  const callNext = useMutation(trpc.queue.callNext.mutationOptions(opts));
  const sendIn = useMutation(trpc.queue.sendIn.mutationOptions(opts));
  const recall = useMutation(trpc.queue.recall.mutationOptions(opts));
  const skip = useMutation(trpc.queue.skip.mutationOptions(opts));
  const seen = useMutation(trpc.queue.markSeen.mutationOptions(opts));
  const finish = useMutation(trpc.queue.markDone.mutationOptions(opts));
  const noShow = useMutation(trpc.queue.markNoShow.mutationOptions(opts));
  const reinstate = useMutation(trpc.queue.reinstate.mutationOptions(opts));
  const transfer = useMutation(trpc.queue.transfer.mutationOptions(opts));
  const priority = useMutation(trpc.queue.setPriority.mutationOptions(opts));
  const issue = useMutation(trpc.visit.issueToken.mutationOptions(opts));
  const busy = [
    callNext,
    sendIn,
    recall,
    skip,
    seen,
    finish,
    noShow,
    reinstate,
    transfer,
    priority,
    issue,
    vitalsDone,
  ].some((m) => m.isPending);

  const data = board.data;
  const doctorName = (d: { displayName: string; displayNameHi: string | null }) =>
    locale === 'hi' && d.displayNameHi ? d.displayNameHi : d.displayName;
  const columns = useMemo(
    () =>
      (data?.columns ?? []).filter(
        (c) => mode === 'desk' || doctorId === 'all' || c.doctor.id === doctorId,
      ),
    [data, mode, doctorId],
  );
  const singleDoctor = mode === 'room' && columns.length === 1 ? columns[0]! : null;
  const nextPending = (c: Board['columns'][number]) =>
    c.active.some((x) => PENDING.includes(x.queueState));
  useShortcut(
    'F4',
    () =>
      singleDoctor &&
      canCall &&
      nextPending(singleDoctor) &&
      callNext.mutate({ doctorId: singleDoctor.doctor.id }),
    mode === 'room',
  );

  const minutes = (c: Card) => {
    const end = c.calledAt ?? new Date(now);
    return Math.max(0, Math.round((end.getTime() - c.issuedAt.getTime()) / 60_000));
  };
  const doctorOptions = (data?.columns ?? []).map((c) => ({
    id: c.doctor.id,
    name: doctorName(c.doctor),
  }));

  const actions = (c: Card, doctor: string) => {
    const pending = PENDING.includes(c.queueState);
    const calling = c.queueState === 'with_doctor';
    return (
      <div className="flex flex-wrap gap-2">
        {canVitals && c.queueState === 'waiting' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => vitalsDone.mutate({ tokenId: c.tokenId })}
          >
            <HeartPulse aria-hidden />
            {t('vitalsDone')}
          </Button>
        )}
        {canVitals && PENDING.includes(c.queueState) && (
          <Button asChild size="sm" variant={c.queueState === 'waiting' ? 'default' : 'outline'}>
            <Link href={`/nursing/vitals/${c.tokenId}`}>
              <HeartPulse aria-hidden />
              {c.queueState === 'waiting' ? t('enterVitals') : t('editVitals')}
            </Link>
          </Button>
        )}
        {canRx && RX_STATES.includes(c.queueState) && (
          <Button asChild size="sm" variant={c.queueState === 'seen' ? 'default' : 'outline'}>
            <Link href={`/assistant/rx/${c.encounterId}`}>
              <NotebookPen aria-hidden />
              {c.queueState === 'rx_entered' || c.queueState === 'billed_orders'
                ? t('editRx')
                : t('enterRx')}
            </Link>
          </Button>
        )}
        {canPrint && (pending || calling) && (
          <PrintButton
            template="opd-sheet"
            entityId={c.encounterId}
            label={t('printSheet')}
            variant="outline"
            size="sm"
            shortcut={false}
          />
        )}
        {canCall && pending && (
          <Button size="sm" disabled={busy} onClick={() => sendIn.mutate({ tokenId: c.tokenId })}>
            <Megaphone aria-hidden />
            {t('sendIn')}
          </Button>
        )}
        {canCall && calling && (
          <>
            <Button size="sm" disabled={busy} onClick={() => seen.mutate({ tokenId: c.tokenId })}>
              <Check aria-hidden />
              {t('seen')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => recall.mutate({ tokenId: c.tokenId })}
            >
              <BellRing aria-hidden />
              {t('recall')}
            </Button>
          </>
        )}
        {canCall && (pending || calling) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => skip.mutate({ tokenId: c.tokenId })}
          >
            <SkipForward aria-hidden />
            {t('skip')}
          </Button>
        )}
        {canCall && ['seen', 'rx_entered', 'billed_orders'].includes(c.queueState) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => finish.mutate({ tokenId: c.tokenId })}
          >
            <Check aria-hidden />
            {t('done')}
          </Button>
        )}
        {canManage && (pending || calling) && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setDialogue({ kind: 'transfer', card: c, doctorId: doctor })}
            >
              <ArrowRightLeft aria-hidden />
              {t('transfer')}
            </Button>
            {pending && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setDialogue({ kind: 'priority', card: c, doctorId: doctor })}
              >
                <Flag aria-hidden />
                {t('priority')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setDialogue({ kind: 'noShow', card: c, doctorId: doctor })}
            >
              <UserX aria-hidden />
              {t('noShow')}
            </Button>
          </>
        )}
        {canManage && c.queueState === 'no_show' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => reinstate.mutate({ tokenId: c.tokenId })}
          >
            <Undo2 aria-hidden />
            {t('reinstate')}
          </Button>
        )}
      </div>
    );
  };

  const tokenCard = (c: Card, doctor: string) => {
    const urgent = URGENT_PRIORITIES.includes(c.priority);
    return (
      <li
        data-testid={`token-${c.tokenNo}`}
        data-state={c.queueState}
        className={cn(
          'space-y-3 rounded-lg border-2 bg-card p-4',
          urgent && 'border-destructive bg-destructive/5',
          c.queueState === 'with_doctor' && 'border-money',
        )}
      >
        <div className="flex items-start gap-4">
          <p
            className="min-w-14 text-center text-4xl font-bold tabular-nums"
            aria-label={t('tokenNo', { no: c.tokenNo })}
          >
            {c.tokenNo}
          </p>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-semibold">
              {locale === 'hi' && c.nameHi ? c.nameHi : c.fullName}
            </p>
            <p className="text-muted-foreground tabular-nums">
              {ageText(c.dob)} / {t(`sex.${c.sex as 'F' | 'M' | 'O'}`)} · {c.uhid}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span
                className={cn(
                  'rounded-full border-2 px-2.5 py-0.5 font-medium',
                  stateTone[c.queueState],
                )}
              >
                {t(`states.${c.queueState}`)}
              </span>
              <span className="rounded-full border-2 border-input px-2.5 py-0.5">
                {t(`visitTypes.${c.visitType}`)}
              </span>
              {c.priority !== 'normal' && (
                <span
                  className={cn(
                    'rounded-full border-2 px-2.5 py-0.5 font-semibold',
                    urgent
                      ? 'border-destructive bg-destructive text-destructive-foreground'
                      : 'border-primary text-primary',
                  )}
                >
                  {t(`priorities.${c.priority as QueuePriority}`)}
                </span>
              )}
              {['waiting', 'vitals_done', 'with_doctor'].includes(c.queueState) && (
                <span className="text-muted-foreground tabular-nums">
                  {t('waited', { minutes: minutes(c) })}
                </span>
              )}
              {c.stateReason && <span className="text-muted-foreground">{c.stateReason}</span>}
            </div>
          </div>
        </div>
        {actions(c, doctor)}
      </li>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold">
          {mode === 'room' ? t('roomTitle') : t('deskTitle')}
        </h1>
        <p
          className={cn(
            'rounded-full border-2 px-3 py-1 text-sm font-medium',
            live ? 'border-money text-money' : 'border-input text-muted-foreground',
          )}
          role="status"
          data-testid="live-status"
        >
          {live ? t('live') : t('polling')}
        </p>
      </div>

      {mode === 'room' && (
        <div role="group" aria-label={t('chooseDoctor')} className="flex flex-wrap gap-2">
          {[{ id: 'all', name: t('allDoctors') }, ...doctorOptions].map((d) => (
            <Button
              key={d.id}
              variant={doctorId === d.id ? 'default' : 'outline'}
              aria-pressed={doctorId === d.id}
              onClick={() => chooseDoctor(d.id)}
            >
              {d.name}
            </Button>
          ))}
        </div>
      )}

      {message && (
        <p
          role="alert"
          className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive"
        >
          {message}
        </p>
      )}
      {board.isError && !data && (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-destructive">
          {t('loadFailed')}
        </p>
      )}
      {board.isPending && (
        <div className="h-40 animate-pulse rounded-lg bg-muted" aria-busy="true" />
      )}
      {data && columns.length === 0 && (
        <p className="text-lg text-muted-foreground">{t('noDoctors')}</p>
      )}

      {canManage && data && data.awaitingToken.length > 0 && mode === 'desk' && (
        <section
          aria-labelledby="awaiting"
          className="space-y-3 rounded-lg border-2 border-primary p-4"
        >
          <div>
            <h2 id="awaiting" className="text-xl font-semibold">
              {t('awaitingTitle')}
            </h2>
            <p className="text-muted-foreground">{t('awaitingHint')}</p>
          </div>
          <ul className="divide-y">
            {data.awaitingToken.map((a) => (
              <li
                key={a.encounterId}
                className="flex flex-wrap items-center justify-between gap-3 py-2"
              >
                <div>
                  <p className="text-lg font-medium">
                    {a.fullName}{' '}
                    <span className="text-muted-foreground tabular-nums">{a.uhid}</span>
                  </p>
                  <p className="text-muted-foreground">
                    {t(`visitTypes.${a.visitType}`)} ·{' '}
                    {a.feeBasis === 'no_rule' || a.feeBasis === 'no_rate'
                      ? t('feeNotSet')
                      : t('feeToCollect', { amount: formatINR(BigInt(a.feePaise)) })}
                  </p>
                </div>
                {canRelease && (
                  <Button
                    variant="money"
                    disabled={busy}
                    onClick={() => issue.mutate({ encounterId: a.encounterId })}
                  >
                    <Ticket aria-hidden />
                    {t('giveToken')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {columns.map((col) => {
          const waiting = col.active.filter((x) => PENDING.includes(x.queueState)).length;
          return (
            <section
              key={col.doctor.id}
              aria-labelledby={`col-${col.doctor.id}`}
              className="space-y-3 rounded-lg border bg-muted/30 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 id={`col-${col.doctor.id}`} className="text-xl font-semibold">
                    {doctorName(col.doctor)}
                  </h2>
                  <p className="text-muted-foreground">{t('waitingCount', { count: waiting })}</p>
                </div>
                {canCall && (
                  <Button
                    size={mode === 'room' ? 'lg' : 'default'}
                    disabled={busy || waiting === 0}
                    onClick={() => callNext.mutate({ doctorId: col.doctor.id })}
                  >
                    <Megaphone aria-hidden />
                    {t('callNext')}
                    {singleDoctor && <ShortcutHint keys="F4" />}
                  </Button>
                )}
              </div>
              {col.active.length === 0 ? (
                <p className="text-muted-foreground">{t('emptyColumn')}</p>
              ) : (
                <ul
                  className="space-y-3"
                  aria-label={t('queueOf', { name: doctorName(col.doctor) })}
                >
                  {col.active.map((c) => (
                    <Fragment key={c.tokenId}>{tokenCard(c, col.doctor.id)}</Fragment>
                  ))}
                </ul>
              )}
              {col.finished.length > 0 && (
                <details className="rounded-lg border bg-card p-3">
                  <summary className="min-h-11 cursor-pointer py-2 font-medium">
                    {t('finished', { count: col.finished.length })}
                  </summary>
                  <ul className="mt-3 space-y-3">
                    {col.finished.map((c) => (
                      <Fragment key={c.tokenId}>{tokenCard(c, col.doctor.id)}</Fragment>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          );
        })}
      </div>

      {sheet && <PrintOnMount key={sheet.n} template="opd-sheet" entityId={sheet.encounterId} />}

      {dialogue?.kind === 'noShow' && (
        <NoShowDialog
          open
          onOpenChange={(o) => !o && setDialogue(null)}
          tokenNo={dialogue.card.tokenNo}
          pending={noShow.isPending}
          onConfirm={(reason) => noShow.mutate({ tokenId: dialogue.card.tokenId, reason })}
        />
      )}
      {dialogue?.kind === 'transfer' && (
        <TransferDialog
          open
          onOpenChange={(o) => !o && setDialogue(null)}
          tokenNo={dialogue.card.tokenNo}
          pending={transfer.isPending}
          doctors={doctorOptions}
          currentDoctorId={dialogue.doctorId}
          onConfirm={(id) => transfer.mutate({ tokenId: dialogue.card.tokenId, doctorId: id })}
        />
      )}
      {dialogue?.kind === 'priority' && (
        <PriorityDialog
          open
          onOpenChange={(o) => !o && setDialogue(null)}
          tokenNo={dialogue.card.tokenNo}
          pending={priority.isPending}
          current={dialogue.card.priority}
          onConfirm={(p) => priority.mutate({ tokenId: dialogue.card.tokenId, priority: p })}
        />
      )}
    </div>
  );
}
