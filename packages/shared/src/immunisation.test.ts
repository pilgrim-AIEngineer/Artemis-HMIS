import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, parseIsoDate, toIsoDate } from './dates';
import {
  checkDoseTiming,
  computeImmunisationSchedule,
  DEFAULT_EARLY_GRACE_DAYS,
  DEFAULT_IMMUNISATION_SCHEDULES,
  DEFAULT_OVERDUE_GRACE_DAYS,
  dosesDueOn,
  firstOutstandingOfSeries,
  IAP_SCHEDULE,
  nextDueDate,
  outstandingDoses,
  recordDoseSchema,
  reminderSendAt,
  reminderDoses,
  scheduleItemCode,
  UIP_SCHEDULE,
  type GivenDose,
  type ScheduleItem,
  type ScheduleRow,
} from './immunisation';

const plus = (iso: string, n: number) => toIsoDate(addDays(parseIsoDate(iso), n));
const DOB = '2026-01-10';

const sched = (o: {
  dob?: string;
  today: string;
  given?: GivenDose[];
  items?: readonly ScheduleItem[];
  sex?: 'F' | 'M' | 'O' | null;
}): ScheduleRow[] =>
  computeImmunisationSchedule({
    dob: o.dob ?? DOB,
    sex: o.sex === undefined ? 'F' : o.sex,
    today: o.today,
    items: o.items ?? IAP_SCHEDULE,
    given: o.given ?? [],
  });
const row = (rows: ScheduleRow[], code: string) => rows.find((r) => r.code === code)!;
const give = (itemCode: string, givenOn: string, id = `g-${itemCode}`): GivenDose => ({
  id,
  itemCode,
  givenOn,
});

const bySeriesOf = (items: readonly ScheduleItem[]) => {
  const m = new Map<string, ScheduleItem[]>();
  for (const i of items) m.set(i.vaccineCode, [...(m.get(i.vaccineCode) ?? []), i]);
  return m;
};

describe('schedule master (drafts)', () => {
  for (const [name, items] of Object.entries(DEFAULT_IMMUNISATION_SCHEDULES)) {
    describe(name, () => {
      it('has unique codes and every item names its schedule', () => {
        const codes = items.map(scheduleItemCode);
        expect(new Set(codes).size).toBe(codes.length);
        expect(items.every((i) => i.scheduleName === name)).toBe(true);
      });
      it('numbers doses 1..n in each series with the first having no interval', () => {
        const bySeries = bySeriesOf(items);
        for (const list of bySeries.values()) {
          expect(list.map((i) => i.doseNo)).toEqual(list.map((_, k) => k + 1));
          expect(list[0]!.minIntervalDays).toBeNull();
        }
      });
      it('never recommends a dose before its minimum age, nor after its cap', () => {
        for (const i of items) {
          expect(i.dueAgeDays).toBeGreaterThanOrEqual(i.minAgeDays);
          if (i.maxAgeDays !== null) expect(i.maxAgeDays).toBeGreaterThanOrEqual(i.dueAgeDays);
        }
      });
      it('is consistent: a child on time never gets pushed back by an interval', () => {
        const bySeries = bySeriesOf(items);
        for (const list of bySeries.values()) {
          list.forEach((i, k) => {
            if (k === 0 || i.minIntervalDays === null) return;
            const prev = list[k - 1]!;
            expect(i.dueAgeDays - prev.dueAgeDays, scheduleItemCode(i)).toBeGreaterThanOrEqual(
              i.minIntervalDays,
            );
          });
        }
      });
      it('has Hindi labels', () => {
        expect(items.every((i) => /[ऀ-ॿ]/.test(i.labelHi))).toBe(true);
      });
    });
  }
  it('IAP matches docs/33 §5 at the main ages (days)', () => {
    const due = (c: string) => IAP_SCHEDULE.find((i) => scheduleItemCode(i) === c)!.dueAgeDays;
    expect(due('BCG-1')).toBe(0);
    expect(due('HEPB-1')).toBe(0);
    expect(due('DTP-1')).toBe(42);
    expect(due('DTP-2')).toBe(70);
    expect(due('DTP-3')).toBe(98);
    expect(due('MMR-1')).toBe(274);
    expect(due('HEPA-1')).toBe(365);
    expect(due('MMR-2')).toBe(457);
    expect(due('VAR-1')).toBe(457);
    expect(due('DTP-4')).toBe(487);
    expect(due('HPV-1')).toBe(3287);
    expect(due('TDAP-1')).toBe(3653);
  });
});

