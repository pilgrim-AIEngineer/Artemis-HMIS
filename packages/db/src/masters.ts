/**
 * Master-data domain helpers shared by the tRPC procedures and the seed (FND-07): rate writes
 * and rate/tariff resolution (docs/12 §1). Money is integer paise.
 */
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { currentAppUserId } from '../schema/columns';
import { payer, service, serviceRate, tariff } from '../schema';
import type { Db } from './client';
import type { Tx } from './tx';

type Queryable = Db | Tx;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface SetRateInput {
  facilityId: string;
  serviceId: string;
  tariffId: string;
  roomCategoryId?: string | null;
  ratePaise: bigint;
  /** `YYYY-MM-DD`, the first day the rate applies. */
  effectiveFrom: string;
}

export type SetRateResult =
  { changed: false; id: string } | { changed: true; id: string; replacedId: string | null };

export class MasterRefError extends Error {
  constructor(readonly code: 'service' | 'tariff') {
    super(`${code} not found or cancelled`);
    this.name = 'MasterRefError';
  }
}

/**
 * Sets the price of a service in a tariff from a date. A price change is a new row (old bills keep
 * their snapshot, docs/12 §1). Re-entering the same date replaces that day's row: the old row is
 * cancelled with a reason, never overwritten or deleted (AGENTS.md rule 4). Identical re-entry is
 * a no-op. Throws `MasterRefError` when the service or tariff is missing or cancelled.
 */
export async function setServiceRate(tx: Tx, input: SetRateInput): Promise<SetRateResult> {
  const room = input.roomCategoryId ?? null;
  const [svc] = await tx
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        eq(service.id, input.serviceId),
        eq(service.facilityId, input.facilityId),
        eq(service.status, 'active'),
      ),
    );
  if (!svc) throw new MasterRefError('service');
  const [tar] = await tx
    .select({ id: tariff.id })
    .from(tariff)
    .where(
      and(
        eq(tariff.id, input.tariffId),
        eq(tariff.facilityId, input.facilityId),
        eq(tariff.status, 'active'),
      ),
    );
  if (!tar) throw new MasterRefError('tariff');

  const sameKey = and(
    eq(serviceRate.facilityId, input.facilityId),
    eq(serviceRate.serviceId, input.serviceId),
    eq(serviceRate.tariffId, input.tariffId),
    sql`coalesce(${serviceRate.roomCategoryId}, ${ZERO_UUID}::uuid) = coalesce(${room}::uuid, ${ZERO_UUID}::uuid)`,
    eq(serviceRate.effectiveFrom, input.effectiveFrom),
    eq(serviceRate.status, 'active'),
  );
  const [existing] = await tx
    .select({ id: serviceRate.id, ratePaise: serviceRate.ratePaise })
    .from(serviceRate)
    .where(sameKey)
    .for('update');
  if (existing?.ratePaise === input.ratePaise) return { changed: false, id: existing.id };
  if (existing) {
    await tx
      .update(serviceRate)
      .set({
        status: 'cancelled',
        cancelReason: 'Replaced by a corrected rate for the same date',
        cancelledAt: sql`now()`,
        cancelledBy: currentAppUserId,
      })
      .where(eq(serviceRate.id, existing.id));
  }
  const id = uuidv7();
  await tx.insert(serviceRate).values({
    id,
    facilityId: input.facilityId,
    serviceId: input.serviceId,
    tariffId: input.tariffId,
    roomCategoryId: room,
    ratePaise: input.ratePaise,
    effectiveFrom: input.effectiveFrom,
  });
  return { changed: true, id, replacedId: existing?.id ?? null };
}

export interface RateQuery {
  facilityId: string;
  serviceId: string;
  tariffId: string;
  roomCategoryId?: string | null;
  /** Business date `YYYY-MM-DD` (IST). */
  on: string;
}

export interface ResolvedRate {
  id: string;
  ratePaise: bigint;
  effectiveFrom: string;
  roomCategoryId: string | null;
}

/**
 * The rate in force on a date: the latest active row not after `on`. For a room-specific
 * question a room-specific rate wins; without one the room-agnostic rate applies. `null` = no
 * rate, so the line cannot be added (docs/12 §1, needs `billing.rate.override`).
 */
export async function getRate(q: Queryable, r: RateQuery): Promise<ResolvedRate | null> {
  const base = and(
    eq(serviceRate.facilityId, r.facilityId),
    eq(serviceRate.serviceId, r.serviceId),
    eq(serviceRate.tariffId, r.tariffId),
    eq(serviceRate.status, 'active'),
    lte(serviceRate.effectiveFrom, r.on),
  );
  const pick = (room: ReturnType<typeof isNull>) =>
    q
      .select({
        id: serviceRate.id,
        ratePaise: serviceRate.ratePaise,
        effectiveFrom: serviceRate.effectiveFrom,
        roomCategoryId: serviceRate.roomCategoryId,
      })
      .from(serviceRate)
      .where(and(base, room))
      .orderBy(desc(serviceRate.effectiveFrom), desc(serviceRate.id))
      .limit(1);
  if (r.roomCategoryId) {
    const [specific] = await pick(eq(serviceRate.roomCategoryId, r.roomCategoryId));
    if (specific) return specific;
  }
  return (await pick(isNull(serviceRate.roomCategoryId)))[0] ?? null;
}

/**
 * Tariff for an encounter (docs/12 §1): the payer's own active tariff valid on `on`, else the
 * default tariff (`payer_id IS NULL`). Null when neither exists.
 */
export async function pickTariff(
  q: Queryable,
  r: { facilityId: string; payerId: string | null; on: string },
): Promise<string | null> {
  const valid = and(
    eq(tariff.facilityId, r.facilityId),
    eq(tariff.status, 'active'),
    eq(tariff.isActive, true),
    lte(tariff.effectiveFrom, r.on),
    or(isNull(tariff.effectiveTo), sql`${tariff.effectiveTo} >= ${r.on}`),
  );
  if (r.payerId) {
    const [own] = await q
      .select({ id: tariff.id })
      .from(tariff)
      .innerJoin(payer, eq(payer.id, tariff.payerId))
      .where(
        and(
          valid,
          eq(tariff.payerId, r.payerId),
          eq(payer.status, 'active'),
          eq(payer.isActive, true),
        ),
      )
      .orderBy(desc(tariff.effectiveFrom), desc(tariff.id))
      .limit(1);
    if (own) return own.id;
  }
  const [dflt] = await q
    .select({ id: tariff.id })
    .from(tariff)
    .where(and(valid, isNull(tariff.payerId)))
    .orderBy(desc(tariff.effectiveFrom), desc(tariff.id))
    .limit(1);
  return dflt?.id ?? null;
}
