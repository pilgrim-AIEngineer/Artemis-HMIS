import { z } from 'zod';

/**
 * Waiting-hall TV display (REG-05, docs/10 §6) and the identifiers printed on the OPD sheet and
 * stickers (REG-06, REG-07). Nothing here describes a patient beyond what the hospital chose to
 * show: tokens by default, optionally first name + last initial.
 */

/** The display key travels in this header on every poll, so it is not repeated in API URLs. */
export const DISPLAY_KEY_HEADER = 'x-display-key';

/** 32 random bytes as base64url. */
export const displayKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** SHA-256 hex of a display key: all the `setting` table (and so `audit_log`) ever holds of it. */
export const displayKeyHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** "Next: 24, 25, 26, 27, 28" (docs/10 §6). */
export const DISPLAY_NEXT_COUNT = 5;

export interface DisplayToken {
  no: number;
  /** First name + last initial; present only when `queue.showNameOnDisplay` is on. */
  name?: string;
  /** Times the doctor room pressed "Recall"; a rise re-announces the token. */
  recall: number;
}

export interface DisplayDoctor {
  id: string;
  name: string;
  nameHi: string | null;
  now: DisplayToken[];
  next: DisplayToken[];
  /** Everyone still waiting, including those beyond `next`. */
  waiting: number;
}

/** The whole payload of `/api/display/queue`: the only data the unauthenticated TV can read. */
export interface DisplayFeed {
  date: string;
  voice: boolean;
  doctors: DisplayDoctor[];
}

/** `Radha Kumari` → `Radha K.`; a single name stays as it is. */
export function displayName(firstName: string, lastName: string | null | undefined): string {
  const first = firstName.trim().split(/\s+/)[0] ?? '';
  const initial = [...(lastName?.trim() ?? '')][0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

export interface Announcement {
  doctorId: string;
  tokenNo: number;
}

/**
 * Tokens the TV should announce after a refresh: a token that is now with the doctor and was not
 * before, or whose recall count went up. The first refresh after loading announces nothing (the
 * page may have been reloaded in the middle of the day).
 */
export function newAnnouncements(
  prev: DisplayFeed | null,
  next: DisplayFeed,
): readonly Announcement[] {
  if (!prev) return [];
  const before = new Map<string, number>();
  for (const d of prev.doctors) for (const t of d.now) before.set(`${d.id}:${t.no}`, t.recall);
  const out: Announcement[] = [];
  for (const d of next.doctors) {
    for (const t of d.now) {
      const seen = before.get(`${d.id}:${t.no}`);
      if (seen === undefined || t.recall > seen) out.push({ doctorId: d.id, tokenNo: t.no });
    }
  }
  return out;
}

/** What the visit QR encodes: the visit (encounter) id only, never patient data (docs/10 §7). */
export const visitQrPayload = (encounterId: string): string => `E:${encounterId}`;

const VISIT_QR = /^E:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Reads a scanned visit QR back (the scan-to-"seen" flow); null for anything else. */
export function parseVisitQr(text: string): string | null {
  return VISIT_QR.exec(text.trim())?.[1] ?? null;
}

/**
 * Quick-tick orders printed on the OPD sheet when the doctor has none configured in
 * `opd.quickOrders` (the examples of docs/10 §7).
 */
export const DEFAULT_QUICK_ORDERS: readonly string[] = [
  'CBC',
  'Hb',
  'Blood group',
  'Urine R/M',
  'HIV / HBsAg / VDRL',
  'TSH',
  'RBS',
  'GTT',
  'Obstetric USG',
  'NT scan',
  'Anomaly scan',
  'Follicular study',
  'TVS',
];

/**
 * Which billing services each quick-tick label stands for (setting `opd.quickOrderServices`), by
 * service code, so the Orders tab of Rx transcription ticks the same names as the paper sheet
 * (docs/11 §2.4). Defaults point at the seeded masters (docs/33); a label without an entry is
 * matched by service code, short code or name.
 */
export const DEFAULT_QUICK_ORDER_SERVICES: Readonly<Record<string, readonly string[]>> = {
  CBC: ['LAB-CBC'],
  Hb: ['LAB-HB'],
  'Blood group': ['LAB-ABO-RH'],
  'Urine R/M': ['LAB-URINE-RM'],
  'HIV / HBsAg / VDRL': ['LAB-HIV', 'LAB-HBSAG', 'LAB-VDRL'],
  TSH: ['LAB-TSH'],
  RBS: ['LAB-RBS'],
  GTT: ['LAB-OGTT'],
  'Obstetric USG': ['USG-OB-EARLY'],
  'NT scan': ['USG-NT'],
  'Anomaly scan': ['USG-ANOMALY'],
  'Follicular study': ['USG-FOLLICULAR'],
  TVS: ['USG-PELVIS-TVS'],
};

/** At most this many tick boxes fit on the A5 sheet (docs/10 §7: "max ~20"). */
export const MAX_QUICK_ORDERS_ON_SHEET = 20;

export type SheetMoment = 'reception' | 'vitals';

/** True when `opd.sheetPrintAt` says the OPD sheet prints at this moment of the visit. */
export const printsSheetAt = (setting: SheetMoment, moment: SheetMoment): boolean =>
  setting === moment;
