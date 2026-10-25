import { createTestDatabase } from '@hmis/db/testing';
import { createLogger } from '@hmis/shared/logger';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createBoss, registerJobs } from './boss';
import { noopJob } from './jobs/noop';

let boss: PgBoss;

async function waitForState(name: string, id: string, states: string[], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [job] = await boss.findJobs(name, { id });
    if (job && states.includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} still ${job?.state}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  boss = createBoss(await createTestDatabase(inject('testPgAdminUrl')));
  await boss.start();
  await registerJobs(boss, createLogger('test', 'silent'));
});

afterAll(async () => {
  await boss.stop({ graceful: false });
});

describe('worker queue', () => {
  it('runs the no-op job to completion', async () => {
    const id = await boss.send(noopJob.name, { note: 'smoke' });
    expect(id).toBeTruthy();
    const job = await waitForState(noopJob.name, id!, ['completed', 'failed']);
    expect(job.state).toBe('completed');
  });

  it('fails jobs whose payload does not match the schema', async () => {
    const id = await boss.send(noopJob.name, { unexpected: true }, { retryLimit: 0 });
    const job = await waitForState(noopJob.name, id!, ['completed', 'failed']);
    expect(job.state).toBe('failed');
  });
});
