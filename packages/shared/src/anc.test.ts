import { describe, expect, it } from 'vitest';
import { addDays, parseIsoDate, toIsoDate } from './dates';
import {
  assessRedating,
  checkLmp,
  computeGpal,
  createPregnancySchema,
  DEFAULT_ANC_SCHEDULE,
  DEFAULT_REDATING_TABLE,
  DEFAULT_RISK_RULES,
  DEFAULT_VISIT_INTERVALS,
  eddFromLmp,
  eddFromScan,
  evaluateRisks,
  formatGa,
  formatGpal,
  gaDaysFromLmp,
  gaDaysOnDate,
  gaInputSchema,
  gaToDays,
  gpalConsistent,
  isRhNegative,
  lmpFromEdd,
  nextVisit,
  redatingTableSchema,
  redatingThreshold,
  scheduleStates,
  splitGa,
  trimesterOf,
  visitIntervalDays,
  visitIntervalsSchema,
  type AncItemState,
  type RiskInput,
  type ScheduleMark,
} from './anc';

const plusDays = (d: string, n: number) => toIsoDate(addDays(parseIsoDate(d), n));

describe('EDD from LMP (Naegele: LMP + 280 days)', () => {
  it.each([
    ['2026-01-01', '2026-10-08'],
    ['2025-01-31', '2025-11-07'], // LMP at a month end
    ['2026-12-31', '2027-10-07'], // year end
    ['2024-02-29', '2024-12-05'], // LMP on a leap day
    ['2023-05-31', '2024-03-06'], // the 280 days cross a leap day
    ['2024-03-01', '2024-12-06'], // the day after a leap day
    ['2025-02-28', '2025-12-05'], // last day of a non-leap February
    ['2024-01-31', '2024-11-06'], // leap year, month end
    ['2000-02-29', '2000-12-05'], // century leap year
    ['2100-03-01', '2100-12-06'], // 2100 is not a leap year
  ])('%s → %s', (lmp, edd) => {
    expect(eddFromLmp(lmp)).toBe(edd);
  });

  it('is exactly 280 days after the LMP for every day of a leap year and its neighbours', () => {
    let d = parseIsoDate('2023-12-01');
    for (let i = 0; i < 800; i++) {
      const lmp = toIsoDate(d);
      expect(gaDaysFromLmp(lmp, eddFromLmp(lmp))).toBe(280);
      d = addDays(d, 1);
    }
  });

  it('round-trips with lmpFromEdd', () => {
    for (const lmp of ['2024-02-29', '2025-01-31', '2026-12-31', '2023-05-31']) {
      expect(lmpFromEdd(eddFromLmp(lmp))).toBe(lmp);
    }
  });
});

