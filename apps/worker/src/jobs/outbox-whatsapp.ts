import { readFile } from 'node:fs/promises';
import {
  claimDueMessages,
  activeFacilityIds,
  deferMessage,
  ensureMessageTemplates,
  loadSendContext,
  markAttemptFailed,
  markSent,
  markSkippedNoConsent,
  readSetting,
  withTx,
  type Db,
  type ClaimedMessage,
} from '@hmis/db';
import type { Logger } from '@hmis/shared/logger';
import {
  isMessageKind,
  normalizeMobile,
  templateParams,
  type MessagingProviderKey,
} from '@hmis/shared';
import { z } from 'zod';
import { absolutePath } from '../files';
import { createProvider, MessagingError, type MessagingProvider } from '../messaging';
import { defineJob } from './types';

export const OUTBOX_WHATSAPP_QUEUE = 'outbox.whatsapp';
/** Every minute: the counter only queues rows, this drains them whenever the internet allows. */
export const OUTBOX_WHATSAPP_CRON = '* * * * *';
/** A message waiting for an approved template or a missing provider login is looked at again later. */
const DEFER_MS = 15 * 60 * 1000;

export interface OutboxDeps {
  db: Db;
  filesDir: string;
  logger: Logger;
  providerFor: (key: MessagingProviderKey) => MessagingProvider;
  now?: () => Date;
}

export interface OutboxRun {
  sent: number;
  retried: number;
  failed: number;
  skippedNoConsent: number;
  deferred: number;
}

const errorOf = (e: unknown): { message: string; retryable: boolean } =>
  e instanceof MessagingError
    ? { message: e.message, retryable: e.retryable }
    : // Never put the raw error text (it may echo a number or a body) into the row.
      { message: 'send_error', retryable: true };

/** Sends one claimed message: consent re-check, template approval, then the provider. */
async function sendOne(
  d: OutboxDeps,
  provider: MessagingProvider,
  m: ClaimedMessage,
  now: Date,
  out: OutboxRun,
): Promise<void> {
  const ctx = await loadSendContext(d.db, m);
  if (!ctx.consent) {
    await markSkippedNoConsent(d.db, m);
    out.skippedNoConsent += 1;
    return;
  }
  const to = normalizeMobile(m.toMobile);
  if (!isMessageKind(m.kind) || !to) {
    await markAttemptFailed(
      d.db,
      m,
      { message: to ? 'unknown_template' : 'invalid_mobile', retryable: false },
      now,
    );
    out.failed += 1;
    return;
  }
  if (provider.requiresApprovedTemplates && ctx.templateApproved !== true) {
    await deferMessage(d.db, m, 'template_not_approved', new Date(now.getTime() + DEFER_MS));
    out.deferred += 1;
    return;
  }
  const params = templateParams(m.kind, m.language, {
    ...m.variables,
    hospitalName: ctx.hospitalName,
    hospitalPhone: ctx.hospitalPhone,
  });
  try {
    const sent = await provider.sendTemplate({
      to,
      templateName: ctx.providerTemplateName,
      language: m.language,
      params,
      idempotencyKey: m.id,
    });
    await markSent(d.db, m, sent.providerMessageId, now);
    out.sent += 1;
    d.logger.info({ messageId: m.id, kind: m.kind }, 'message sent');
  } catch (e) {
    const err = errorOf(e);
    const result = await markAttemptFailed(d.db, m, err, now);
    out[result === 'failed' ? 'failed' : 'retried'] += 1;
    d.logger.warn(
      { messageId: m.id, attempts: m.attempts, error: err.message, result },
      'message not sent',
    );
    return;
  }
  if (m.documentId && ctx.documentPath) {
    try {
      const bytes = await readFile(absolutePath(d.filesDir, ctx.documentPath));
      await provider.sendDocument({
        to,
        bytes,
        filename: ctx.documentPath.split('/').pop() ?? 'document.pdf',
        mime: ctx.documentMime ?? 'application/pdf',
        idempotencyKey: m.id,
      });
    } catch (e) {
      // The text message is out; the attachment is not retried (it would repeat the text).
      d.logger.warn({ messageId: m.id, error: errorOf(e).message }, 'message attachment not sent');
    }
  }
}

/** One drain of the outbox for every facility. Safe to run concurrently (rows are claimed). */
export async function processOutbox(d: OutboxDeps): Promise<OutboxRun> {
  const out: OutboxRun = { sent: 0, retried: 0, failed: 0, skippedNoConsent: 0, deferred: 0 };
  for (const facilityId of await activeFacilityIds(d.db)) {
    const now = (d.now ?? (() => new Date()))();
    await withTx({ db: d.db, userId: null, facilityId }, (tx) =>
      ensureMessageTemplates(tx, facilityId),
    );
    const claim = await claimDueMessages(d.db, facilityId, now);
    if (claim.messages.length === 0) continue;
    const key = await readSetting(d.db, facilityId, 'whatsapp.provider');
    let provider: MessagingProvider;
    try {
      provider = d.providerFor(key);
    } catch (e) {
      // No login for the provider on this server: put everything back, try again later.
      for (const m of claim.messages) {
        await deferMessage(d.db, m, errorOf(e).message, new Date(now.getTime() + DEFER_MS));
        out.deferred += 1;
      }
      continue;
    }
    for (const m of claim.messages) await sendOne(d, provider, m, now, out);
    const { cap, sent } = claim.usage;
    if (cap > 0 && sent < cap * 0.8 && sent + out.sent >= cap * 0.8) {
      d.logger.warn({ facilityId, cap }, 'WhatsApp monthly cap: 80% used');
    }
  }
  return out;
}

export const outboxWhatsappJob = defineJob({
  name: OUTBOX_WHATSAPP_QUEUE,
  schema: z.object({}).strict(),
  async handle(_data, { db, filesDir, logger }) {
    const cache = new Map<MessagingProviderKey, MessagingProvider>();
    const run = await processOutbox({
      db,
      filesDir,
      logger,
      providerFor: (key) => {
        // The fake provider keeps its record in memory: one per process.
        const known = cache.get(key) ?? createProvider(key);
        cache.set(key, known);
        return known;
      },
    });
    return run;
  },
});
