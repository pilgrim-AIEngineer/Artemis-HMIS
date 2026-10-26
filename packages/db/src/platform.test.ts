import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { accessLog, appUser, auditLog, session, setting } from '../schema';
import {
  seedFacility,
  setupPlatformDb,
  type PlatformTestDb,
  type SeededFacility,
} from '../testing/platform';
import { ensureAppLoginRole } from './app-role';
import { createDb, type Db } from './client';
import { IdempotencyConflictError, runIdempotent } from './idempotency';
import { withTx } from './tx';

let t: PlatformTestDb;
let f: SeededFacility;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'));
  f = await seedFacility(t.owner);
});

afterAll(async () => {
  await t.close();
});

/** Postgres error code of a rejected promise (42501 = insufficient_privilege). */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
  return undefined;
}

const actor = (db: Db) => ({
  db,
  userId: f.userId,
  workstationId: f.workstationId,
  facilityId: f.facilityId,
});

const auditRows = (db: Db, table: string, rowId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, table), eq(auditLog.rowId, rowId)))
    .orderBy(auditLog.changedAt, auditLog.id);

const PLATFORM_TABLES = [
  'access_log',
  'app_user',
  'audit_log',
  'document',
  'facility',
  'idempotency',
  'integration_event',
  'number_series',
  'permission',
  'print_log',
  'role',
  'role_permission',
  'session',
  'setting',
  'user_role',
  'workstation',
];

/** Tables deliberately without the audit trigger (logs, caches, delivery queues). */
const NOT_AUDITED = [
  'access_log',
  'audit_log',
  'idempotency',
  'import_row', // staging copy of an uploaded file; the batch and the rows it creates are audited
  'integration_event',
  'print_log',
];

describe('platform schema (docs/04 §1)', () => {
  it('creates every platform table', async () => {
    const { rows } = await t.owner.$client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(PLATFORM_TABLES));
  });

  it('gives every table facility_id and timestamptz audit columns (AGENTS.md rule 3)', async () => {
    const { rows } = await t.owner.$client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `select c.table_name, c.column_name, c.data_type, c.is_nullable
       from information_schema.columns c
       join information_schema.tables tb using (table_schema, table_name)
       where c.table_schema = 'public' and tb.table_type = 'BASE TABLE'`,
    );
    const tables = new Set(rows.map((r) => r.table_name));
    for (const table of tables) {
      const cols = new Map(
        rows.filter((r) => r.table_name === table).map((r) => [r.column_name, r]),
      );
      expect(cols.get('id')?.data_type, table).toBe('uuid');
      expect(cols.get('facility_id')?.data_type, table).toBe('uuid');
      // audit_log is the documented exception: changed_at/changed_by, no updated_* (docs/04 §1).
      const required = table === 'audit_log' ? ['changed_at'] : ['created_at', 'updated_at'];
      for (const c of required) {
        expect(cols.get(c)?.data_type, `${table}.${c}`).toBe('timestamp with time zone');
        expect(cols.get(c)?.is_nullable, `${table}.${c}`).toBe('NO');
      }
      for (const c of table === 'audit_log' ? ['changed_by'] : ['created_by', 'updated_by']) {
        expect(cols.get(c)?.data_type, `${table}.${c}`).toBe('uuid');
      }
      if (table !== 'audit_log') expect(cols.get('facility_id')?.is_nullable, table).toBe('NO');
    }
  });

  it('attaches the audit + touch triggers to every business table', async () => {
    const { rows } = await t.owner.$client.query<{ table_name: string; triggers: string[] }>(
      `select c.relname as table_name,
              coalesce(array_agg(tg.tgname::text order by tg.tgname) filter (where tg.tgname is not null), '{}') as triggers
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       left join pg_trigger tg on tg.tgrelid = c.oid and not tg.tgisinternal
       where c.relkind = 'r'
       group by c.relname`,
    );
    for (const { table_name, triggers } of rows) {
      if (NOT_AUDITED.includes(table_name)) {
        expect(triggers, table_name).not.toContain('hmis_audit');
      } else {
        expect(triggers, table_name).toEqual(expect.arrayContaining(['hmis_audit', 'hmis_touch']));
      }
    }
  });

  it('creates the empty `restricted` schema, closed to PUBLIC', async () => {
    const { rows } = await t.owner.$client.query<{
      n: string;
      public_usage: boolean;
      app_usage: boolean;
    }>(
      `select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'restricted')::text as n,
              has_schema_privilege('public', 'restricted', 'USAGE') as public_usage,
              has_schema_privilege('hmis_app', 'restricted', 'USAGE') as app_usage`,
    );
    expect(rows[0]).toEqual({ n: '0', public_usage: false, app_usage: true });
  });

  it('generates UUIDv7 ids in the app and in the audit trigger', async () => {
    const id = uuidv7();
    await withTx(actor(t.app), (tx) =>
      tx
        .insert(setting)
        .values({ id, facilityId: f.facilityId, key: 'test.uuidVersion', value: 1 }),
    );
    const [audit] = await auditRows(t.app, 'setting', id);
    for (const u of [id, audit?.id]) expect(u?.[14], u).toBe('7');
  });
});