describe('gestational age', () => {
  it('splits days into weeks and days and formats as 24w 3d', () => {
    expect(splitGa(0)).toEqual({ weeks: 0, days: 0 });
    expect(splitGa(6)).toEqual({ weeks: 0, days: 6 });
    expect(splitGa(7)).toEqual({ weeks: 1, days: 0 });
    expect(splitGa(171)).toEqual({ weeks: 24, days: 3 });
    expect(formatGa(171)).toBe('24w 3d');
    expect(formatGa(280)).toBe('40w 0d');
    expect(splitGa(-3)).toEqual({ weeks: 0, days: 0 });
  });

  it('counts GA from the LMP on the day, the day before and the day after a leap day', () => {
    expect(gaDaysFromLmp('2024-02-01', '2024-02-29')).toBe(28);
    expect(gaDaysFromLmp('2024-02-01', '2024-03-01')).toBe(29);
    expect(gaDaysFromLmp('2023-02-01', '2023-03-01')).toBe(28);
    expect(gaDaysFromLmp('2024-02-29', '2024-02-29')).toBe(0);
    expect(gaDaysFromLmp('2024-02-29', '2025-02-28')).toBe(365);
  });

  it('GA from the final EDD equals GA from the LMP when the EDD is the LMP one', () => {
    const lmp = '2025-01-31';
    const edd = eddFromLmp(lmp);
    for (const on of ['2025-01-31', '2025-02-28', '2025-06-15', '2025-11-07', '2025-11-20']) {
      expect(gaDaysOnDate(edd, on)).toBe(gaDaysFromLmp(lmp, on));
    }
    expect(gaDaysOnDate(edd, edd)).toBe(280);
  });

  it('is 40w 0d on the EDD and 41w 0d a week later', () => {
    const edd = '2026-10-08';
    expect(formatGa(gaDaysOnDate(edd, '2026-10-08'))).toBe('40w 0d');
    expect(formatGa(gaDaysOnDate(edd, '2026-10-15'))).toBe('41w 0d');
    expect(formatGa(gaDaysOnDate(edd, '2026-10-07'))).toBe('39w 6d');
  });

  it('picks the trimester at 14w0d and 28w0d', () => {
    expect(trimesterOf(0)).toBe(1);
    expect(trimesterOf(gaToDays(13, 6))).toBe(1);
    expect(trimesterOf(gaToDays(14, 0))).toBe(2);
    expect(trimesterOf(gaToDays(27, 6))).toBe(2);
    expect(trimesterOf(gaToDays(28, 0))).toBe(3);
  });

  it('rejects an LMP in the future, older than 44 weeks or not a date', () => {
    expect(checkLmp('2026-10-26', '2026-10-26')).toEqual({ ok: true });
    expect(checkLmp('2026-10-27', '2026-10-26')).toEqual({ ok: false, error: 'anc.lmpFuture' });
    expect(checkLmp('2025-12-22', '2026-10-26')).toEqual({ ok: true }); // 308 days
    expect(checkLmp('2025-12-21', '2026-10-26')).toEqual({ ok: false, error: 'anc.lmpTooOld' });
    expect(checkLmp('2026-02-30', '2026-10-26')).toEqual({ ok: false, error: 'anc.dateInvalid' });
  });
});

describe('EDD from a scan', () => {
  it('is the scan date plus the days still to go', () => {
    expect(eddFromScan('2026-03-01', gaToDays(8, 0))).toBe('2026-10-11');
    expect(eddFromScan('2026-03-01', gaToDays(40, 0))).toBe('2026-03-01');
    expect(eddFromScan('2024-02-29', gaToDays(12, 3))).toBe(plusDays('2024-02-29', 280 - 87));
  });

  it('agrees with the LMP EDD when the scan GA equals the LMP GA', () => {
    const lmp = '2026-01-01';
    const scan = '2026-03-26'; // 84 days = 12w0d
    expect(eddFromScan(scan, 84)).toBe(eddFromLmp(lmp));
  });
});

