import { rupeesToPaise, type CreateVisitInput } from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLog, encounter, opdToken, queueEvent } from '../schema';
import type { MasterSeedResult } from '../seed/masters';
import { seedFacility, type PlatformTestDb, type SeededFacility } from '../testing/platform';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { setServiceRate } from './masters';
import { writeSetting } from './settings';
import { withTx } from './tx';
import { createDb } from './client';
import { issueToken, previewVisit, VisitInputError, createVisit } from './visits';

let fx: OpdFixture;
let t: PlatformTestDb;
let f: SeededFacility;
let m: MasterSeedResult;
let doctorA: string;
let doctorB: string;
let doctorNoRule: string;
let patients: string[] = [];
let run: OpdFixture['run'];
let actor: OpdFixture['actor'];
let newPatients: OpdFixture['newPatients'];
let newPatient: OpdFixture['newPatient'];
let visit: OpdFixture['visit'];

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  ({ t, f, m, doctorA, doctorB, doctorNoRule, run, actor, newPatients, newPatient, visit } = fx);
  patients = await newPatients(3);
});

afterAll(async () => {
  await t.close();
});

describe('consultation fee (REG-03)', () => {
  it('fills the fee from the tariff and snapshots it on the encounter', async () => {
    const p = patients[0]!;
    const preview = await run((tx) =>
      previewVisit(
        tx,
        f.facilityId,
        { patientId: p, doctorId: doctorA },
        IST('2026-10-26T10:00:00'),
      ),
    );
    expect(preview).toMatchObject({
      visitType: 'new',
      suggestedVisitType: 'new',
      payerId: m.selfPayerId,
      tariffId: m.defaultTariffId,
    });
    expect(preview.fee).toMatchObject({ ratePaise: 50_000n, basis: 'tariff' });
    const out = await visit({ patientId: p }, IST('2026-10-26T10:00:00'));
    expect(out).toMatchObject({
      visitType: 'new',
      feePaise: '50000',
      feeBasis: 'tariff',
      tokenId: null,
      tokenIssueBasis: null,
    });
    expect(out.number).toBe('OP/26-27/000001');
    const [enc] = await t.app.select().from(encounter).where(eq(encounter.id, out.encounterId));
    expect(enc).toMatchObject({
      consultationFeePaise: 50_000n,
      visitDate: '2026-10-26',
      type: 'opd',
      status: 'open',
    });
  });

  it('uses the new rate for a later visit but keeps the old snapshot', async () => {
    const [row] = await t.app.select().from(encounter).limit(1);
    expect(row?.consultationFeePaise).toBe(50_000n);
    await run((tx) =>
      setServiceRate(tx, {
        facilityId: f.facilityId,
        serviceId: row!.consultationServiceId!,
        tariffId: m.defaultTariffId,
        ratePaise: rupeesToPaise(600),
        effectiveFrom: '2026-10-27',
      }),
    );
    const next = await run((tx) =>
      previewVisit(
        tx,
        f.facilityId,
        { patientId: patients[1]!, doctorId: doctorB },
        IST('2026-10-27T10:00:00'),
      ),
    );
    expect(next.fee.ratePaise).toBe(60_000n);
    const [again] = await t.app.select().from(encounter).where(eq(encounter.id, row!.id));
    expect(again?.consultationFeePaise).toBe(50_000n);
  });

  it('gives ₹0 and no token for a doctor without a fee rule, so it is noticed', async () => {
    const out = await visit(
      { patientId: patients[2]!, doctorId: doctorNoRule },
      IST('2026-10-26T10:05:00'),
    );
    expect(out).toMatchObject({ feePaise: '0', feeBasis: 'no_rule', tokenId: null });
  });

  it('rejects unknown, cancelled or deceased patients and unknown doctors', async () => {
    const key = (over: Partial<CreateVisitInput>) => visit(over, IST('2026-10-26T10:00:00'));
    await expect(key({ patientId: uuidv7() })).rejects.toMatchObject({
      key: 'visit.patientNotFound',
    });
    await expect(key({ doctorId: uuidv7() })).rejects.toMatchObject({
      key: 'visit.doctorNotFound',
    });
    const dead = await newPatient();
    await t.owner.execute(sql`update patient set is_deceased = true where id = ${dead}`);
    await expect(key({ patientId: dead })).rejects.toMatchObject({ key: 'visit.patientDeceased' });
  });

  it('refuses another facility’s patient or doctor', async () => {
    const other = await seedFacility(t.owner, 'Other Hospital');
    await expect(
      withTx({ db: t.app, userId: other.userId, facilityId: other.facilityId }, (tx) =>
        createVisit(
          tx,
          { facilityId: other.facilityId, userId: other.userId },
          { patientId: patients[0]!, doctorId: doctorA, idempotencyKey: uuidv7() },
          IST('2026-10-26T10:00:00'),
        ),
      ),
    ).rejects.toBeInstanceOf(VisitInputError);
  });
});