describe('due dates from the date of birth', () => {
  it('birth doses are due on the birth date, 6/10/14 week doses 42/70/98 days later', () => {
    const rows = sched({ today: DOB });
    expect(row(rows, 'BCG-1').dueDate).toBe(DOB);
    expect(row(rows, 'DTP-1').dueDate).toBe('2026-02-21');
    expect(row(rows, 'DTP-2').dueDate).toBe('2026-03-21');
    expect(row(rows, 'DTP-3').dueDate).toBe('2026-04-18');
  });
  it('counts across a leap day (born 29-Feb-2024)', () => {
    const rows = sched({ dob: '2024-02-29', today: '2024-02-29' });
    expect(row(rows, 'DTP-1').dueDate).toBe('2024-04-11');
    expect(row(rows, 'MMR-1').dueDate).toBe(plus('2024-02-29', 274));
    expect(row(rows, 'HEPA-1').dueDate).toBe('2025-02-28'); // 365 days later
  });
  it('counts across a year end', () => {
    const rows = sched({ dob: '2025-12-31', today: '2025-12-31' });
    expect(row(rows, 'DTP-1').dueDate).toBe('2026-02-11');
  });
  it('is the same for every date of birth in a leap cycle: dob + age in days', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1461 }), (n) => {
        const dob = plus('2023-01-01', n);
        const rows = sched({ dob, today: dob });
        for (const r of rows.filter((x) => x.status !== 'not_applicable')) {
          expect(r.dueDate).toBe(plus(dob, r.item.dueAgeDays));
        }
      }),
    );
  });
});

describe('status: upcoming, due, overdue', () => {
  const dueDay = '2026-02-21';
  it('is upcoming the day before, due on the day', () => {
    expect(row(sched({ today: plus(dueDay, -1) }), 'DTP-1').status).toBe('upcoming');
    expect(row(sched({ today: dueDay }), 'DTP-1').status).toBe('due');
  });
  it('stays due through the grace days and is overdue after', () => {
    expect(row(sched({ today: plus(dueDay, DEFAULT_OVERDUE_GRACE_DAYS) }), 'DTP-1').status).toBe(
      'due',
    );
    const late = row(sched({ today: plus(dueDay, DEFAULT_OVERDUE_GRACE_DAYS + 1) }), 'DTP-1');
    expect(late.status).toBe('overdue');
    expect(late.daysLate).toBe(DEFAULT_OVERDUE_GRACE_DAYS + 1);
  });
  it('honours a different grace', () => {
    const r = computeImmunisationSchedule({
      dob: DOB,
      sex: 'F',
      today: plus(dueDay, 1),
      items: IAP_SCHEDULE,
      given: [],
      overdueGraceDays: 0,
    });
    expect(row(r, 'DTP-1').status).toBe('overdue');
  });
  it('a given dose is given whatever the date', () => {
    const r = row(sched({ today: '2030-01-01', given: [give('BCG-1', DOB)] }), 'BCG-1');
    expect(r.status).toBe('given');
    expect(r.givenOn).toBe(DOB);
    expect(r.givenId).toBe('g-BCG-1');
  });
  it('ignores given records of vaccines outside the schedule', () => {
    const rows = sched({
      today: DOB,
      given: [{ id: 'x', itemCode: null, givenOn: DOB }, give('NOPE-1', DOB)],
    });
    expect(rows.every((r) => r.status !== 'given')).toBe(true);
  });
});