describe('scan re-dating thresholds (docs/11 §3.1)', () => {
  it('picks the row by the GA found at the scan', () => {
    const t = (ga: number) => redatingThreshold(ga);
    expect(t(gaToDays(5, 0))).toBe(5);
    expect(t(gaToDays(8, 6))).toBe(5);
    expect(t(gaToDays(9, 0))).toBe(7);
    expect(t(gaToDays(13, 6))).toBe(7);
    expect(t(gaToDays(14, 0))).toBe(7);
    expect(t(gaToDays(15, 6))).toBe(7);
    expect(t(gaToDays(16, 0))).toBe(10);
    expect(t(gaToDays(21, 6))).toBe(10);
    expect(t(gaToDays(22, 0))).toBe(14);
    expect(t(gaToDays(27, 6))).toBe(14);
    expect(t(gaToDays(28, 0))).toBe(21);
    expect(t(gaToDays(40, 0))).toBe(21);
  });

  // GA at the scan, then the threshold that must apply.
  const bands: [string, number, number][] = [
    ['5w0d', gaToDays(5, 0), 5],
    ['8w6d', gaToDays(8, 6), 5],
    ['9w0d', gaToDays(9, 0), 7],
    ['13w6d', gaToDays(13, 6), 7],
    ['14w0d', gaToDays(14, 0), 7],
    ['15w6d', gaToDays(15, 6), 7],
    ['16w0d', gaToDays(16, 0), 10],
    ['21w6d', gaToDays(21, 6), 10],
    ['22w0d', gaToDays(22, 0), 14],
    ['27w6d', gaToDays(27, 6), 14],
    ['28w0d', gaToDays(28, 0), 21],
    ['38w0d', gaToDays(38, 0), 21],
  ];

  describe.each(bands)('scan at %s', (_label, gaScan, threshold) => {
    const lmp = '2026-01-01';
    // difference = GA by LMP on the scan date - GA by scan
    const assess = (diff: number) =>
      assessRedating({ lmp, scanDate: plusDays(lmp, gaScan + diff), gaAtScanDays: gaScan });

    it(`keeps the LMP when the EDDs differ by exactly ${threshold} days, either way`, () => {
      expect(assess(threshold).suggestScan).toBe(false);
      expect(assess(-threshold).suggestScan).toBe(false);
      expect(assess(0).suggestScan).toBe(false);
    });

    it(`suggests the scan once they differ by ${threshold + 1} days, either way`, () => {
      const later = assess(threshold + 1);
      const earlier = assess(-(threshold + 1));
      expect(later.suggestScan).toBe(true);
      expect(earlier.suggestScan).toBe(true);
      expect(later.thresholdDays).toBe(threshold);
      // Positive = the scan puts the delivery later than the LMP does (GA by LMP is the larger).
      expect(later.differenceDays).toBe(threshold + 1);
      expect(earlier.differenceDays).toBe(-(threshold + 1));
    });
  });

  it('reports both EDDs and the LMP GA on the scan day', () => {
    const a = assessRedating({
      lmp: '2026-01-01',
      scanDate: '2026-03-01',
      gaAtScanDays: gaToDays(8, 0),
    });
    expect(a.eddByLmp).toBe('2026-10-08');
    expect(a.eddByScan).toBe('2026-10-11');
    expect(a.gaByLmpAtScan).toBe(59);
    expect(a.differenceDays).toBe(3);
    expect(a.suggestScan).toBe(false);
  });

  it('works across a leap day', () => {
    // LMP 2024-01-20; scan on 2024-03-05 reports 6w0d (42); LMP GA that day is 45 → diff +3.
    const a = assessRedating({ lmp: '2024-01-20', scanDate: '2024-03-05', gaAtScanDays: 42 });
    expect(a.gaByLmpAtScan).toBe(45);
    expect(a.differenceDays).toBe(3);
    expect(a.suggestScan).toBe(false);
    const b = assessRedating({ lmp: '2024-01-20', scanDate: '2024-03-05', gaAtScanDays: 38 });
    expect(b.suggestScan).toBe(true);
  });

  it('uses a configured table', () => {
    const table = [
      { fromDays: 0, thresholdDays: 3 },
      { fromDays: 70, thresholdDays: 9 },
    ];
    expect(redatingThreshold(69, table)).toBe(3);
    expect(redatingThreshold(70, table)).toBe(9);
    const a = assessRedating({
      lmp: '2026-01-01',
      scanDate: plusDays('2026-01-01', 60 + 4),
      gaAtScanDays: 60,
      table,
    });
    expect(a.suggestScan).toBe(true);
  });

  it('validates a table: starts at 0 and strictly ascending', () => {
    expect(redatingTableSchema.safeParse(DEFAULT_REDATING_TABLE).success).toBe(true);
    expect(redatingTableSchema.safeParse([{ fromDays: 7, thresholdDays: 5 }]).success).toBe(false);
    expect(
      redatingTableSchema.safeParse([
        { fromDays: 0, thresholdDays: 5 },
        { fromDays: 0, thresholdDays: 7 },
      ]).success,
    ).toBe(false);
    expect(redatingTableSchema.safeParse([]).success).toBe(false);
  });

  it('accepts a GA of 5w0d to 42w0d from the form and nothing else', () => {
    expect(gaInputSchema.parse({ weeks: 8, days: 3 })).toBe(59);
    expect(gaInputSchema.safeParse({ weeks: 4, days: 6 }).success).toBe(false);
    expect(gaInputSchema.safeParse({ weeks: 5, days: 0 }).success).toBe(true);
    expect(gaInputSchema.safeParse({ weeks: 42, days: 0 }).success).toBe(true);
    expect(gaInputSchema.safeParse({ weeks: 42, days: 1 }).success).toBe(false);
    expect(gaInputSchema.safeParse({ weeks: 10, days: 7 }).success).toBe(false);
  });
});