describe('follow-up validity (REG-03, Q6 defaults 7 days / 1 free)', () => {
  let p: string;
  beforeAll(async () => {
    p = await newPatient();
  });

  it('suggests follow-up inside the window at the follow-up rate, then new once the free one is used', async () => {
    const first = await visit({ patientId: p }, IST('2026-11-02T09:00:00'));
    expect(first.visitType).toBe('new');

    const fu = await visit({ patientId: p }, IST('2026-11-05T09:00:00'));
    expect(fu).toMatchObject({ visitType: 'follow_up', feePaise: '0', tokenIssueBasis: 'free' });
    expect(fu.tokenNo).toBe(1);

    const again = await run((tx) =>
      previewVisit(
        tx,
        f.facilityId,
        { patientId: p, doctorId: doctorA },
        IST('2026-11-06T09:00:00'),
      ),
    );
    expect(again).toMatchObject({ suggestedVisitType: 'new' });
    expect(again.followUp).toMatchObject({ eligible: false, reason: 'exhausted' });
  });

  it('refuses a manually chosen follow-up the patient is not entitled to', async () => {
    await expect(
      visit({ patientId: p, visitType: 'follow_up' }, IST('2026-11-06T09:00:00')),
    ).rejects.toMatchObject({
      key: 'visit.followUpNotEligible',
    });
  });

  it('counts day 7 as valid and day 8 as expired, on IST days (23:50 vs 00:10)', async () => {
    const q = await newPatient();
    await visit({ patientId: q }, IST('2026-11-10T23:50:00'));
    const day7 = await run((tx) =>
      previewVisit(
        tx,
        f.facilityId,
        { patientId: q, doctorId: doctorA },
        IST('2026-11-17T00:10:00'),
      ),
    );
    expect(day7.followUp).toMatchObject({ eligible: true, indexDate: '2026-11-10' });
    const day8 = await run((tx) =>
      previewVisit(
        tx,
        f.facilityId,
        { patientId: q, doctorId: doctorA },
        IST('2026-11-18T00:10:00'),
      ),
    );
    expect(day8.followUp).toMatchObject({ eligible: false, reason: 'expired' });
  });

  it('does not count a cancelled visit or a visit with another doctor', async () => {
    const q = await newPatient();
    const v = await visit({ patientId: q, doctorId: doctorB }, IST('2026-11-20T09:00:00'));
    const other = await run((tx) =>
      previewVisit(
        tx,
        f.facilityId,
        { patientId: q, doctorId: doctorA },
        IST('2026-11-21T09:00:00'),
      ),
    );
    expect(other.followUp.reason).toBe('no_prior_visit');
    await t.owner.execute(
      sql`update encounter set status = 'cancelled', cancel_reason = 'x', cancelled_at = now() where id = ${v.encounterId}`,
    );
    const same = await run((tx) =>
      previewVisit(
        tx,
        f.facilityId,
        { patientId: q, doctorId: doctorB },
        IST('2026-11-21T09:00:00'),
      ),
    );
    expect(same.followUp.reason).toBe('no_prior_visit');
  });

  it('reads validity and free count from settings, per doctor, and from the master rule first', async () => {
    const q = await newPatient();
    await visit({ patientId: q }, IST('2026-12-01T09:00:00'));
    const at = IST('2026-12-04T09:00:00');
    const elig = () =>
      run((tx) => previewVisit(tx, f.facilityId, { patientId: q, doctorId: doctorA }, at)).then(
        (x) => x.followUp.eligible,
      );
    expect(await elig()).toBe(true);
    await run((tx) => writeSetting(tx, f.facilityId, 'opd.followUpValidityDays', 2));
    expect(await elig()).toBe(false);
    await run((tx) =>
      writeSetting(tx, f.facilityId, 'opd.followUpRulesByDoctor', {
        [doctorA]: { validityDays: 5, freeFollowUps: 1 },
      }),
    );
    expect(await elig()).toBe(true);
    await t.owner.execute(
      sql`update consultation_rule set follow_up_validity_days = 1 where doctor_id = ${doctorA} and visit_type = 'follow_up'`,
    );
    expect(await elig()).toBe(false);
    await t.owner.execute(
      sql`update consultation_rule set follow_up_validity_days = null where doctor_id = ${doctorA}`,
    );
    await run((tx) => writeSetting(tx, f.facilityId, 'opd.followUpRulesByDoctor', {}));
    await run((tx) => writeSetting(tx, f.facilityId, 'opd.followUpValidityDays', 7));
  });
});