describe('catch-up', () => {
  it('moves the next dose to given date + minimum interval when the dose was late', () => {
    // DTP-1 due day 42 (21-Feb), given on day 60 (11-Mar): DTP-2 would be day 70 (21-Mar) but
    // 28 days after 11-Mar is 8-Apr.
    const rows = sched({ today: '2026-03-11', given: [give('DTP-1', '2026-03-11')] });
    expect(row(rows, 'DTP-2').dueDate).toBe('2026-04-08');
    expect(row(rows, 'DTP-2').earliestDate).toBe('2026-04-08');
    expect(row(rows, 'DTP-3').dueDate).toBe('2026-05-06');
  });
  it('leaves the next dose on its own date when the previous one was on time', () => {
    const rows = sched({ today: '2026-02-21', given: [give('DTP-1', '2026-02-21')] });
    expect(row(rows, 'DTP-2').dueDate).toBe('2026-03-21');
    expect(row(rows, 'DTP-3').dueDate).toBe('2026-04-18');
  });
  it('does not pull the next dose forward when the previous one was given early', () => {
    const rows = sched({ today: '2026-02-15', given: [give('DTP-1', '2026-02-15')] });
    expect(row(rows, 'DTP-2').dueDate).toBe('2026-03-21');
  });
  it('catch-up follows the interval, not the due age, for a late booster', () => {
    // DTP-3 given at 9 months; the 16-month booster needs 6 months after it.
    const dob = '2025-01-01';
    const given = '2025-10-01';
    const rows = sched({ dob, today: given, given: [give('DTP-3', given)] });
    expect(row(rows, 'DTP-4').dueDate).toBe(plus(dob, 487)); // 6 months after 1-Oct = 1-Apr (day 455) < 487
    const lateGiven = '2026-01-01';
    const rows2 = sched({ dob, today: lateGiven, given: [give('DTP-3', lateGiven)] });
    expect(row(rows2, 'DTP-4').dueDate).toBe(plus(lateGiven, 183));
  });
  it('projects the rest of a series from today when a dose is missing', () => {
    // 200 days old, nothing given: DTP-1 is overdue; DTP-2 and 3 count from today.
    const today = plus(DOB, 200);
    const rows = sched({ today });
    expect(row(rows, 'DTP-1').status).toBe('overdue');
    expect(row(rows, 'DTP-1').dueDate).toBe('2026-02-21');
    expect(row(rows, 'DTP-2').dueDate).toBe(plus(today, 28));
    expect(row(rows, 'DTP-2').waitingFor).toBe('DTP-1');
    expect(row(rows, 'DTP-2').status).toBe('upcoming');
    expect(row(rows, 'DTP-3').dueDate).toBe(plus(today, 56));
    expect(row(rows, 'DTP-3').waitingFor).toBe('DTP-2');
  });
  it('a dose given today pulls the projection from today, not from the old due date', () => {
    const today = plus(DOB, 200);
    const rows = sched({ today, given: [give('DTP-1', today)] });
    expect(row(rows, 'DTP-2').dueDate).toBe(plus(today, 28));
    expect(row(rows, 'DTP-2').waitingFor).toBeNull();
    expect(row(rows, 'DTP-2').status).toBe('upcoming');
  });
  it('a dose with no interval (null) only waits for its own age', () => {
    const items: ScheduleItem[] = [
      { ...IAP_SCHEDULE.find((i) => i.vaccineCode === 'MMR' && i.doseNo === 1)! },
      {
        ...IAP_SCHEDULE.find((i) => i.vaccineCode === 'MMR' && i.doseNo === 2)!,
        minIntervalDays: null,
      },
    ];
    const rows = sched({ items, today: '2026-12-01', given: [give('MMR-1', '2026-12-01')] });
    expect(row(rows, 'MMR-2').dueDate).toBe(plus(DOB, 457));
  });
  it('a second dose can never be due before the first was given', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 400 }),
        (givenAge, todayAfter) => {
          const g = plus(DOB, givenAge);
          const rows = sched({ today: plus(g, todayAfter), given: [give('DTP-1', g)] });
          const d2 = row(rows, 'DTP-2');
          if (d2.dueDate) {
            expect(d2.dueDate >= plus(g, 28)).toBe(true);
            expect(d2.dueDate >= plus(DOB, 70)).toBe(true);
          }
        },
      ),
    );
  });
});

