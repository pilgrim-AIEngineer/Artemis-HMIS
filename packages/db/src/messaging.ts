/**
 * WhatsApp outbox (MSG-01, docs/21 §4): queueing with the consent check, quiet hours and 24 h
 * de-duplication, and the claim / result steps the worker's sender uses. The counter only ever
 * inserts a row (AGENTS.md rule 11); the worker sends later and retries for 48 h.
 *
 * A row moves `queued` → `sending` (claimed under `FOR UPDATE SKIP LOCKED`, so two workers never
 * take the same one) → `sent`, back to `queued` with a later `send_after` after a temporary error,
 * or `failed`. Rows are never deleted; error text holds provider codes only, never patient data.
 */
import {
  afterQuietHours,
  CLAIM_TIMEOUT_MS,
  isMessageKind,
  MESSAGE_KINDS,
  MESSAGE_TEMPLATES,
  nextRetry,
  normalizeMobile,
  providerTemplateName,
  type MessageKind,
  type MessageLanguage,
} from '@hmis/shared';
import { and, count, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { document, facility, messageOutbox, messageTemplate, patient } from '../schema';
import type { Db } from './client';
import { whatsappConsent } from './paeds';
import { readSettings } from './settings';
import { withTx, type Tx } from './tx';

type Queryable = Db | Tx;

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A batch is small so one slow provider call cannot hold many rows in `sending`. */
export const OUTBOX_BATCH = 20;

// ---------------------------------------------------------------- templates

/** Makes sure every template of the registry has a row (unapproved until the hospital approves it). */
export async function ensureMessageTemplates(tx: Tx, facilityId: string): Promise<number> {
  const rows = MESSAGE_KINDS.flatMap((kind) =>
    (['en', 'hi'] as const).map((language) => ({
      id: uuidv7(),
      facilityId,
      channel: 'whatsapp',
      kind,
      language,
      providerTemplateName: providerTemplateName(kind, language),
      bodyPreview: MESSAGE_TEMPLATES[kind].body[language],
      variables: [...MESSAGE_TEMPLATES[kind].variables],
    })),
  );
  const added = await tx.insert(messageTemplate).values(rows).onConflictDoNothing().returning({
    id: messageTemplate.id,
  });
  return added.length;
}

/** Records Meta's approval decision for the templates (all of them, or one kind). */
export async function setTemplatesApproved(
  tx: Tx,
  facilityId: string,
  approved: boolean,
  kind?: MessageKind,
): Promise<void> {
  await ensureMessageTemplates(tx, facilityId);
  await tx
    .update(messageTemplate)
    .set({ isApproved: approved })
    .where(
      and(
        eq(messageTemplate.facilityId, facilityId),
        kind ? eq(messageTemplate.kind, kind) : undefined,
      ),
    );
}

// ---------------------------------------------------------------- queueing

export type EnqueueSkip =
  'disabled' | 'restricted' | 'no_consent' | 'no_mobile' | 'duplicate' | 'unknown_kind';

export interface EnqueueInput {
  facilityId: string;
  patientId: string;
  kind: MessageKind;
  /** The record the message is about (collection, note, pregnancy …): the de-duplication scope. */
  entityId: string;
  variables: Record<string, unknown>;
  language?: MessageLanguage;
  /** Not before; reminders are moved out of quiet hours (9 pm – 8 am). */
  sendAfter?: Date;
  documentId?: string | null;
  /** Restricted encounters (MTP) never message from here (docs/21 §2). */
  restricted?: boolean;
}

export interface EnqueueResult {
  id: string | null;
  skipped: EnqueueSkip | null;
}

/**
 * Queues one message. Skips (and says why) when WhatsApp is off, the encounter is restricted, the
 * patient has no mobile or the same template for the same patient and entity went out in the last
 * 24 h. Without an active WhatsApp consent (D-9) a `skipped_no_consent` row is kept as the record
 * that nothing was sent.
 */
export async function enqueueMessage(
  tx: Tx,
  input: EnqueueInput,
  now: Date,
): Promise<EnqueueResult> {
  if (!isMessageKind(input.kind)) return { id: null, skipped: 'unknown_kind' };
  if (input.restricted) return { id: null, skipped: 'restricted' };
  const f = input.facilityId;
  const cfg = await readSettings(tx, f, ['whatsapp.enabled']);
  if (!cfg['whatsapp.enabled']) return { id: null, skipped: 'disabled' };

  const [p] = await tx
    .select({ id: patient.id, mobile: patient.mobile })
    .from(patient)
    .where(and(eq(patient.id, input.patientId), eq(patient.facilityId, f)));
  if (!p) return { id: null, skipped: 'no_mobile' };

  const since = new Date(now.getTime() - DEDUPE_WINDOW_MS);
  const [dup] = await tx
    .select({ id: messageOutbox.id })
    .from(messageOutbox)
    .where(
      and(
        eq(messageOutbox.facilityId, f),
        eq(messageOutbox.patientId, p.id),
        eq(messageOutbox.templateKind, input.kind),
        eq(messageOutbox.entityId, input.entityId),
        or(
          and(
            gte(messageOutbox.createdAt, since),
            inArray(messageOutbox.status, ['queued', 'sending', 'sent', 'delivered', 'read']),
          ),
          // Still waiting to go out, however old: never two live copies of one message.
          inArray(messageOutbox.status, ['queued', 'sending']),
        ),
      ),
    )
    .limit(1);
  if (dup) return { id: null, skipped: 'duplicate' };

  const consent = (await whatsappConsent(tx, f, p.id)) === true;
  const mobile = p.mobile ? normalizeMobile(p.mobile) : null;
  if (!consent || !mobile) {
    if (consent) return { id: null, skipped: 'no_mobile' };
    // One record per (kind, entity) of the withheld message, not one per retry of the caller.
    const [seen] = await tx
      .select({ id: messageOutbox.id })
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.facilityId, f),
          eq(messageOutbox.patientId, p.id),
          eq(messageOutbox.templateKind, input.kind),
          eq(messageOutbox.entityId, input.entityId),
          eq(messageOutbox.status, 'skipped_no_consent'),
        ),
      )
      .limit(1);
    if (seen) return { id: null, skipped: 'no_consent' };
    await tx.insert(messageOutbox).values({
      id: uuidv7(),
      facilityId: f,
      patientId: p.id,
      templateKind: input.kind,
      toMobile: mobile ?? '',
      language: input.language ?? 'hi',
      variables: input.variables,
      dedupeKey: `${input.kind}:${p.id}:${input.entityId}:no_consent`,
      status: 'skipped_no_consent',
      sendAfter: now,
      entityId: input.entityId,
    });
    return { id: null, skipped: 'no_consent' };
  }

  const wanted = input.sendAfter ?? now;
  const sendAfter = MESSAGE_TEMPLATES[input.kind].reminder ? afterQuietHours(wanted) : wanted;
  const id = uuidv7();
  const [made] = await tx
    .insert(messageOutbox)
    .values({
      id,
      facilityId: f,
      patientId: p.id,
      templateKind: input.kind,
      toMobile: mobile,
      language: input.language ?? 'hi',
      variables: input.variables,
      dedupeKey: `${input.kind}:${p.id}:${input.entityId}`,
      sendAfter,
      entityId: input.entityId,
      documentId: input.documentId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: messageOutbox.id });
  return made ? { id, skipped: null } : { id: null, skipped: 'duplicate' };
}

