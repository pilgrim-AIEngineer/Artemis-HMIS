import { sql } from 'drizzle-orm';
import type { Db } from './client';

export interface DbHealth {
  ok: boolean;
  latencyMs: number | null;
}

/** Round-trips `SELECT 1` with a timeout. Never throws; errors are reported as `ok: false`. */
export async function checkDbHealth(db: Db, timeoutMs = 2_000): Promise<DbHealth> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('db health timeout')), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}
