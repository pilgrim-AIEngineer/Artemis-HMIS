import {
  parseSettingValue,
  resolveSetting,
  type SettingKey,
  type SettingValue,
} from '@hmis/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { setting } from '../schema';
import type { Db } from './client';
import type { Tx } from './tx';

type Queryable = Db | Tx;

/**
 * Reads settings for a facility, falling back to the registry default when a key is unset or its
 * stored value no longer validates (`resolveSetting`, docs/01 §7).
 */
export async function readSettings<const K extends SettingKey>(
  q: Queryable,
  facilityId: string,
  keys: readonly K[],
): Promise<{ [P in K]: SettingValue<P> }> {
  const rows = await q
    .select({ key: setting.key, value: setting.value })
    .from(setting)
    .where(and(eq(setting.facilityId, facilityId), inArray(setting.key, [...keys])));
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(keys.map((k) => [k, resolveSetting(k, stored.get(k))])) as {
    [P in K]: SettingValue<P>;
  };
}

export async function readSetting<K extends SettingKey>(
  q: Queryable,
  facilityId: string,
  key: K,
): Promise<SettingValue<K>> {
  const all = await readSettings(q, facilityId, [key]);
  return all[key];
}

/**
 * Validates and stores a setting (insert or update). Returns the stored (parsed) value. The audit
 * trigger records who changed what; settings are never deleted, "reset" stores the default.
 */
export async function writeSetting<K extends SettingKey>(
  tx: Tx,
  facilityId: string,
  key: K,
  raw: unknown,
): Promise<SettingValue<K>> {
  const value = parseSettingValue(key, raw);
  // A JSON null (e.g. "no accent colour") must be the jsonb value 'null', not SQL NULL.
  const stored = value === null ? sql`'null'::jsonb` : value;
  await tx
    .insert(setting)
    .values({ facilityId, key, value: stored })
    .onConflictDoUpdate({ target: [setting.facilityId, setting.key], set: { value: stored } });
  return value;
}
