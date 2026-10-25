import { PgBoss } from 'pg-boss';
import { JOBS } from './jobs';
import type { JobContext, JobDefinition } from './jobs/types';

export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({
    connectionString,
    application_name: 'hmis-worker',
    // pg-boss owns this schema and its own DDL; app tables stay in Drizzle migrations.
    schema: 'pgboss',
  });
}

/** Creates queues and attaches handlers for every job definition. */
export async function registerJobs(
  boss: PgBoss,
  ctx: JobContext,
  jobs: readonly JobDefinition[] = JOBS,
): Promise<void> {
  for (const job of jobs) {
    await boss.createQueue(job.name);
    await boss.work<unknown>(
      job.name,
      { pollingIntervalSeconds: job.pollingIntervalSeconds ?? 2 },
      async ([first, ...rest]) => {
        // batchSize defaults to 1; guard anyway so a config change can't drop jobs silently.
        if (!first || rest.length > 0) throw new Error(`${job.name}: expected exactly one job`);
        const data = job.schema.parse(first.data);
        return job.handle(data, {
          ...ctx,
          logger: ctx.logger.child({ job: job.name }),
          jobId: first.id,
        });
      },
    );
    ctx.logger.info({ queue: job.name }, 'queue ready');
  }
}
