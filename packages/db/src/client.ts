import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema> & { $client: pg.Pool };

export interface CreateDbOptions {
  connectionString: string;
  /** Shown in pg_stat_activity, e.g. `hmis-web`. */
  applicationName?: string;
  max?: number;
  /** How long a query waits for a free connection (default 5 s). */
  connectionTimeoutMs?: number;
}

export function createPool(opts: CreateDbOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    application_name: opts.applicationName ?? 'hmis',
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
  });
  // Idle clients emit 'error' when Postgres restarts/fails over/terminates a backend. Without a
  // listener Node throws and the process dies. The pool discards the broken client and opens a
  // new one on demand. Log only code/message (never query text or params: patient data).
  pool.on('error', (err: Error & { code?: string }) => {
    console.error(`[db] idle pool client error${err.code ? ` (${err.code})` : ''}: ${err.message}`);
  });
  return pool;
}

export function createDb(opts: CreateDbOptions): Db {
  return drizzle({ client: createPool(opts), schema, casing: 'snake_case' });
}
