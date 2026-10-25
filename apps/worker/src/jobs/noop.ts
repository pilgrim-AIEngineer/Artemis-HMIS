import { z } from 'zod';
import { defineJob } from './types';

/** Proves the queue end to end (FND-01). Real jobs: docs/01 §2 (outbox, pdf, reminders, ops). */
export const noopJob = defineJob({
  name: 'system.noop',
  schema: z.object({ note: z.string().max(200).optional() }).strict(),
  handle(_data, { logger, jobId }) {
    logger.info({ jobId }, 'noop job done');
    return Promise.resolve({ ok: true });
  },
});