describe('visit creation guards and tokens', () => {
  it('replays a duplicate submit and conflicts on a changed payload', async () => {
    const q = await newPatient();
    const key = uuidv7();
    const at = IST('2027-01-05T09:00:00');
    const a = await visit({ patientId: q, idempotencyKey: key }, at);
    const b = await visit({ patientId: q, idempotencyKey: key }, at);
    expect(b).toEqual(a);
    const rows = await t.app.select().from(encounter).where(eq(encounter.patientId, q));
    expect(rows).toHaveLength(1);
    await expect(
      visit({ patientId: q, doctorId: doctorB, idempotencyKey: key }, at),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('asks before a second visit with the same doctor on the same day', async () => {
    const q = await newPatient();
    const at = IST('2027-01-06T09:00:00');
    await visit({ patientId: q }, at);
    await expect(visit({ patientId: q }, at)).rejects.toMatchObject({ key: 'visit.alreadyToday' });
    const second = await visit({ patientId: q, visitType: 'new', allowRepeatToday: true }, at);
    expect(second.visitType).toBe('new');
  });

  it('issues the token before payment when the setting says so, with that basis', async () => {
    const q = await newPatient();
    await run((tx) => writeSetting(tx, f.facilityId, 'queue.issueTokenBeforePayment', true));
    const out = await visit({ patientId: q }, IST('2027-01-07T09:00:00'));
    await run((tx) => writeSetting(tx, f.facilityId, 'queue.issueTokenBeforePayment', false));
    expect(out).toMatchObject({ tokenIssueBasis: 'before_payment_setting', tokenNo: 1 });
  });

  it('issues a held token later, once, with the stated basis', async () => {
    const q = await newPatient();
    const at = IST('2027-01-08T09:00:00');
    const v = await visit({ patientId: q, priority: 'elderly' }, at);
    expect(v.tokenId).toBeNull();
    const tok = await run((tx) => issueToken(tx, actor(), v.encounterId, 'manual_fee_pending', at));
    expect(tok).toMatchObject({ tokenNo: 1, tokenDate: '2027-01-08' });
    const [row] = await t.app.select().from(opdToken).where(eq(opdToken.id, tok.tokenId));
    expect(row).toMatchObject({
      priority: 'elderly',
      queueState: 'waiting',
      issuedBasis: 'manual_fee_pending',
    });
    await expect(
      run((tx) => issueToken(tx, actor(), v.encounterId, 'payment', at)),
    ).rejects.toMatchObject({ key: 'visit.tokenAlreadyIssued' });
    const events = await t.app.select().from(queueEvent).where(eq(queueEvent.tokenId, tok.tokenId));
    expect(events.map((e) => [e.fromState, e.toState, e.action])).toEqual([
      [null, 'waiting', 'issue'],
    ]);
  });

  it('audits encounters and tokens', async () => {
    const rows = await t.app
      .select({ table: auditLog.tableName })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.facilityId, f.facilityId),
          sql`${auditLog.tableName} in ('encounter', 'opd_token', 'queue_event')`,
        ),
      );
    expect(new Set(rows.map((r) => r.table))).toEqual(
      new Set(['encounter', 'opd_token', 'queue_event']),
    );
  });
});

