/**
 * WhatsApp messages (MSG-01, docs/21): the template registry (English and Hindi bodies, the order
 * of the variables the provider expects), mobile normalisation, the 48 h retry schedule and the
 * quiet hours. Pure functions; the outbox tables and the sender live in `@hmis/db` and the worker.
 * Nothing here describes a fetus (AGENTS.md rule 7): the ANC reminder carries a date only.
 */
import { formatINR } from './money';

export const MESSAGE_KINDS = ['receipt', 'follow_up', 'anc_reminder', 'vaccine_reminder'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const MESSAGE_LANGUAGES = ['en', 'hi'] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];
export const MESSAGING_PROVIDERS = ['fake', 'meta'] as const;
export type MessagingProviderKey = (typeof MESSAGING_PROVIDERS)[number];

/** Retry for 48 h from the first time the message was due, then `failed` (docs/21 §4). */
export const RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;
/** A row claimed longer ago than this was abandoned by a crashed worker and goes back to `queued`. */
export const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

/** Delay before attempt `attempts + 1`: 1, 2, 4 … minutes, capped at 2 h. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export interface RetryDecision {
  action: 'retry' | 'fail';
  at: Date | null;
}

/**
 * What to do after a failed attempt (`attempts` already counts it). Permanent errors fail at once;
 * temporary ones retry with backoff until 48 h after `firstDueAt`.
 */
export function nextRetry(input: {
  attempts: number;
  firstDueAt: Date;
  now: Date;
  retryable: boolean;
}): RetryDecision {
  if (!input.retryable) return { action: 'fail', at: null };
  const at = new Date(input.now.getTime() + backoffMs(input.attempts));
  if (at.getTime() > input.firstDueAt.getTime() + RETRY_WINDOW_MS)
    return { action: 'fail', at: null };
  return { action: 'retry', at };
}

/** Indian mobile → `91XXXXXXXXXX` (what WhatsApp expects); null when it is not one. */
export function normalizeMobile(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 10 && /^[6-9]/.test(d)) return `91${d}`;
  return null;
}

// ---------------------------------------------------------------- quiet hours

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** No reminders 9 pm – 8 am (docs/21 §4). */
export const QUIET_FROM_HOUR = 21;
export const QUIET_UNTIL_HOUR = 8;
/** Reminders are scheduled for 10 am (docs/21 §3). */
export const REMINDER_HOUR_IST = 10;

const istHour = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();

export const inQuietHours = (d: Date): boolean =>
  istHour(d) >= QUIET_FROM_HOUR || istHour(d) < QUIET_UNTIL_HOUR;

/** The first moment at or after `d` outside quiet hours. */
export function afterQuietHours(d: Date): Date {
  if (!inQuietHours(d)) return d;
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  const nextDay = istHour(d) >= QUIET_FROM_HOUR ? day + 24 * 3_600_000 : day;
  return new Date(nextDay + QUIET_UNTIL_HOUR * 3_600_000 - IST_OFFSET_MS);
}

/** 10:00 IST on the IST calendar date `date` (`YYYY-MM-DD`). */
export const reminderInstant = (date: string): Date =>
  new Date(`${date}T${String(REMINDER_HOUR_IST).padStart(2, '0')}:00:00+05:30`);

// ---------------------------------------------------------------- templates

export interface MessageTemplateDef {
  kind: MessageKind;
  /** Reminders respect quiet hours; a receipt goes out as soon as it can. */
  reminder: boolean;
  /** Variable names in the order the provider template numbers them ({{1}}, {{2}} …). */
  variables: readonly string[];
  body: Record<MessageLanguage, string>;
}

export const MESSAGE_TEMPLATES: Record<MessageKind, MessageTemplateDef> = {
  receipt: {
    kind: 'receipt',
    reminder: false,
    variables: ['hospitalName', 'amount', 'receiptNo', 'date'],
    body: {
      en: '{{1}}: payment of {{2}} received. Receipt no. {{3}}, date {{4}}. Thank you.',
      hi: '{{1}}: {{2}} का भुगतान प्राप्त हुआ। रसीद संख्या {{3}}, दिनांक {{4}}। धन्यवाद।',
    },
  },
  follow_up: {
    kind: 'follow_up',
    reminder: true,
    variables: ['patientName', 'doctorName', 'date', 'hospitalName', 'hospitalPhone'],
    body: {
      en: 'Reminder: {{1}}, your follow-up visit with {{2}} is on {{3}} at {{4}}. For help call {{5}}.',
      hi: 'याद दिलाना: {{1}}, {{2}} के साथ आपका अगला परामर्श {{3}} को {{4}} में है। सहायता के लिए {{5}} पर कॉल करें।',
    },
  },
  anc_reminder: {
    kind: 'anc_reminder',
    reminder: true,
    variables: ['patientName', 'date', 'hospitalName', 'hospitalPhone'],
    body: {
      en: 'Reminder: {{1}}, your next check-up is due on {{2}} at {{3}}. For help call {{4}}.',
      hi: 'याद दिलाना: {{1}}, आपकी अगली जाँच {{2}} को {{3}} में होनी है। सहायता के लिए {{4}} पर कॉल करें।',
    },
  },
  vaccine_reminder: {
    kind: 'vaccine_reminder',
    reminder: true,
    variables: ['childName', 'vaccines', 'dueDateText', 'hospitalName', 'hospitalPhone'],
    body: {
      en: 'Reminder: {{1}} is due for {{2}} on {{3}} at {{4}}. For help call {{5}}.',
      hi: 'याद दिलाना: {{1}} का {{2}} टीका {{3}} को {{4}} में लगना है। सहायता के लिए {{5}} पर कॉल करें।',
    },
  },
};

export const isMessageKind = (k: string): k is MessageKind =>
  (MESSAGE_KINDS as readonly string[]).includes(k);

/** The name registered with the provider, e.g. `hmis_receipt_hi`. */
export const providerTemplateName = (kind: MessageKind, language: MessageLanguage): string =>
  `hmis_${kind}_${language}`;

type Vars = Record<string, unknown>;

/** Variables as the provider takes them: positional strings, empty values shown as a dash. */
export function templateParams(
  kind: MessageKind,
  language: MessageLanguage,
  variables: Vars,
): string[] {
  const v = { ...variables };
  const list = language === 'hi' ? (v.vaccinesHi ?? v.vaccines) : v.vaccines;
  if (Array.isArray(list)) v.vaccines = list.join(', ');
  return MESSAGE_TEMPLATES[kind].variables.map((name) => {
    const x = v[name];
    return typeof x === 'string' && x.trim() !== '' ? x.trim() : '-';
  });
}

/** The approved text with the values put in (preview, logs and the fake provider). */
export function renderTemplate(
  kind: MessageKind,
  language: MessageLanguage,
  params: string[],
): string {
  return MESSAGE_TEMPLATES[kind].body[language].replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => params[Number(n) - 1] ?? '-',
  );
}

/** Variables of a receipt message (money formatted at the edge, AGENTS.md rule 1). */
export function receiptVariables(input: {
  amountPaise: bigint;
  receiptNo: string;
  date: string;
}): Vars {
  return { amount: formatINR(input.amountPaise), receiptNo: input.receiptNo, date: input.date };
}