describe('not applicable', () => {
  it('rotavirus-1 beyond 14 weeks 6 days closes the whole series (IAP)', () => {
    const rows = sched({ today: plus(DOB, 110) });
    expect(row(rows, 'ROTA-1').status).toBe('not_applicable');
    expect(row(rows, 'ROTA-1').notApplicable).toBe('age_exceeded');
    expect(row(rows, 'ROTA-2').notApplicable).toBe('series_closed');
    expect(row(rows, 'ROTA-3').notApplicable).toBe('series_closed');
  });
  it('rotavirus-1 on the last allowed day is still open', () => {
    const rows = sched({ today: plus(DOB, 104) });
    expect(row(rows, 'ROTA-1').status).not.toBe('not_applicable');
  });
  it('a series already started is not closed by a later cap on a dose that was given', () => {
    const rows = sched({
      today: plus(DOB, 120),
      given: [give('ROTA-1', plus(DOB, 100))],
    });
    expect(row(rows, 'ROTA-1').status).toBe('given');
    expect(row(rows, 'ROTA-2').status).not.toBe('not_applicable');
  });
  it('rotavirus-2 whose catch-up date would pass 8 months is closed', () => {
    const rows = sched({ today: plus(DOB, 230), given: [give('ROTA-1', plus(DOB, 104))] });
    // due = max(70, 104+28=132) = 132 <= 243: still open today
    expect(row(rows, 'ROTA-2').status).not.toBe('not_applicable');
    const rows2 = sched({ today: plus(DOB, 250), given: [give('ROTA-1', plus(DOB, 104))] });
    expect(row(rows2, 'ROTA-2').notApplicable).toBe('age_exceeded');
    expect(row(rows2, 'ROTA-3').notApplicable).toBe('series_closed');
  });
  it('UIP BCG is not applicable after the first year', () => {
    const rows = sched({ items: UIP_SCHEDULE, today: plus(DOB, 365) });
    expect(row(rows, 'BCG-1').status).toBe('not_applicable');
    const open = sched({ items: UIP_SCHEDULE, today: plus(DOB, 364) });
    expect(row(open, 'BCG-1').status).toBe('overdue');
  });
  it('HPV is for girls in the draft', () => {
    const male = sched({ sex: 'M', today: '2036-01-10' });
    expect(row(male, 'HPV-1').notApplicable).toBe('sex');
    const unknown = sched({ sex: null, today: '2036-01-10' });
    expect(row(unknown, 'HPV-1').notApplicable).toBe('sex');
    const female = sched({ sex: 'F', today: plus(DOB, 3287) });
    expect(row(female, 'HPV-1').status).toBe('due');
  });
  it('a not-applicable dose has no due date and is left out of the outstanding list', () => {
    const rows = sched({ today: plus(DOB, 400) });
    const r = row(rows, 'ROTA-1');
    expect(r.dueDate).toBeNull();
    expect(outstandingDoses(rows).some((x) => x.code === 'ROTA-1')).toBe(false);
  });
});

describe('warnings on given doses', () => {
  it('flags a dose given earlier than allowed beyond the grace days', () => {
    const early = plus(DOB, 42 - DEFAULT_EARLY_GRACE_DAYS - 1);
    const rows = sched({ today: early, given: [give('DTP-1', early)] });
    expect(row(rows, 'DTP-1').warnings).toContain('early');
    const ok = plus(DOB, 42 - DEFAULT_EARLY_GRACE_DAYS);
    const rows2 = sched({ today: ok, given: [give('DTP-1', ok)] });
    expect(row(rows2, 'DTP-1').warnings).not.toContain('early');
  });
  it('flags a dose too soon after the previous one', () => {
    const rows = sched({
      today: plus(DOB, 100),
      given: [give('DTP-1', plus(DOB, 60)), give('DTP-2', plus(DOB, 70))],
    });
    expect(row(rows, 'DTP-2').warnings).toContain('early');
  });
  it('flags a dose given after the maximum age', () => {
    const rows = sched({
      items: UIP_SCHEDULE,
      today: plus(DOB, 400),
      given: [give('BCG-1', plus(DOB, 380))],
    });
    expect(row(rows, 'BCG-1').status).toBe('given');
    expect(row(rows, 'BCG-1').warnings).toContain('after_max_age');
  });
});

