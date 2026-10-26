/**
 * Waiting-hall TV display (REG-05, docs/10 §6, docs/01 §2). The TV has no login; it is
 * authenticated by a long random key. Only the key's SHA-256 is stored (`queue.displayKey`), so
 * a settings read or an `audit_log` row never reveals it, and the lookup by hash leaks nothing
 * through timing. The feed is built here, from token numbers, doctor names and (only when
 * `queue.showNameOnDisplay` is on) first name + last initial: nothing else about a patient is
 * ever selected.
 */
import {
  compareQueue,
  displayKeySchema,
  displayName,
  DISPLAY_NEXT_COUNT,
  istDateString,
  PENDING_STATES,
  type DisplayDoctor,
  type DisplayFeed,
  type DisplayToken,
  type PriorityClass,
  type QueuePriority,
} from '@hmis/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { doctorProfile, encounter, opdToken, patient, setting } from '../schema';
import type { Db } from './client';
import { readSettings, writeSetting } from './settings';
import type { Tx } from './tx';

type Queryable = Db | Tx;

export const hashDisplayKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

/** A fresh key: 256 random bits as base64url (43 characters). */
export const newDisplayKey = (): string => randomBytes(32).toString('base64url');

/**
 * Creates (first use) or replaces the facility's display key and returns it. This is the only
 * moment the key exists in plain text; the previous TV link stops working at once.
 */
export async function rotateDisplayKey(tx: Tx, facilityId: string): Promise<string> {
  const key = newDisplayKey();
  await writeSetting(tx, facilityId, 'queue.displayKey', hashDisplayKey(key));
  return key;
}

export async function hasDisplayKey(q: Queryable, facilityId: string): Promise<boolean> {
  const s = await readSettings(q, facilityId, ['queue.displayKey']);
  return s['queue.displayKey'] !== null;
}

/** The facility a display key belongs to, or null (wrong, malformed or rotated away). */
export async function facilityForDisplayKey(q: Queryable, key: string): Promise<string | null> {
  if (!displayKeySchema.safeParse(key).success) return null;
  const [row] = await q
    .select({ facilityId: setting.facilityId })
    .from(setting)
    .where(
      and(
        eq(setting.key, 'queue.displayKey'),
        sql`${setting.value} = to_jsonb(${hashDisplayKey(key)}::text)`,
      ),
    )
    .limit(1);
  return row?.facilityId ?? null;
}

/**
 * Today's feed for the TV: per doctor with a token today, who is with the doctor ("Now") and the
 * next few waiting, in queue order.
 */
export async function displayFeed(
  q: Queryable,
  facilityId: string,
  now: Date,
): Promise<DisplayFeed> {
  const date = istDateString(now);
  const s = await readSettings(q, facilityId, [
    'queue.showNameOnDisplay',
    'queue.priorityOrder',
    'queue.displayVoice',
  ]);
  const showNames = s['queue.showNameOnDisplay'];
  const order = s['queue.priorityOrder'] as PriorityClass[];

  const tokens = await q
    .select({
      doctorId: opdToken.doctorId,
      encounterId: opdToken.encounterId,
      tokenNo: opdToken.tokenNo,
      priority: opdToken.priority,
      queueOrder: opdToken.queueOrder,
      queueState: opdToken.queueState,
      recallCount: opdToken.recallCount,
      calledAt: opdToken.calledAt,
    })
    .from(opdToken)
    .where(
      and(
        eq(opdToken.facilityId, facilityId),
        eq(opdToken.tokenDate, date),
        inArray(opdToken.queueState, [...PENDING_STATES, 'with_doctor']),
      ),
    );
  if (tokens.length === 0) return { date, voice: s['queue.displayVoice'], doctors: [] };

  const names = new Map<string, string>();
  if (showNames) {
    const rows = await q
      .select({
        encounterId: encounter.id,
        firstName: patient.firstName,
        lastName: patient.lastName,
      })
      .from(encounter)
      .innerJoin(patient, eq(patient.id, encounter.patientId))
      .where(
        inArray(
          encounter.id,
          tokens.map((t) => t.encounterId),
        ),
      );
    for (const r of rows) names.set(r.encounterId, displayName(r.firstName, r.lastName));
  }

  const doctors = await q
    .select({
      id: doctorProfile.id,
      name: doctorProfile.displayName,
      nameHi: doctorProfile.displayNameHi,
    })
    .from(doctorProfile)
    .where(
      and(
        eq(doctorProfile.facilityId, facilityId),
        inArray(doctorProfile.id, [...new Set(tokens.map((t) => t.doctorId))]),
      ),
    )
    .orderBy(doctorProfile.displayName, doctorProfile.id);

  const toToken = (t: (typeof tokens)[number]): DisplayToken => ({
    no: t.tokenNo,
    recall: t.recallCount,
    ...(showNames && names.has(t.encounterId) ? { name: names.get(t.encounterId)! } : {}),
  });

  const result: DisplayDoctor[] = doctors.map((d) => {
    const mine = tokens.filter((t) => t.doctorId === d.id);
    const calling = mine
      .filter((t) => t.queueState === 'with_doctor')
      .sort((a, b) => (b.calledAt?.getTime() ?? 0) - (a.calledAt?.getTime() ?? 0));
    const waiting = mine
      .filter((t) => (PENDING_STATES as readonly string[]).includes(t.queueState))
      .sort((a, b) =>
        compareQueue(
          { ...a, priority: a.priority as QueuePriority },
          { ...b, priority: b.priority as QueuePriority },
          order,
        ),
      );
    return {
      id: d.id,
      name: d.name,
      nameHi: d.nameHi,
      now: calling.map(toToken),
      next: waiting.slice(0, DISPLAY_NEXT_COUNT).map(toToken),
      waiting: waiting.length,
    };
  });
  return { date, voice: s['queue.displayVoice'], doctors: result };
}