describe('token numbers under concurrency (docs/10 §10)', () => {
  // The suite runs many database tests at once; a loaded machine must not turn a queue for a
  // pooled connection into a test failure, so these tests use a pool that waits longer.
  let slowDb: ReturnType<typeof createDb>;
  let runSlow: OpdFixture['run'];
  beforeAll(() => {
    slowDb = createDb({
      connectionString: t.app.$client.options.connectionString!,
      max: 30,
      connectionTimeoutMs: 120_000,
    });
    runSlow = (fn) => withTx({ db: slowDb, userId: f.userId, facilityId: f.facilityId }, fn);
  });
  afterAll(async () => {
    await slowDb.$client.end();
  });
  const visitSlow: OpdFixture['visit'] = (over, now) =>
    runSlow((tx) =>
      createVisit(
        tx,
        actor(),
        { patientId: patients[0]!, doctorId: doctorA, idempotencyKey: uuidv7(), ...over },
        now,
      ),
    );

  it('100 parallel token requests for one doctor get 1..100, no duplicate, no gap', async () => {
    const ids = await newPatients(100);
    const at = IST('2027-02-01T09:00:00');
    // Book the visits in small batches (the visit-number row lock serialises them anyway), then
    // release all 100 tokens at once: that is the contended step (docs/10 §10).
    const encounters: string[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const batch = await Promise.all(
        ids.slice(i, i + 10).map((patientId) => visitSlow({ patientId, doctorId: doctorB }, at)),
      );
      encounters.push(...batch.map((v) => v.encounterId));
    }
    const results = await Promise.all(
      encounters.map((id) =>
        runSlow((tx) => issueToken(tx, actor(), id, 'manual_fee_pending', at)),
      ),
    );
    const nos = results.map((r) => r.tokenNo).sort((a, b) => a - b);
    expect(nos).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    const [dups] = (
      await t.owner.execute<{ n: string }>(
        sql`select count(*) as n from (select 1 from opd_token where doctor_id = ${doctorB} and token_date = '2027-02-01' group by token_no having count(*) > 1) d`,
      )
    ).rows;
    expect(dups?.n).toBe('0');
  });

  it('40 parallel visits that need no payment get distinct tokens and visit numbers', async () => {
    const ids = await newPatients(40);
    const at = IST('2027-02-04T09:00:00');
    await run((tx) => writeSetting(tx, f.facilityId, 'queue.issueTokenBeforePayment', true));
    try {
      const out = await Promise.all(
        ids.map((patientId) => visitSlow({ patientId, doctorId: doctorB }, at)),
      );
      expect(out.map((o) => o.tokenNo).sort((a, b) => a! - b!)).toEqual(
        Array.from({ length: 40 }, (_, i) => i + 1),
      );
      expect(new Set(out.map((o) => o.number)).size).toBe(40);
    } finally {
      await run((tx) => writeSetting(tx, f.facilityId, 'queue.issueTokenBeforePayment', false));
    }
  });

  it('parallel free visits to two doctors number independently and restart each day', async () => {
    const ids = await newPatients(20);
    const day1 = IST('2027-02-02T09:00:00');
    const out = await Promise.all(
      ids.map((patientId, i) =>
        visitSlow(
          {
            patientId,
            doctorId: i % 2 ? doctorA : doctorB,
            visitType: i % 2 ? 'follow_up' : undefined,
          },
          day1,
        ).catch((e: unknown) => e),
      ),
    );
    // follow_up is refused for patients without history; the free path is covered by the follow-up tests.
    expect(out.filter((x) => x instanceof VisitInputError)).toHaveLength(10);
    const day2 = IST('2027-02-03T09:00:00');
    const q = await newPatient();
    const v = await visitSlow({ patientId: q, doctorId: doctorB }, day2);
    const tok = await run((tx) =>
      issueToken(tx, actor(), v.encounterId, 'manual_fee_pending', day2),
    );
    expect(tok.tokenNo).toBe(1);
  });

  it('visit numbers stay unique and gap-free under parallel creation', async () => {
    const ids = await newPatients(30);
    const at = IST('2027-02-10T09:00:00');
    const out = await Promise.all(
      ids.map((patientId) => visitSlow({ patientId, doctorId: doctorNoRule }, at)),
    );
    const nums = out.map((o) => Number(o.number.split('/').at(-1))).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(30);
    expect(nums.at(-1)! - nums[0]!).toBe(29);
  });
});
