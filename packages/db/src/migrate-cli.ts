import { createDb } from './client';
import { resolveDatabaseUrl } from './env';
import { loadRootEnv } from './load-root-env';
import { runMigrations } from './migrate';

loadRootEnv();
const db = createDb({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'hmis-migrate',
  max: 1,
});
try {
  await runMigrations(db);
  console.log('db:migrate: up to date');
} finally {
  await db.$client.end();
}