// ---------------------------------------------------------------- sending

export interface ClaimedMessage {
  id: string;
  facilityId: string;
  patientId: string;
  kind: string;
  toMobile: string;
  language: MessageLanguage;
  variables: Record<string, unknown>;
  attempts: number;
  firstAttemptAt: Date;
  documentId: string | null;
}

const monthStartIst = (now: Date): Date => {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3_600_000);
};

export interface ClaimResult {
  messages: ClaimedMessage[];
  /** Messages sent this month against the cap (0 = no cap). */
  usage: { sent: number; cap: number };
}

/**
 * Takes the due messages of one facility for sending: puts abandoned claims back first, then
 * claims up to `limit` queued rows with `send_after <= now` (fewer when the monthly cap is near),
 * counting the attempt. Does nothing while `whatsapp.enabled` is off.
 */
export async function claimDueMessages(
  db: Db,
  facilityId: string,
  now: Date,
  limit = OUTBOX_BATCH,
): Promise<ClaimResult> {
  return withTx({ db, userId: null, facilityId }, async (tx) => {
    const cfg = await readSettings(tx, facilityId, ['whatsapp.enabled', 'whatsapp.monthlyCap']);
    const cap = cfg['whatsapp.monthlyCap'];
    const none = { messages: [], usage: { sent: 0, cap } };
    if (!cfg['whatsapp.enabled']) return none;

    await tx
      .update(messageOutbox)
      .set({ status: 'queued' })
      .where(
        and(
          eq(messageOutbox.facilityId, facilityId),
          eq(messageOutbox.status, 'sending'),
          lt(messageOutbox.claimedAt, new Date(now.getTime() - CLAIM_TIMEOUT_MS)),
        ),
      );

    const [{ n: sent = 0 } = {}] = await tx
      .select({ n: count() })
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.facilityId, facilityId),
          gte(messageOutbox.sentAt, monthStartIst(now)),
        ),
      );
    const room = cap === 0 ? limit : Math.max(0, Math.min(limit, cap - sent));
    if (room === 0) return { messages: [], usage: { sent, cap } };

    const due = await tx
      .select({ id: messageOutbox.id })
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.facilityId, facilityId),
          eq(messageOutbox.status, 'queued'),
          lte(messageOutbox.sendAfter, now),
        ),
      )
      .orderBy(messageOutbox.sendAfter, messageOutbox.id)
      .limit(room)
      .for('update', { skipLocked: true });
    if (due.length === 0) return { messages: [], usage: { sent, cap } };

    const rows = await tx
      .update(messageOutbox)
      .set({
        status: 'sending',
        claimedAt: now,
        attempts: sql`${messageOutbox.attempts} + 1`,
        firstAttemptAt: sql`coalesce(${messageOutbox.firstAttemptAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        inArray(
          messageOutbox.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
    return {
      usage: { sent, cap },
      messages: rows.map((r) => ({
        id: r.id,
        facilityId: r.facilityId,
        patientId: r.patientId,
        kind: r.templateKind,
        toMobile: r.toMobile,
        language: r.language as MessageLanguage,
        variables: r.variables as Record<string, unknown>,
        attempts: r.attempts,
        firstAttemptAt: r.firstAttemptAt ?? now,
        documentId: r.documentId,
      })),
    };
  });
}

export interface SendContext {
  hospitalName: string;
  hospitalPhone: string;
  /** Active consent right now: it may have been withdrawn since the row was queued. */
  consent: boolean;
  /** `null`: the template row is missing; `false`: not approved by the provider yet. */
  templateApproved: boolean | null;
  providerTemplateName: string;
  documentPath: string | null;
  documentMime: string | null;
}

/** What the sender needs besides the row: hospital name, template approval, consent, the PDF. */
export async function loadSendContext(db: Db, m: ClaimedMessage): Promise<SendContext> {
  const [f] = await db
    .select({ name: facility.name, phone: facility.phone })
    .from(facility)
    .where(eq(facility.id, m.facilityId));
  const [t] = await db
    .select({ name: messageTemplate.providerTemplateName, approved: messageTemplate.isApproved })
    .from(messageTemplate)
    .where(
      and(
        eq(messageTemplate.facilityId, m.facilityId),
        eq(messageTemplate.channel, 'whatsapp'),
        eq(messageTemplate.kind, m.kind),
        eq(messageTemplate.language, m.language),
      ),
    );
  const [d] = m.documentId
    ? await db
        .select({ path: document.filePath, mime: document.mime })
        .from(document)
        .where(eq(document.id, m.documentId))
    : [];
  return {
    hospitalName: f?.name ?? '',
    hospitalPhone: f?.phone ?? '',
    consent: (await whatsappConsent(db, m.facilityId, m.patientId)) === true,
    templateApproved: t ? t.approved : null,
    providerTemplateName: t?.name ?? providerTemplateName(m.kind as MessageKind, m.language),
    documentPath: d?.path ?? null,
    documentMime: d?.mime ?? null,
  };
}

const short = (s: string) => s.slice(0, 200);

export async function markSent(
  db: Db,
  m: Pick<ClaimedMessage, 'id' | 'facilityId'>,
  providerMessageId: string,
  now: Date,
): Promise<void> {
  await withTx({ db, userId: null, facilityId: m.facilityId }, (tx) =>
    tx
      .update(messageOutbox)
      .set({ status: 'sent', providerMessageId, sentAt: now, lastError: null, claimedAt: null })
      .where(and(eq(messageOutbox.id, m.id), eq(messageOutbox.status, 'sending'))),
  );
}

/** The consent was withdrawn (or never given) by the time of sending: nothing goes out (D-9). */
export async function markSkippedNoConsent(
  db: Db,
  m: Pick<ClaimedMessage, 'id' | 'facilityId'>,
): Promise<void> {
  await withTx({ db, userId: null, facilityId: m.facilityId }, (tx) =>
    tx
      .update(messageOutbox)
      .set({ status: 'skipped_no_consent', claimedAt: null })
      .where(and(eq(messageOutbox.id, m.id), eq(messageOutbox.status, 'sending'))),
  );
}

/**
 * Puts a claimed message back for later without counting it as an attempt: the template is not
 * approved yet, or the monthly cap is reached. `reason` is a short code.
 */
export async function deferMessage(
  db: Db,
  m: Pick<ClaimedMessage, 'id' | 'facilityId'>,
  reason: string,
  until: Date,
): Promise<void> {
  await withTx({ db, userId: null, facilityId: m.facilityId }, (tx) =>
    tx
      .update(messageOutbox)
      .set({
        status: 'queued',
        sendAfter: until,
        lastError: short(reason),
        claimedAt: null,
        attempts: sql`greatest(${messageOutbox.attempts} - 1, 0)`,
        firstAttemptAt: sql`case when ${messageOutbox.attempts} <= 1 then null else ${messageOutbox.firstAttemptAt} end`,
      })
      .where(and(eq(messageOutbox.id, m.id), eq(messageOutbox.status, 'sending'))),
  );
}

/** After a failed attempt: retry with backoff until 48 h after the first attempt, then `failed`. */
export async function markAttemptFailed(
  db: Db,
  m: Pick<ClaimedMessage, 'id' | 'facilityId' | 'attempts' | 'firstAttemptAt'>,
  error: { message: string; retryable: boolean },
  now: Date,
): Promise<'queued' | 'failed'> {
  const d = nextRetry({
    attempts: m.attempts,
    firstDueAt: m.firstAttemptAt,
    now,
    retryable: error.retryable,
  });
  await withTx({ db, userId: null, facilityId: m.facilityId }, (tx) =>
    tx
      .update(messageOutbox)
      .set(
        d.action === 'retry'
          ? { status: 'queued', sendAfter: d.at!, lastError: short(error.message), claimedAt: null }
          : { status: 'failed', lastError: short(error.message), claimedAt: null },
      )
      .where(and(eq(messageOutbox.id, m.id), eq(messageOutbox.status, 'sending'))),
  );
  return d.action === 'retry' ? 'queued' : 'failed';
}

/** Opt-out ("STOP", docs/21 §2): queued messages of the patient stop at once. */
export async function cancelQueuedMessages(
  tx: Tx,
  facilityId: string,
  patientId: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(messageOutbox)
    .set({ status: 'opted_out', cancelReason: reason })
    .where(
      and(
        eq(messageOutbox.facilityId, facilityId),
        eq(messageOutbox.patientId, patientId),
        eq(messageOutbox.status, 'queued'),
      ),
    )
    .returning({ id: messageOutbox.id });
  return rows.length;
}

/** Facilities whose WhatsApp is on: the sender and the daily reminders loop over these. */
export async function activeFacilityIds(db: Queryable): Promise<string[]> {
  const rows = await db
    .select({ id: facility.id })
    .from(facility)
    .where(eq(facility.isActive, true));
  return rows.map((r) => r.id);
}
