#!/usr/bin/env node
// `pnpm dev`: starts the dev Postgres (compose, loopback port PG_PORT), applies migrations,
// then runs web (PORT=WEB_PORT) + worker with hot reload via Turborepo.
// `pnpm dev:down`: stops the dev Postgres (data volume is kept).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = path.join(root, '.env');

if (!existsSync(envFile)) {
  console.error('No .env found. Create one first:  cp .env.example .env');
  process.exit(1);
}
process.loadEnvFile(envFile);

const env = { NEXT_TELEMETRY_DISABLED: '1', TURBO_TELEMETRY_DISABLED: '1', ...process.env };
const project = `${env.COMPOSE_PROJECT_NAME ?? 'hmis'}-dev`;
const compose = [
  'compose',
  '--env-file',
  envFile,
  '-f',
  'infra/docker/docker-compose.yml',
  '-f',
  'infra/docker/docker-compose.dev.yml',
  '-p',
  project,
];

function run(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...env, ...extraEnv } });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

if (process.argv[2] === 'down') {
  run('docker', [...compose, 'down']);
  process.exit(0);
}

const pgPort = env.PG_PORT ?? '55432';
const webPort = env.WEB_PORT ?? '3000';
const databaseUrl =
  env.DATABASE_URL ??
  `postgres://${encodeURIComponent(env.POSTGRES_USER ?? 'hmis')}:${encodeURIComponent(
    env.POSTGRES_PASSWORD ?? '',
  )}@127.0.0.1:${pgPort}/${encodeURIComponent(env.POSTGRES_DB ?? 'hmis')}`;

console.log(`dev: starting Postgres (project ${project}, 127.0.0.1:${pgPort})`);
run('docker', [...compose, 'up', '-d', '--wait', 'postgres']);

console.log('dev: applying migrations');
run('pnpm', ['db:migrate'], { DATABASE_URL: databaseUrl });

// Facility, roles/permissions and (first run only) the admin account; prints its password once.
console.log('dev: seeding roles and the first admin');
run('pnpm', ['db:seed'], { DATABASE_URL: databaseUrl });

console.log(`dev: web on http://localhost:${webPort}  (stop Postgres later with: pnpm dev:down)`);
// Own process group, so stopping `pnpm dev` (Ctrl+C or SIGTERM) also stops web and worker.
const child = spawn(
  path.join(root, 'node_modules/.bin/turbo'),
  ['run', 'dev', '--filter=@hmis/web', '--filter=@hmis/worker'],
  {
    cwd: root,
    stdio: 'inherit',
    detached: true,
    env: { ...env, DATABASE_URL: databaseUrl, PORT: webPort },
  },
);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // group already gone
    }
  });
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
