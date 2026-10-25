import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseUrl } from './src/env';
import { loadRootEnv } from './src/load-root-env';

loadRootEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  migrations: { schema: 'drizzle' },
  // Only needed for introspection commands; `generate` works offline.
  dbCredentials: { url: process.env.DATABASE_URL ?? safeUrl() },
});

function safeUrl(): string {
  try {
    return resolveDatabaseUrl();
  } catch {
    return 'postgres://unset@127.0.0.1:1/unset';
  }
}
