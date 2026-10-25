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
}

export function createPool(opts: CreateDbOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    application_name: opts.applicationName ?? 'hmis',
    max: opts.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(opts: CreateDbOptions): Db {
  return drizzle({ client: createPool(opts), schema, casing: 'snake_case' });
}
