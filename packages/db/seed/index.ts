/**
 * `pnpm db:seed [--demo]`. Master data arrives with FND-07 (docs/33-seed-masters.md);
 * `--demo` adds synthetic patients/OPD (docs/02 §9). Never real patient data.
 */
import { createDb, resolveDatabaseUrl } from '../src';
import { loadRootEnv } from '../src/load-root-env';

const demo = process.argv.includes('--demo');

loadRootEnv();
const db = createDb({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'hmis-seed',
  max: 1,
});
try {
  // Fail fast if the DB is unreachable, so the script is already useful in CI/dev.
  await db.$client.query('select 1');
  console.log(`db:seed: nothing to seed yet (masters land in FND-07)${demo ? ' [--demo]' : ''}`);
} finally {
  await db.$client.end();
}
