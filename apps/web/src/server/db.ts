import 'server-only';
import { createDb, resolveDatabaseUrl, type Db } from '@hmis/db';

const globalForDb = globalThis as unknown as { hmisDb?: Db };

/**
 * Lazily created pool, reused across dev hot reloads. Throws if the DB is not configured;
 * callers that must not fail (health) catch it.
 */
export function getDb(): Db {
  globalForDb.hmisDb ??= createDb({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'hmis-web',
  });
  return globalForDb.hmisDb;
}