describe('GPAL', () => {
  it('first pregnancy is G1 P0 A0 L0', () => {
    expect(computeGpal([])).toEqual({ g: 1, p: 0, a: 0, l: 0 });
    expect(formatGpal(computeGpal([]))).toBe('G1 P0 A0 L0');
  });

  it('counts births, abortions and living children from the history plus the current pregnancy', () => {
    const g = computeGpal([
      { outcome: 'nvd', gestationWeeks: 39, babiesAlive: 1 },
      { outcome: 'lscs', gestationWeeks: 38, babiesAlive: 1 },
      { outcome: 'abortion', gestationWeeks: 8, babiesAlive: 0 },
    ]);
    expect(g).toEqual({ g: 4, p: 2, a: 1, l: 2 });
    expect(formatGpal(g)).toBe('G4 P2 A1 L2');
  });

  it('a stillbirth is a birth with no living child; ectopic is an abortion', () => {
    expect(
      computeGpal([
        { outcome: 'stillbirth', gestationWeeks: 34, babiesAlive: 0 },
        { outcome: 'ectopic', gestationWeeks: 7, babiesAlive: 0 },
      ]),
    ).toEqual({ g: 3, p: 1, a: 1, l: 0 });
  });

  it('twins count as one pregnancy and two living children', () => {
    expect(computeGpal([{ outcome: 'lscs', gestationWeeks: 36, babiesAlive: 2 }])).toEqual({
      g: 2,
      p: 1,
      a: 0,
      l: 2,
    });
  });

  it('a delivery with no gestation recorded is a birth; a short gestation is an abortion', () => {
    expect(computeGpal([{ outcome: 'nvd', gestationWeeks: null, babiesAlive: 1 }]).p).toBe(1);
    expect(computeGpal([{ outcome: 'nvd', gestationWeeks: 20, babiesAlive: 0 }])).toMatchObject({
      p: 0,
      a: 1,
    });
  });

  it('follows the configured viability week', () => {
    const h = [{ outcome: 'nvd', gestationWeeks: 24, babiesAlive: 0 }] as const;
    expect(computeGpal(h, 28)).toMatchObject({ p: 0, a: 1 });
    expect(computeGpal(h, 22)).toMatchObject({ p: 1, a: 0 });
  });

  it('checks a hand-edited score adds up', () => {
    expect(gpalConsistent({ g: 3, p: 1, a: 1, l: 1 })).toBe(true);
    expect(gpalConsistent({ g: 3, p: 2, a: 1, l: 1 })).toBe(false);
    expect(gpalConsistent({ g: 1, p: 0, a: 0, l: 0 })).toBe(true);
    expect(gpalConsistent({ g: 0, p: 0, a: 0, l: 0 })).toBe(false);
  });
});