describe('next due and reminders', () => {
  it('next due is the earliest compulsory outstanding dose', () => {
    const rows = sched({
      today: DOB,
      given: [give('BCG-1', DOB), give('OPV-1', DOB), give('HEPB-1', DOB)],
    });
    expect(nextDueDate(rows)).toBe('2026-02-21');
  });
  it('is null when everything is given or closed', () => {
    const all = IAP_SCHEDULE.map((i) => give(scheduleItemCode(i), DOB, scheduleItemCode(i)));
    expect(nextDueDate(sched({ today: '2040-01-01', given: all }))).toBeNull();
  });
  it('an optional dose does not set the next due date', () => {
    const items = IAP_SCHEDULE.filter((i) => i.isOptional);
    expect(items.length).toBeGreaterThan(0);
    expect(nextDueDate(sched({ items, today: DOB }))).toBeNull();
  });
  it('lists the doses of a day together', () => {
    const rows = sched({ today: DOB });
    const codes = dosesDueOn(rows, '2026-02-21').map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(['DTP-1', 'IPV-1', 'HIB-1', 'HEPB-2', 'ROTA-1', 'PCV-1']),
    );
    expect(codes).not.toContain('DTP-2');
  });
  it('reminds exactly two days before, never earlier or later', () => {
    const rows = sched({ today: DOB });
    expect(reminderDoses(rows, '2026-02-19').length).toBeGreaterThan(0);
    expect(reminderDoses(rows, '2026-02-18')).toEqual([]);
    expect(reminderDoses(rows, '2026-02-20')).toEqual([]);
    expect(reminderDoses(rows, '2026-02-18', 3).length).toBeGreaterThan(0);
  });
  it('after a late dose the reminder follows the catch-up date', () => {
    const rows = sched({ today: '2026-03-11', given: [give('DTP-1', '2026-03-11')] });
    expect(reminderDoses(rows, '2026-04-06').map((r) => r.code)).toContain('DTP-2');
    expect(reminderDoses(rows, '2026-03-19').map((r) => r.code)).not.toContain('DTP-2');
  });
  it('orders compulsory doses before optional ones', () => {
    const list = outstandingDoses(sched({ today: DOB }));
    const firstOptional = list.findIndex((r) => r.item.isOptional);
    expect(list.slice(firstOptional).every((r) => r.item.isOptional)).toBe(true);
  });
  it('finds the first outstanding dose of a series', () => {
    const rows = sched({ today: '2026-03-01', given: [give('DTP-1', '2026-02-21')] });
    expect(firstOutstandingOfSeries(rows, 'DTP')?.code).toBe('DTP-2');
    expect(firstOutstandingOfSeries(rows, 'NOPE')).toBeNull();
  });
});

describe('checkDoseTiming', () => {
  const rows = sched({ today: '2026-03-01', given: [give('BCG-1', DOB)] });
  const base = { dob: DOB, today: '2026-03-01', rows };
  it('blocks a date before birth or in the future', () => {
    expect(
      checkDoseTiming({ ...base, givenOn: '2026-01-09', itemCode: 'DTP-1' }).blocking,
    ).toContain('before_birth');
    expect(
      checkDoseTiming({ ...base, givenOn: '2026-03-02', itemCode: 'DTP-1' }).blocking,
    ).toContain('future_date');
  });
  it('blocks a dose already recorded and a code outside the schedule', () => {
    expect(
      checkDoseTiming({ ...base, givenOn: '2026-03-01', itemCode: 'BCG-1' }).blocking,
    ).toContain('already_given');
    expect(
      checkDoseTiming({ ...base, givenOn: '2026-03-01', itemCode: 'ZZZ-1' }).blocking,
    ).toContain('not_in_schedule');
  });
  it('warns, without blocking, when too early or the previous dose is missing', () => {
    const r = checkDoseTiming({ ...base, givenOn: '2026-01-20', itemCode: 'DTP-2' });
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual(expect.arrayContaining(['too_early', 'previous_dose_missing']));
  });
  it('is clean on the due date', () => {
    const r = checkDoseTiming({ ...base, givenOn: '2026-02-21', itemCode: 'DTP-1' });
    expect(r).toEqual({ blocking: [], warnings: [] });
  });
  it('a vaccine outside the schedule needs no timing check beyond the dates', () => {
    expect(checkDoseTiming({ ...base, givenOn: '2026-03-01', itemCode: null })).toEqual({
      blocking: [],
      warnings: [],
    });
  });
  it('warns after the maximum age', () => {
    const uipRows = sched({ items: UIP_SCHEDULE, today: plus(DOB, 400) });
    const r = checkDoseTiming({
      dob: DOB,
      today: plus(DOB, 400),
      givenOn: plus(DOB, 380),
      rows: uipRows,
      itemCode: 'BCG-1',
    });
    expect(r.warnings).toContain('after_max_age');
  });
});