describe('audit trigger (FND-04)', () => {
  it('captures inserts with user and workstation from withTx', async () => {
    const id = uuidv7();
    await withTx(actor(t.app), (tx) =>
      tx
        .insert(setting)
        .values({ id, facilityId: f.facilityId, key: 'test.insert', value: { a: 1 } }),
    );
    const rows = await auditRows(t.app, 'setting', id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      facilityId: f.facilityId,
      action: 'I',
      changedBy: f.userId,
      workstationId: f.workstationId,
      before: null,
      after: { id, key: 'test.insert', value: { a: 1 }, created_by: f.userId },
    });
  });

  it('captures updates with before/after and keeps updated_at/updated_by', async () => {
    const id = uuidv7();
    await withTx({ db: t.app, userId: null }, (tx) =>
      tx.insert(setting).values({ id, facilityId: f.facilityId, key: 'test.update', value: 1 }),
    );
    await withTx(actor(t.app), (tx) =>
      tx.update(setting).set({ value: 2 }).where(eq(setting.id, id)),
    );
    const rows = await auditRows(t.app, 'setting', id);
    expect(rows.map((r) => r.action)).toEqual(['I', 'U']);
    expect(rows[0]?.changedBy).toBeNull();
    expect(rows[1]).toMatchObject({
      changedBy: f.userId,
      before: { value: 1, updated_by: null },
      after: { value: 2, updated_by: f.userId },
    });
    const [row] = await t.app.select().from(setting).where(eq(setting.id, id));
    expect(row?.updatedBy).toBe(f.userId);
    expect(row?.createdBy).toBeNull();
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(row!.createdAt.getTime());
  });

  it('skips no-op updates and ignored columns', async () => {
    const id = uuidv7();
    await withTx(actor(t.app), async (tx) => {
      await tx.insert(setting).values({ id, facilityId: f.facilityId, key: 'test.noop', value: 1 });
      await tx.update(setting).set({ value: 1 }).where(eq(setting.id, id));
    });
    expect(await auditRows(t.app, 'setting', id)).toHaveLength(1);

    const sid = uuidv7();
    await withTx(actor(t.app), async (tx) => {
      await tx.insert(session).values({
        id: sid,
        facilityId: f.facilityId,
        userId: f.userId,
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await tx.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, sid));
    });
    const rows = await auditRows(t.app, 'session', sid);
    expect(rows.map((r) => r.action)).toEqual(['I']);
    expect(rows[0]?.after).toMatchObject({ token_hash: '[redacted]' });
  });

  it('redacts secrets but records that they changed', async () => {
    await withTx(actor(t.app), (tx) =>
      tx
        .update(appUser)
        .set({ passwordHash: '$argon2id$v=19$S3CR3T' })
        .where(eq(appUser.id, f.userId)),
    );
    const rows = await auditRows(t.app, 'app_user', f.userId);
    const last = rows.at(-1);
    expect(last?.action).toBe('U');
    expect(last?.before).toMatchObject({ password_hash: null, pin_hash: null });
    expect(last?.after).toMatchObject({ password_hash: '[redacted:changed]', pin_hash: null });
    expect(JSON.stringify(rows)).not.toContain('S3CR3T');
  });

  it('rejects changes to id/facility_id/created_* on update', async () => {
    const id = uuidv7();
    await withTx(actor(t.app), (tx) =>
      tx.insert(setting).values({ id, facilityId: f.facilityId, key: 'test.immutable', value: 1 }),
    );
    expect(
      await pgCode(
        withTx(actor(t.app), (tx) =>
          tx.update(setting).set({ createdBy: uuidv7() }).where(eq(setting.id, id)),
        ),
      ),
    ).toBe('23514');
  });

  it('does not leak SET LOCAL values to the next transaction on the same connection', async () => {
    const single = createDb({
      connectionString: t.owner.$client.options.connectionString!,
      max: 1,
    });
    try {
      await withTx(
        { db: single, userId: f.userId, permissions: ['mtp.register.view'] },
        async () => {},
      );
      const res = await single.execute<{ u: string | null; p: string | null }>(
        sql`select nullif(current_setting('app.user_id', true), '') as u,
                   nullif(current_setting('app.user_permissions', true), '') as p`,
      );
      expect(res.rows[0]).toEqual({ u: null, p: null });
    } finally {
      await single.$client.end();
    }
  });

  it('validates the actor before opening the transaction', async () => {
    await expect(
      withTx({ db: t.app, userId: 'not-a-uuid' }, () => Promise.resolve(1)),
    ).rejects.toThrow();
    await expect(
      withTx({ db: t.app, userId: null, permissions: ['a,b'] }, () => Promise.resolve(1)),
    ).rejects.toThrow();
  });
});

