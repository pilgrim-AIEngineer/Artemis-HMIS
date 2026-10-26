import 'server-only';
import { resolveAppDatabaseUrl } from '@hmis/db';
import { EventHub } from './hub';

const globalForHub = globalThis as unknown as { hmisEventHub?: EventHub };

/** Process-wide hub, created on first use and reused across dev hot reloads. */
export function getEventHub(): EventHub {
  globalForHub.hmisEventHub ??= new EventHub({
    connectionString: resolveAppDatabaseUrl(),
    log: (msg) => console.error(`[events] ${msg}`),
  });
  return globalForHub.hmisEventHub;
}