describe('robustness', () => {
  it('never throws and always returns one row per item, for every day of 3 years × 2 schedules', () => {
    for (const items of [IAP_SCHEDULE, UIP_SCHEDULE]) {
      for (const dob of ['2024-02-29', '2025-12-31', '2026-01-31']) {
        for (let d = 0; d <= 1100; d += 11) {
          const rows = sched({ dob, items, today: plus(dob, d) });
          expect(rows).toHaveLength(items.length);
          for (const r of rows) {
            if (r.status === 'not_applicable') expect(r.dueDate).toBeNull();
            else expect(r.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          }
        }
      }
    }
  });
  it('statuses follow the dates for any child (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6000 }), fc.integer({ min: 0, max: 20 }), (age, k) => {
        const rows = sched({
          today: plus(DOB, age),
          given: IAP_SCHEDULE.slice(0, k).map((i) =>
            give(scheduleItemCode(i), plus(DOB, Math.min(age, i.dueAgeDays))),
          ),
        });
        for (const r of rows) {
          if (r.status === 'upcoming') expect(r.dueDate! > plus(DOB, age)).toBe(true);
          if (r.status === 'due' || r.status === 'overdue')
            expect(r.dueDate! <= plus(DOB, age)).toBe(true);
        }
      }),
    );
  });
});

describe('recordDoseSchema', () => {
  const ok = {
    idempotencyKey: '0190a7a0-0000-7000-8000-000000000001',
    patientId: '0190a7a0-0000-7000-8000-000000000002',
    itemCode: 'DTP-1',
    vaccineName: 'DTP-1',
    batchNo: 'AB123',
    expiry: '2027-01-31',
    site: 'left_thigh',
    route: 'im',
    givenOn: '2026-02-21',
  };
  it('accepts a complete record', () => {
    expect(recordDoseSchema.safeParse(ok).success).toBe(true);
  });
  it('needs a batch, a valid expiry and a known site', () => {
    expect(recordDoseSchema.safeParse({ ...ok, batchNo: ' ' }).success).toBe(false);
    expect(recordDoseSchema.safeParse({ ...ok, expiry: '2027-02-30' }).success).toBe(false);
    expect(recordDoseSchema.safeParse({ ...ok, site: 'ear' }).success).toBe(false);
    expect(recordDoseSchema.safeParse({ ...ok, itemCode: 'dtp1' }).success).toBe(false);
  });
});

describe('reminderSendAt', () => {
  // 10:00 IST = 04:30 UTC.
  const at = (iso: string) => new Date(iso);
  it('is 10:00 IST two days before the due date', () => {
    const r = reminderSendAt('2026-02-21', 2, at('2026-02-10T06:00:00Z'))!;
    expect(r.toISOString()).toBe('2026-02-19T04:30:00.000Z');
  });
  it('honours another lead time', () => {
    expect(reminderSendAt('2026-02-21', 5, at('2026-02-10T06:00:00Z'))!.toISOString()).toBe(
      '2026-02-16T04:30:00.000Z',
    );
  });
  it('goes now when the time has passed in daytime and the due date is still ahead', () => {
    const now = at('2026-02-19T08:00:00Z'); // 13:30 IST
    expect(reminderSendAt('2026-02-21', 2, now)!.toISOString()).toBe(now.toISOString());
  });
  it('waits for 8 am in quiet hours', () => {
    // 22:00 IST on the 19th -> 08:00 IST on the 20th, still before the 21st.
    expect(reminderSendAt('2026-02-21', 2, at('2026-02-19T16:30:00Z'))!.toISOString()).toBe(
      '2026-02-20T02:30:00.000Z',
    );
    // 05:00 IST on the 20th -> 08:00 IST the same day.
    expect(reminderSendAt('2026-02-21', 2, at('2026-02-19T23:30:00Z'))!.toISOString()).toBe(
      '2026-02-20T02:30:00.000Z',
    );
  });
  it('is null when it would only go out on the due date, or the dose is due today or past', () => {
    expect(reminderSendAt('2026-02-21', 2, at('2026-02-20T16:30:00Z'))).toBeNull(); // 22:00 IST, 20th
    expect(reminderSendAt('2026-02-21', 2, at('2026-02-21T03:00:00Z'))).toBeNull();
    expect(reminderSendAt('2026-02-21', 2, at('2026-03-01T03:00:00Z'))).toBeNull();
  });
  it('uses the IST day, not the UTC day', () => {
    // 23:00 UTC on the 20th is 04:30 IST on the 21st: the due date is today.
    expect(reminderSendAt('2026-02-21', 2, at('2026-02-20T23:00:00Z'))).toBeNull();
  });
});
