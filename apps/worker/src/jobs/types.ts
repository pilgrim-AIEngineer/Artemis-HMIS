import type { Logger } from '@hmis/shared/logger';
import type { z } from 'zod';

export interface JobContext {
  logger: Logger;
}

/**
 * A pg-boss job. `data` is validated with zod before the handler runs; payloads carry IDs only,
 * never patient data (AGENTS.md rule 15).
 */
export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  schema: S;
  /** Concurrency/polling knobs; defaults suit low-volume hospital jobs. */
  pollingIntervalSeconds?: number;
  handle(data: z.infer<S>, ctx: JobContext & { jobId: string }): Promise<unknown>;
}

export const defineJob = <S extends z.ZodType>(job: JobDefinition<S>) => job;
