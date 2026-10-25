// Serves the production standalone build exactly as the Docker image does (infra/docker/web.Dockerfile):
// static assets copied next to server.js, then `node apps/web/server.js`.
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const server = `${web}.next/standalone/apps/web/server.js`;
if (!existsSync(server)) {
  console.error('No standalone build found. Run `pnpm build` (or `pnpm e2e`, which builds first).');
  process.exit(1);
}
cpSync(`${web}.next/static`, `${web}.next/standalone/apps/web/.next/static`, { recursive: true });
await import(server);
