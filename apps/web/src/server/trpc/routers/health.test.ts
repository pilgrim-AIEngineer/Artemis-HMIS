import { createDb, type Db } from '@hmis/db';
import { createTestDatabase } from '@hmis/db/testing';
import { healthStatusSchema } from '@hmis/shared';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { testContext } from '../../../../test/context';
import { formatError } from '../init';
import { createCaller } from '../root';

let db: Db;

beforeAll(async () => {
  db = createDb({ connectionString: await createTestDatabase(inject('testPgAdminUrl')) });
});

afterAll(async () => {
  await db.$client.end();
});

describe('health.check', () => {
  it('reports ok when the database answers', async () => {
    const res = await createCaller(testContext({ db: () => db })).health.check();
    expect(healthStatusSchema.parse(res)).toEqual(res);
    expect(res.status).toBe('ok');
    expect(res.checks.db.ok).toBe(true);
    // OPS-01: no backup volume in tests => an alert, but never a degraded status.
    expect(res.checks.backup.state).toBe('missing');
    expect(res.alerts.map((a) => a.code)).toContain('backup.missing');
  });

  it('reports degraded (not an error) when the database is unreachable', async () => {
    const dead = createDb({ connectionString: 'postgres://x:y@127.0.0.1:1/none' });
    try {
      const res = await createCaller(testContext({ db: () => dead })).health.check();
      expect(res.status).toBe('degraded');
      expect(res.checks.db).toEqual({ ok: false, latencyMs: null });
      expect(res.checks.queue).toBeNull();
      expect(res.alerts[0]?.code).toBe('db.down');
    } finally {
      await dead.$client.end();
    }
  });

  it('reports degraded when the database is not configured', async () => {
    const res = await createCaller(
      testContext({
        db: () => {
          throw new Error('Database not configured');
        },
      }),
    ).health.check();
    expect(res.status).toBe('degraded');
  });
});

describe('formatError', () => {
  const shape = (message: string) => ({
    message,
    code: -32603 as const,
    data: { code: 'INTERNAL_SERVER_ERROR' as const, httpStatus: 500, path: 'health.check' },
  });

  it('hides internal error messages behind an i18n key', () => {
    const leaked = 'relation "patient" does not exist';
    const out = formatError({
      shape: shape(leaked),
      error: new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: leaked }),
    });
    expect(out.message).toBe('errors.internal');
    expect(JSON.stringify(out)).not.toContain('relation');
  });

  it('keeps client-error messages (they are i18n keys by convention)', () => {
    const out = formatError({
      shape: {
        ...shape('errors.notFound'),
        code: -32004,
        data: { ...shape('').data, code: 'NOT_FOUND', httpStatus: 404 },
      },
      error: new TRPCError({ code: 'NOT_FOUND', message: 'errors.notFound' }),
    });
    expect(out.message).toBe('errors.notFound');
  });
});