describe('app role privileges (docs/02 §5)', () => {
  it('cannot insert, update, delete or truncate audit_log', async () => {
    const [row] = await t.app.select({ id: auditLog.id }).from(auditLog).limit(1);
    expect(row).toBeDefined();
    const id = row!.id;
    expect(
      await pgCode(t.app.update(auditLog).set({ action: 'D' }).where(eq(auditLog.id, id))),
    ).toBe('42501');
    expect(await pgCode(t.app.delete(auditLog).where(eq(auditLog.id, id)))).toBe('42501');
    expect(await pgCode(t.app.execute(sql`truncate audit_log`))).toBe('42501');
    expect(
      await pgCode(
        t.app
          .insert(auditLog)
          .values({ id: uuidv7(), tableName: 'x', rowId: uuidv7(), action: 'I' }),
      ),
    ).toBe('42501');
  });

  it('can append to access_log but not change or delete it', async () => {
    const id = uuidv7();
    await withTx(actor(t.app), (tx) =>
      tx.insert(accessLog).values({
        id,
        facilityId: f.facilityId,
        userId: f.userId,
        entity: 'mtp_case',
        entityId: uuidv7(),
        purpose: 'treatment',
      }),
    );
    expect(
      await pgCode(t.app.update(accessLog).set({ purpose: 'x' }).where(eq(accessLog.id, id))),
    ).toBe('42501');
    expect(await pgCode(t.app.delete(accessLog).where(eq(accessLog.id, id)))).toBe('42501');
  });

  it('has no DELETE on any table except idempotency, and no DDL', async () => {
    const { rows } = await t.owner.$client.query<{ table_name: string; privs: string[] }>(
      `select c.relname as table_name,
              array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
                    where has_table_privilege('hmis_app', c.oid, p)) as privs
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    const expected: Record<string, string[]> = {
      audit_log: ['SELECT'],
      access_log: ['SELECT', 'INSERT'],
      print_log: ['SELECT', 'INSERT'],
      idempotency: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    };
    for (const { table_name, privs } of rows) {
      expect(privs, table_name).toEqual(expected[table_name] ?? ['SELECT', 'INSERT', 'UPDATE']);
    }
    expect(await pgCode(t.app.execute(sql`create table public.evil (id int)`))).toBe('42501');
    expect(await pgCode(t.app.delete(setting).where(eq(setting.key, 'test.insert')))).toBe('42501');
  });

  it('refuses to turn a superuser into the app login', async () => {
    const { rows } = await t.owner.$client.query<{ u: string }>('select current_user as u');
    await expect(ensureAppLoginRole(t.owner, rows[0]!.u, 'x'.repeat(16))).rejects.toThrow(
      /superuser|owner/,
    );
  });
});

describe('restricted schema RLS pattern (packages/db/README.md)', () => {
  it('hides rows from the app role unless the transaction carries the permission', async () => {
    // Throwaway table following the documented MTP-01 pattern; the real schema stays empty.
    await t.owner.$client.query(`
      create table restricted.rls_probe (id uuid primary key, facility_id uuid not null, note text);
      alter table restricted.rls_probe enable row level security;
      create policy rls_probe_view on restricted.rls_probe for select to hmis_app
        using (hmis_has_permission('mtp.register.view')
               and facility_id = nullif(current_setting('app.facility_id', true), '')::uuid);
      insert into restricted.rls_probe values ('${uuidv7()}', '${f.facilityId}', 'probe');
    `);
    try {
      const count = (permissions: string[]) =>
        withTx({ ...actor(t.app), permissions }, async (tx) => {
          const r = await tx.execute<{ n: string }>(
            sql`select count(*)::text as n from restricted.rls_probe`,
          );
          return Number(r.rows[0]?.n);
        });
      expect(await count([])).toBe(0);
      expect(await count(['patient.view'])).toBe(0);
      expect(await count(['patient.view', 'mtp.register.view'])).toBe(1);
      const direct = await t.app.execute<{ n: string }>(
        sql`select count(*)::text as n from restricted.rls_probe`,
      );
      expect(direct.rows[0]?.n).toBe('0');
    } finally {
      await t.owner.$client.query('drop table restricted.rls_probe');
    }
  });

  it('refuses to register restricted tables for the public audit log', async () => {
    await t.owner.$client.query(
      'create table restricted.reg_probe (id uuid primary key, facility_id uuid not null)',
    );
    try {
      await expect(
        t.owner.$client.query(`select hmis_register_business_table('restricted.reg_probe')`),
      ).rejects.toThrow(/restricted/);
    } finally {
      await t.owner.$client.query('drop table restricted.reg_probe');
    }
  });
});

describe('idempotency (AGENTS.md rule 9, docs/02 §7)', () => {
  const run = (
    facilityId: string,
    procedure: string,
    key: string,
    payload: unknown,
    fn: () => Promise<unknown>,
  ) =>
    withTx({ ...actor(t.app), facilityId }, (tx) =>
      runIdempotent(tx, { facilityId, userId: f.userId, procedure, key, payload }, fn),
    );

  it('replays the stored result for the same payload and rejects a different payload', async () => {
    const key = uuidv7();
    let calls = 0;
    const exec = () => Promise.resolve({ receipt: ++calls });
    const first = await run(f.facilityId, 'payment.create', key, { amount: 500, a: 1 }, exec);
    const replay = await run(f.facilityId, 'payment.create', key, { a: 1, amount: 500 }, exec);
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    await expect(
      run(f.facilityId, 'payment.create', key, { amount: 5000, a: 1 }, exec),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(calls).toBe(1);
  });

  it('does not treat the same key under another procedure or facility as a replay', async () => {
    const key = uuidv7();
    const other = await seedFacility(t.owner, 'Other Hospital');
    let calls = 0;
    const exec = () => Promise.resolve({ n: ++calls });
    await run(f.facilityId, 'payment.create', key, { amount: 500 }, exec);
    await run(f.facilityId, 'payment.refund', key, { amount: 5000 }, exec);
    await run(other.facilityId, 'payment.create', key, { amount: 5000 }, exec);
    expect(calls).toBe(3);
  });

  it('runs a concurrent duplicate submit once', async () => {
    const key = uuidv7();
    let calls = 0;
    const exec = () => Promise.resolve({ n: ++calls });
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        run(f.facilityId, 'payment.create', key, { amount: 1 }, exec),
      ),
    );
    expect(calls).toBe(1);
    expect(new Set(rs.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});