describe('risk flags (docs/11 §3.2 defaults)', () => {
  const base: RiskInput = {
    ageYears: 26,
    heightCm: 158,
    bookingBmi: 24,
    bps: [{ sys: 118, dia: 76 }],
    hbs: [12.1],
    gpal: { g: 2, p: 1, a: 0, l: 1 },
    history: [{ outcome: 'nvd', neonatalDeath: false }],
    bloodGroupRh: 'B+',
    plurality: 'single',
    gaDays: 150,
    manual: [],
  };
  const codes = (o: Partial<RiskInput>, rules = DEFAULT_RISK_RULES) =>
    evaluateRisks({ ...base, ...o }, rules).map((f) => f.code);

  it('raises nothing for a low-risk woman', () => {
    expect(codes({})).toEqual([]);
  });

  it('age: below 18 and above 35 only', () => {
    expect(codes({ ageYears: 17 })).toEqual(['age_young']);
    expect(codes({ ageYears: 18 })).toEqual([]);
    expect(codes({ ageYears: 35 })).toEqual([]);
    expect(codes({ ageYears: 36 })).toEqual(['age_elderly']);
    expect(codes({ ageYears: null })).toEqual([]);
  });

  it('height below 145 cm and booking BMI of 30 or more', () => {
    expect(codes({ heightCm: 144.9 })).toEqual(['short_stature']);
    expect(codes({ heightCm: 145 })).toEqual([]);
    expect(codes({ bookingBmi: 29.9 })).toEqual([]);
    expect(codes({ bookingBmi: 30 })).toEqual(['obese_at_booking']);
  });

  it('BP at any visit: 140 or 90 is raised, 160 or 110 is severe', () => {
    expect(codes({ bps: [{ sys: 139, dia: 89 }] })).toEqual([]);
    expect(codes({ bps: [{ sys: 140, dia: 80 }] })).toEqual(['raised_bp']);
    expect(codes({ bps: [{ sys: 120, dia: 90 }] })).toEqual(['raised_bp']);
    expect(codes({ bps: [{ sys: 160, dia: 80 }] })).toEqual(['severe_raised_bp']);
    expect(codes({ bps: [{ sys: 130, dia: 110 }] })).toEqual(['severe_raised_bp']);
    // An earlier raised visit still counts after a normal one, and the worst reading is shown.
    const f = evaluateRisks({
      ...base,
      bps: [
        { sys: 150, dia: 95 },
        { sys: 118, dia: 76 },
        { sys: 162, dia: 100 },
      ],
    });
    expect(f).toEqual([{ code: 'severe_raised_bp', level: 'alert', source: 'auto', value: '162/100' }]);
    // A blank diastolic is not read as a normal one.
    expect(codes({ bps: [{ sys: 150, dia: null }] })).toEqual(['raised_bp']);
  });

  it('Hb below 11 is anaemia, below 7 severe; the lowest visit counts', () => {
    expect(codes({ hbs: [11] })).toEqual([]);
    expect(codes({ hbs: [10.9] })).toEqual(['anaemia']);
    expect(codes({ hbs: [7] })).toEqual(['anaemia']);
    expect(codes({ hbs: [6.9] })).toEqual(['severe_anaemia']);
    expect(codes({ hbs: [12, 9.5, null, 11.2] })).toEqual(['anaemia']);
    expect(codes({ hbs: [null] })).toEqual([]);
  });

  it('history: previous LSCS, stillbirth or neonatal death, two abortions, para 4', () => {
    expect(codes({ history: [{ outcome: 'lscs', neonatalDeath: false }] })).toEqual(['previous_lscs']);
    expect(codes({ history: [{ outcome: 'stillbirth', neonatalDeath: false }] })).toEqual([
      'previous_stillbirth_or_neonatal_death',
    ]);
    expect(codes({ history: [{ outcome: 'nvd', neonatalDeath: true }] })).toEqual([
      'previous_stillbirth_or_neonatal_death',
    ]);
    expect(codes({ gpal: { g: 3, p: 0, a: 1, l: 0 } })).toEqual([]);
    expect(codes({ gpal: { g: 4, p: 0, a: 2, l: 0 } })).toEqual(['recurrent_abortions']);
    expect(codes({ gpal: { g: 4, p: 3, a: 0, l: 3 } })).toEqual([]);
    expect(codes({ gpal: { g: 5, p: 4, a: 0, l: 4 } })).toEqual(['grand_multipara']);
  });

  it('Rh negative, multiple pregnancy and post-dates', () => {
    expect(codes({ bloodGroupRh: 'O-' })).toEqual(['rh_negative']);
    expect(codes({ bloodGroupRh: 'AB+' })).toEqual([]);
    expect(codes({ bloodGroupRh: null })).toEqual([]);
    expect(codes({ plurality: 'twins' })).toEqual(['multiple_pregnancy']);
    expect(codes({ plurality: 'higher' })).toEqual(['multiple_pregnancy']);
    expect(codes({ gaDays: 280 })).toEqual([]);
    expect(codes({ gaDays: 281 })).toEqual(['post_dates']);
  });

  it('keeps manual flags, with the text of "other", after the auto ones', () => {
    const f = evaluateRisks({
      ...base,
      ageYears: 40,
      manual: [{ code: 'gdm' }, { code: 'other', text: 'Epilepsy on treatment' }],
    });
    expect(f.map((x) => `${x.source}:${x.code}`)).toEqual(['auto:age_elderly', 'manual:gdm', 'manual:other']);
    expect(f[2]!.text).toBe('Epilepsy on treatment');
  });

  it('follows configured thresholds', () => {
    expect(codes({ ageYears: 30 }, { ...DEFAULT_RISK_RULES, ageAbove: 29 })).toEqual(['age_elderly']);
    expect(codes({ hbs: [11.5] }, { ...DEFAULT_RISK_RULES, hbBelow: 12 })).toEqual(['anaemia']);
  });

  it('reads Rh from common spellings', () => {
    expect(isRhNegative('A-')).toBe(true);
    expect(isRhNegative('AB neg')).toBe(true);
    expect(isRhNegative('O negative')).toBe(true);
    expect(isRhNegative('A+')).toBe(false);
    expect(isRhNegative('')).toBe(false);
  });
});

