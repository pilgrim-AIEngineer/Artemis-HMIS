import type { MessagingProviderKey } from '@hmis/shared';
import { FakeProvider } from './fake';
import { MetaCloudProvider, metaConfigFromEnv } from './meta';
import { MessagingError, type MessagingProvider } from './provider';

export * from './fake';
export * from './meta';
export * from './provider';

/** Builds the adapter named by `whatsapp.provider`; Meta needs its credentials in the environment. */
export function createProvider(
  key: MessagingProviderKey,
  env: NodeJS.ProcessEnv = process.env,
): MessagingProvider {
  if (key === 'fake') return new FakeProvider();
  const cfg = metaConfigFromEnv(env);
  // Permanent for this run only: the row is deferred, not failed (see the outbox job).
  if (!cfg) throw new MessagingError('meta:not_configured', true);
  return new MetaCloudProvider(cfg);
}
