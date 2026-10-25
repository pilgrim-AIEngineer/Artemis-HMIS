import { ensureAppLoginRole } from './app-role';
import { createDb } from './client';
import { resolveAppLogin, resolveDatabaseUrl } from './env';
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
  const login = resolveAppLogin();
  if (login) {
    await ensureAppLoginRole(db, login.user, login.password);
    console.log(`db:migrate: app login role "${login.user}" ensured`);
  } else {
    console.warn('db:migrate: APP_DB_PASSWORD not set; web will connect as the migration owner');
  }
  console.log('db:migrate: up to date');
} finally {
  await db.$client.end();
}
