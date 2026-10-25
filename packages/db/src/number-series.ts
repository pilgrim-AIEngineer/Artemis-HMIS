import {
  formatSeriesNumber,
  istDateString,
  NUMBER_SERIES,
  NUMBER_SERIES_CONFIG_SETTING,
  SERIES_KEYS,
  numberSeriesConfigSchema,
  resolveSeriesDefinition,
  seriesKeySchema,
  seriesPeriod,
  type SeriesKey,
} from '@hmis/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { numberSeries, setting } from '../schema';
import type { Tx } from './tx';

export interface AllocatedNumber {
  key: SeriesKey;
  /** Stored `number_series.fy`: `2026-27`, `2026` or `all`. */
  period: string;
  value: number;
  /** `OP/26-27/004512` */
  formatted: string;
}

const facilityIdSchema = z.uuid();

async function bump(tx: Tx, facilityId: string, key: SeriesKey, period: string) {
  const [row] = await tx
    .update(numberSeries)
    .set({ nextValue: sql`${numberSeries.nextValue} + 1` })
    .where(
      and(
        eq(numberSeries.facilityId, facilityId),
        eq(numberSeries.key, key),
        eq(numberSeries.fy, period),
      ),
    )
    .returning({
      nextValue: numberSeries.nextValue,
      prefix: numberSeries.prefix,
      padding: numberSeries.padding,
    });
  return row;
}

/**
 * Allocates the next number of a series inside the caller's business transaction (docs/02 §4):
 * `UPDATE ... SET next_value = next_value + 1 RETURNING`. The row lock serialises concurrent
 * callers until commit, so numbers are gap-free; a gap appears only if the caller rolls back.
 *
 * `at` is the business instant (original time for downtime back-entry); the period is taken on
 * the IST calendar, so FY series roll over at 1 April 00:00 IST.
 */
export async function allocateNumber(
  tx: Tx,
  facilityId: string,
  key: SeriesKey,
  at: Date,
): Promise<AllocatedNumber> {
  facilityIdSchema.parse(facilityId);
  seriesKeySchema.parse(key);

  const [cfgRow] = await tx
    .select({ value: setting.value })
    .from(setting)
    .where(and(eq(setting.facilityId, facilityId), eq(setting.key, NUMBER_SERIES_CONFIG_SETTING)));
  const config = numberSeriesConfigSchema.parse(cfgRow?.value);
  const def = resolveSeriesDefinition(key, config);
  const { period, label } = seriesPeriod(def.reset, at);

  let row = await bump(tx, facilityId, key, period);
  if (!row) {
    // First number of this period. Prefix/padding: setting override, else carried over from the
    // latest earlier period (admin may have edited it), else the catalogue default.
    const [previous] = await tx
      .select({ prefix: numberSeries.prefix, padding: numberSeries.padding })
      .from(numberSeries)
      .where(
        and(
          eq(numberSeries.facilityId, facilityId),
          eq(numberSeries.key, key),
          ne(numberSeries.fy, period),
        ),
      )
      .orderBy(desc(numberSeries.createdAt))
      .limit(1);
    await tx
      .insert(numberSeries)
      .values({
        id: uuidv7(),
        facilityId,
        key,
        fy: period,
        prefix: config[key]?.prefix ?? previous?.prefix ?? NUMBER_SERIES[key].prefix,
        padding: config[key]?.padding ?? previous?.padding ?? NUMBER_SERIES[key].padding,
        nextValue: 1,
      })
      .onConflictDoNothing({
        target: [numberSeries.facilityId, numberSeries.key, numberSeries.fy],
      });
    row = await bump(tx, facilityId, key, period);
    if (!row) throw new Error(`number_series row missing for ${key}/${period}`);
  }

  const value = row.nextValue - 1;
  return {
    key,
    period,
    value,
    formatted: formatSeriesNumber(row.prefix, label, value, row.padding),
  };
}

export interface DailyTokenRequest {
  facilityId: string;
  doctorId: string;
  /** Business instant; the token day is its IST calendar date. */
  at: Date;
  /**
   * Highest token already issued for this doctor and day (`max(token_no)` on `opd_token`, REG-04),
   * or null for none. Runs after the advisory lock is held.
   */
  currentMax: (tx: Tx, tokenDate: string) => Promise<number | null>;
}

export interface DailyToken {
  tokenDate: string;
  tokenNo: number;
}

/**
 * Daily OPD token per doctor (docs/02 §4: not a series row). Takes a transaction-scoped advisory
 * lock on (facility, doctor, IST date), then reads the current max: concurrent callers queue on
 * the lock and each sees the previous holder's committed token. READ COMMITTED only, because a
 * repeatable-read snapshot taken before the lock would hide that commit.
 */
export async function allocateDailyToken(tx: Tx, req: DailyTokenRequest): Promise<DailyToken> {
  facilityIdSchema.parse(req.facilityId);
  z.uuid().parse(req.doctorId);
  const tokenDate = istDateString(req.at);

  const iso = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (iso.rows[0]?.level !== 'read committed') {
    throw new Error('allocateDailyToken requires READ COMMITTED isolation');
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`opd_token:${req.facilityId}:${req.doctorId}:${tokenDate}`}, 0))`,
  );
  const max = await req.currentMax(tx, tokenDate);
  return { tokenDate, tokenNo: (max ?? 0) + 1 };
}

/**
 * Creates the `number_series` row of every series for the period containing `at` (docs/33 §1
 * "number series for the current FY"), with the configured or catalogue prefix and padding.
 * Existing rows are left alone. Returns how many were created. `allocateNumber` still creates
 * rows lazily, so calling this is an optimisation for a visible, complete series list.
 */
export async function ensureNumberSeriesRows(
  tx: Tx,
  facilityId: string,
  at: Date,
): Promise<number> {
  facilityIdSchema.parse(facilityId);
  const [cfgRow] = await tx
    .select({ value: setting.value })
    .from(setting)
    .where(and(eq(setting.facilityId, facilityId), eq(setting.key, NUMBER_SERIES_CONFIG_SETTING)));
  const config = numberSeriesConfigSchema.parse(cfgRow?.value);
  let created = 0;
  for (const key of SERIES_KEYS) {
    const def = resolveSeriesDefinition(key, config);
    const { period } = seriesPeriod(def.reset, at);
    const rows = await tx
      .insert(numberSeries)
      .values({
        id: uuidv7(),
        facilityId,
        key,
        fy: period,
        prefix: def.prefix,
        padding: def.padding,
        nextValue: 1,
      })
      .onConflictDoNothing({
        target: [numberSeries.facilityId, numberSeries.key, numberSeries.fy],
      })
      .returning({ id: numberSeries.id });
    created += rows.length;
  }
  return created;
}