describe('ANC schedule', () => {
  const lmp = '2026-01-01';
  const edd = eddFromLmp(lmp); // 2026-10-08
  const ctx = (today: string, o: { rhNegative?: boolean; bookingDate?: string } = {}) => ({
    gaDays: gaDaysFromLmp(lmp, today),
    today,
    bookingDate: o.bookingDate ?? '2026-04-01',
    rhNegative: o.rhNegative ?? false,
  });
  const state = (code: string, today: string, marks: [string, ScheduleMark][] = [], o = {}) =>
    scheduleStates(DEFAULT_ANC_SCHEDULE, new Map(marks), ctx(today, o), edd).find(
      (v) => v.def.code === code,
    )!.state as AncItemState;

  it('has the items of docs/33 §4 in order with unique codes', () => {
    const codes = DEFAULT_ANC_SCHEDULE.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(expect.arrayContaining(['dating_scan', 'nt_scan', 'anomaly_scan', 'td_1', 'td_2']));
    const orders = DEFAULT_ANC_SCHEDULE.map((d) => d.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('a windowed item is upcoming, due, then overdue (window edges inclusive)', () => {
    // anomaly scan 18w0d (2026-05-07) to 22w0d (2026-06-04)
    expect(state('anomaly_scan', '2026-05-06')).toBe('upcoming');
    expect(state('anomaly_scan', '2026-05-07')).toBe('due');
    expect(state('anomaly_scan', '2026-06-04')).toBe('due');
    expect(state('anomaly_scan', '2026-06-05')).toBe('overdue');
  });

  it('done and skipped marks win over the window', () => {
    const done: [string, ScheduleMark][] = [['anomaly_scan', { status: 'done', doneDate: '2026-05-20' }]];
    expect(state('anomaly_scan', '2026-08-01', done)).toBe('done');
    const skipped: [string, ScheduleMark][] = [['nt_scan', { status: 'skipped', doneDate: null }]];
    expect(state('nt_scan', '2026-08-01', skipped)).toBe('skipped');
    expect(state('anomaly_scan', '2026-05-01', done)).toBe('done'); // done early is still done
  });

  it('booking items are due from the booking date and overdue after the grace days', () => {
    expect(state('cbc_hb', '2026-04-01')).toBe('due');
    expect(state('cbc_hb', '2026-04-15')).toBe('due');
    expect(state('cbc_hb', '2026-04-16')).toBe('overdue');
    expect(state('cbc_hb', '2026-03-31')).toBe('upcoming');
  });

  it('anti-D / Coombs applies to Rh-negative women only', () => {
    expect(state('coombs_anti_d', '2026-07-20')).toBe('not_applicable');
    expect(state('coombs_anti_d', '2026-07-20', [], { rhNegative: true })).toBe('due');
    expect(state('coombs_anti_d', '2026-07-01', [], { rhNegative: true })).toBe('upcoming');
  });

  it('Td-2 waits for Td-1 and is due four weeks after it was given', () => {
    expect(state('td_2', '2026-06-01')).toBe('upcoming');
    const td1: [string, ScheduleMark][] = [['td_1', { status: 'done', doneDate: '2026-04-01' }]];
    expect(state('td_2', '2026-04-28', td1)).toBe('upcoming');
    expect(state('td_2', '2026-04-29', td1)).toBe('due');
    expect(state('td_2', '2026-05-13', td1)).toBe('due');
    expect(state('td_2', '2026-05-14', td1)).toBe('overdue');
  });

  it('supplements are due from 14 weeks and never overdue', () => {
    expect(state('iron_folic', '2026-04-08')).toBe('upcoming'); // 13w6d
    expect(state('iron_folic', '2026-04-09')).toBe('due'); // 14w0d
    expect(state('iron_folic', '2026-09-30')).toBe('due');
  });
});

describe('next visit suggestion (docs/11 §3.4)', () => {
  it('uses 4, 2 and 1 week intervals by GA', () => {
    expect(visitIntervalDays(gaToDays(12, 0))).toBe(28);
    expect(visitIntervalDays(gaToDays(28, 0))).toBe(28);
    expect(visitIntervalDays(gaToDays(28, 1))).toBe(14);
    expect(visitIntervalDays(gaToDays(36, 0))).toBe(14);
    expect(visitIntervalDays(gaToDays(36, 1))).toBe(7);
    expect(visitIntervalDays(gaToDays(41, 0))).toBe(7);
  });

  it('adds the interval of the last visit’s GA to its date', () => {
    const edd = eddFromLmp('2026-01-01');
    const n = nextVisit({
      lastVisitDate: '2026-04-10',
      gaAtLastVisit: gaDaysFromLmp('2026-01-01', '2026-04-10'),
      edd,
      today: '2026-04-20',
    });
    expect(n.intervalDays).toBe(28);
    expect(n.date).toBe('2026-05-08');
    expect(n.overdue).toBe(false);
    expect(n.gaAtDate).toBe(gaDaysFromLmp('2026-01-01', '2026-05-08'));
  });

  it('is overdue only after the suggested day', () => {
    const edd = eddFromLmp('2026-01-01');
    const args = { lastVisitDate: '2026-08-01', gaAtLastVisit: 212, edd };
    expect(nextVisit({ ...args, today: '2026-08-15' }).overdue).toBe(false);
    expect(nextVisit({ ...args, today: '2026-08-16' }).overdue).toBe(true);
  });

  it('follows a configured interval table', () => {
    const t = [
      { uptoDays: 100, everyDays: 10 },
      { uptoDays: null, everyDays: 5 },
    ];
    expect(visitIntervalsSchema.safeParse(t).success).toBe(true);
    expect(visitIntervalDays(100, t)).toBe(10);
    expect(visitIntervalDays(101, t)).toBe(5);
    expect(visitIntervalsSchema.safeParse(DEFAULT_VISIT_INTERVALS).success).toBe(true);
    expect(visitIntervalsSchema.safeParse([{ uptoDays: 100, everyDays: 10 }]).success).toBe(false);
  });
});

describe('create pregnancy input', () => {
  const base = { patientId: '0199d5c4-0000-7000-8000-000000000001', idempotencyKey: '0199d5c4-0000-7000-8000-000000000002' };

  it('needs the LMP or a scan', () => {
    expect(createPregnancySchema.safeParse({ ...base, lmp: null }).success).toBe(false);
    expect(createPregnancySchema.safeParse({ ...base, lmp: '2026-05-01' }).success).toBe(true);
    expect(
      createPregnancySchema.safeParse({
        ...base,
        lmp: null,
        scan: { date: '2026-06-01', ga: { weeks: 9, days: 2 } },
      }).success,
    ).toBe(true);
  });

  it('rejects an impossible date', () => {
    expect(createPregnancySchema.safeParse({ ...base, lmp: '2026-02-30' }).success).toBe(false);
  });
});
