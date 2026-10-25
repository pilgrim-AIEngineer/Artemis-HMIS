/**
 * The admin forms send what the form schemas parse: blanks as '', numbers as numbers. This walks
 * every master kind through create → update → list → cancel → restore with exactly such payloads,
 * so a form field that the server schema (or the table) cannot take is caught here, not by staff.
 */
import { withTx } from '@hmis/db';
import { seedMasters } from '@hmis/db/seed';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MASTER_DEFS, ENUMS, type FieldDef } from '@/components/masters/definitions';
import { MASTER_PROCS } from '@/components/masters/api';
import {
  setupAuthFixture,
  type AuthFixture,
  type Caller,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let admin: TestBrowser;
let departmentId: string;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  await withTx({ db: f.db, userId: null }, (tx) => seedMasters(tx, f.a.facilityId));
  admin = f.browser();
  await admin.login(f.users.admin.username);
  departmentId = (await admin.call((c) => c.masters.listDepartments({ search: 'pathology' })))
    .rows[0]!.id;
});

afterAll(async () => {
  await f.close();
});

type Proc = (input: unknown) => Promise<unknown>;
const run = (name: string, input: unknown) =>
  admin.call((c: Caller) => (c.masters as unknown as Record<string, Proc>)[name]!(input));

/** Smallest valid form content for a field, the way a user fills only the required ones. */
function fill(fld: FieldDef, defaults: Record<string, unknown>, n: string): unknown {
  if (fld.name in defaults && defaults[fld.name] !== '') return defaults[fld.name];
  switch (fld.type) {
    case 'checkbox':
      return false;
    case 'weekdays':
      return [];
    case 'gstPercent':
      return 0;
    case 'integer':
      return fld.nullable ? null : 0;
    case 'date':
      return fld.required ? '2026-04-01' : '';
    case 'select':
      if (fld.name === 'departmentId') return departmentId;
      if (fld.enum) return ENUMS[fld.enum][0];
      return '';
    default:
      return fld.required ? `${fld.name} ${n}`.slice(0, 40) : '';
  }
}

describe.each(Object.values(MASTER_DEFS))('$kind form payloads', (def) => {
  it('creates, edits, lists, removes and restores', async () => {
    const names = MASTER_PROCS[def.kind];
    const n = `T${def.kind.length}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const values = Object.fromEntries(
      def.fields.map((fld) => [
        fld.name,
        fld.upper || fld.name === 'code' ? `X${n}` : fill(fld, def.defaults, n),
      ]),
    );
    // Codes of reason codes are lower-case; payers must stay switched off in Phase 1.
    if (def.kind === 'reason-codes') values.code = `x_${n.toLowerCase()}`;
    if (def.kind === 'payers') values.isActive = false;
    values[def.titleKey] = `Test ${def.kind} ${n}`;

    const parsed = def.schema.safeParse(values);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const input = parsed.data as Record<string, unknown>;

    const { id } = (await run(names.create, input)) as { id: string };
    expect(id).toBeTruthy();

    const edited = { ...input, [def.titleKey]: `Edited ${def.kind} ${n}` };
    await run(names.update, { ...edited, id });

    const list = (await run(names.list, { search: `Edited ${def.kind} ${n}` })) as {
      rows: { id: string; status: string }[];
    };
    expect(list.rows.map((r) => r.id)).toContain(id);

    await run(names.cancel, { id, reason: 'E2E payload check' });
    const hidden = (await run(names.list, { search: `Edited ${def.kind} ${n}` })) as {
      rows: unknown[];
    };
    expect(hidden.rows).toHaveLength(0);
    await run(names.restore, { id });
  });
});
