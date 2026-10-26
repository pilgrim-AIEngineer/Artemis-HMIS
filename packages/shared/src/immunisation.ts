import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import { addDays, daysBetween, parseIsoDate, toIsoDate } from './dates';
import { isoDateSchema, uuidSchema } from './primitives';

/**
 * Immunisation schedule calculator (OPD-06, docs/11 §4.1). Pure functions over `YYYY-MM-DD`
 * strings and whole days, so nothing depends on the machine's time zone. The software calculates
 * and reminds; it never decides what a child should be given. Every age, interval and cap below is
 * a DRAFT seed from docs/33 §5 that the hospital's paediatrician reviews in the masters screen
 * (setting `paeds.rulesSignedOff`); the built-in tables are used until `immunisation_schedule` is
 * seeded.
 *
 * Catch-up (docs/11 §4.1): a dose given late moves the next dose of the same series to
 * `given date + minimum interval` when that is later than its own recommended age. A dose not
 * given yet counts from `max(its due date, today)`, so the doses behind it show when they could
 * start if the missing one were given today.
 */

export const IMMUNISATION_SCHEDULES = ['IAP', 'UIP'] as const;
export type ImmunisationScheduleName = (typeof IMMUNISATION_SCHEDULES)[number];

/** `due` = from the due date until the grace days pass; `overdue` after that; `upcoming` before. */
export const IMMUNISATION_STATUSES = [
  'upcoming',
  'due',
  'overdue',
  'given',
  'not_applicable',
] as const;
export type ImmunisationStatus = (typeof IMMUNISATION_STATUSES)[number];

/** Why a dose is `not_applicable`. */
export type NotApplicableReason = 'age_exceeded' | 'series_closed' | 'sex';

export const VACCINE_SITES = [
  'left_thigh',
  'right_thigh',
  'left_arm',
  'right_arm',
  'oral',
  'intradermal_left_arm',
  'other',
] as const;
export type VaccineSite = (typeof VACCINE_SITES)[number];

export const VACCINE_ROUTES = ['im', 'sc', 'id', 'oral'] as const;
export type VaccineRoute = (typeof VACCINE_ROUTES)[number];

export const IMMUNISATION_GIVEN_STATUSES = ['given', 'cancelled'] as const;

/** One dose of the schedule master (`immunisation_schedule`, docs/04 §5). */
export interface ScheduleItem {
  scheduleName: ImmunisationScheduleName;
  /** The series: doses of one vaccine share it, ordered by `doseNo` (`DTP`, `HEPB`, …). */
  vaccineCode: string;
  doseNo: number;
  label: string;
  labelHi: string;
  /** Recommended age in days. */
  dueAgeDays: number;
  /** Earliest valid age in days. */
  minAgeDays: number;
  /** Last age (days) at which the dose can still be given; null = no limit. */
  maxAgeDays: number | null;
  /** Minimum days after the previous dose of the series; null = none. */
  minIntervalDays: number | null;
  isOptional: boolean;
  /** Only for this sex (`F`/`M`); null = everyone. */
  onlySex: 'F' | 'M' | null;
}

export const scheduleItemCode = (i: { vaccineCode: string; doseNo: number }): string =>
  `${i.vaccineCode}-${i.doseNo}`;

// ---------------------------------------------------------------- the draft schedules (docs/33 §5)

const WEEK = 7;
/** Months are counted as 30.4375 days and rounded: 6 m = 183, 9 m = 274, 12 m = 365. */
const month = (n: number) => Math.round(n * 30.4375);
const year = (n: number) => Math.round(n * 365.25);

interface DoseSpec {
  /** Suffix of the label (`1`, `0`, `booster 1`); the Hindi one is derived from it. */
  n: string;
  due: number;
  min?: number;
  max?: number | null;
  interval?: number | null;
  optional?: boolean;
  onlySex?: 'F' | 'M';
}

const HI_SUFFIX: Record<string, string> = { booster: 'बूस्टर' };
const hiSuffix = (s: string) => s.replace(/booster/g, HI_SUFFIX.booster!);

function series(
  scheduleName: ImmunisationScheduleName,
  vaccineCode: string,
  en: string,
  hi: string,
  doses: readonly DoseSpec[],
  defaultInterval: number | null = 28,
): ScheduleItem[] {
  return doses.map((d, idx) => ({
    scheduleName,
    vaccineCode,
    doseNo: idx + 1,
    label: d.n ? `${en}-${d.n}` : en,
    labelHi: d.n ? `${hi}-${hiSuffix(d.n)}` : hi,
    dueAgeDays: d.due,
    minAgeDays: d.min ?? d.due,
    maxAgeDays: d.max ?? null,
    minIntervalDays: idx === 0 ? null : d.interval === undefined ? defaultInterval : d.interval,
    isOptional: d.optional ?? false,
    onlySex: d.onlySex ?? null,
  }));
}

const SIX_MONTHS = 183;
const W6 = 6 * WEEK;
const W10 = 10 * WEEK;
const W14 = 14 * WEEK;

/** IAP (draft, docs/33 §5). */
export const IAP_SCHEDULE: readonly ScheduleItem[] = [
  ...series('IAP', 'BCG', 'BCG', 'बीसीजी', [{ n: '', due: 0 }]),
  ...series('IAP', 'OPV', 'OPV', 'ओपीवी', [{ n: '0', due: 0 }]),
  ...series('IAP', 'HEPB', 'Hep B', 'हेपेटाइटिस बी', [
    { n: '1', due: 0 },
    { n: '2', due: W6 },
    { n: '3', due: W10 },
    { n: '4', due: W14 },
  ]),
  ...series('IAP', 'DTP', 'DTP', 'डीटीपी', [
    { n: '1', due: W6 },
    { n: '2', due: W10 },
    { n: '3', due: W14 },
    { n: 'booster 1', due: month(16), interval: SIX_MONTHS },
    { n: 'booster 2', due: year(4), interval: SIX_MONTHS },
  ]),
  ...series('IAP', 'IPV', 'IPV', 'आईपीवी', [
    { n: '1', due: W6 },
    { n: '2', due: W10 },
    { n: '3', due: W14 },
    { n: 'booster', due: month(16), interval: SIX_MONTHS },
  ]),
  ...series('IAP', 'HIB', 'Hib', 'हिब', [
    { n: '1', due: W6 },
    { n: '2', due: W10 },
    { n: '3', due: W14 },
    { n: 'booster', due: month(16), interval: SIX_MONTHS },
  ]),
  ...series('IAP', 'ROTA', 'Rotavirus', 'रोटावायरस', [
    { n: '1', due: W6, max: 14 * WEEK + 6 },
    { n: '2', due: W10, max: month(8) },
    { n: '3', due: W14, max: month(8), optional: true },
  ]),
  ...series('IAP', 'PCV', 'PCV', 'पीसीवी', [
    { n: '1', due: W6 },
    { n: '2', due: W10 },
    { n: '3', due: W14 },
    { n: 'booster', due: month(12), interval: 8 * WEEK },
  ]),
  ...series('IAP', 'FLU', 'Influenza', 'इन्फ्लुएंजा', [
    { n: '1', due: month(6), optional: true },
    { n: '2', due: month(6) + 28, optional: true },
    { n: 'annual 1', due: month(18), optional: true, interval: 300 },
    { n: 'annual 2', due: month(30), optional: true, interval: 300 },
    { n: 'annual 3', due: month(42), optional: true, interval: 300 },
    { n: 'annual 4', due: month(54), optional: true, interval: 300 },
  ]),
  ...series('IAP', 'TCV', 'Typhoid conjugate', 'टाइफाइड कॉन्जुगेट', [{ n: '', due: month(6) }]),
  ...series('IAP', 'MMR', 'MMR', 'एमएमआर', [
    { n: '1', due: month(9) },
    { n: '2', due: month(15) },
    { n: '3', due: year(4) },
  ]),
  ...series('IAP', 'HEPA', 'Hep A', 'हेपेटाइटिस ए', [
    { n: '1', due: month(12) },
    { n: '2', due: month(18), interval: SIX_MONTHS, optional: true },
  ]),
  ...series('IAP', 'VAR', 'Varicella', 'वैरीसेला', [
    { n: '1', due: month(15) },
    { n: '2', due: month(18), interval: 84 },
  ]),
  ...series('IAP', 'HPV', 'HPV', 'एचपीवी', [
    { n: '1', due: year(9), onlySex: 'F' },
    { n: '2', due: year(9) + SIX_MONTHS, interval: 150, onlySex: 'F' },
  ]),
  ...series('IAP', 'TDAP', 'Tdap', 'टीडैप', [{ n: '', due: year(10) }]),
];

/** UIP (draft, docs/33 §5). */
export const UIP_SCHEDULE: readonly ScheduleItem[] = [
  ...series('UIP', 'BCG', 'BCG', 'बीसीजी', [{ n: '', due: 0, max: 364 }]),
  ...series('UIP', 'OPV', 'OPV', 'ओपीवी', [
    { n: '0', due: 0, max: 14 },
    { n: '1', due: W6 },
    { n: '2', due: W10 },
    { n: '3', due: W14 },
    { n: 'booster', due: month(16), interval: SIX_MONTHS },
  ]),
  ...series('UIP', 'HEPB', 'Hep B', 'हेपेटाइटिस बी', [{ n: '0', due: 0 }]),
  ...series('UIP', 'PENTA', 'Pentavalent', 'पेंटावैलेंट', [
    { n: '1', due: W6 },
    { n: '2', due: W10 },
    { n: '3', due: W14 },
  ]),
  ...series('UIP', 'ROTA', 'Rotavirus', 'रोटावायरस', [
    { n: '1', due: W6, max: 364 },
    { n: '2', due: W10, max: 364 },
    { n: '3', due: W14, max: 364 },
  ]),
  ...series('UIP', 'FIPV', 'fIPV', 'एफआईपीवी', [
    { n: '1', due: W6 },
    { n: '2', due: W14, interval: 8 * WEEK },
    { n: '3', due: month(9), optional: true },
  ]),
  ...series('UIP', 'PCV', 'PCV', 'पीसीवी', [
    { n: '1', due: W6 },
    { n: '2', due: W14, interval: 8 * WEEK },
    { n: 'booster', due: month(9), interval: 8 * WEEK },
  ]),
  ...series('UIP', 'MR', 'MR', 'एमआर', [
    { n: '1', due: month(9) },
    { n: '2', due: month(16) },
  ]),
  ...series('UIP', 'JE', 'JE', 'जेई', [
    { n: '1', due: month(9), optional: true },
    { n: '2', due: month(16), optional: true },
  ]),
  ...series('UIP', 'DPT', 'DPT', 'डीपीटी', [
    { n: 'booster 1', due: month(16) },
    { n: 'booster 2', due: year(5), interval: SIX_MONTHS },
  ]),
  ...series('UIP', 'TD', 'Td', 'टीडी', [
    { n: '10 y', due: year(10) },
    { n: '16 y', due: year(16), interval: 2000 },
  ]),
];

export const DEFAULT_IMMUNISATION_SCHEDULES: Record<
  ImmunisationScheduleName,
  readonly ScheduleItem[]
> = { IAP: IAP_SCHEDULE, UIP: UIP_SCHEDULE };

// ---------------------------------------------------------------- settings

/** Days past the due date before a dose reads `overdue` instead of `due` (draft, paediatrician to confirm). */
export const DEFAULT_OVERDUE_GRACE_DAYS = 7;
/** A dose given up to this many days before its earliest valid date is not flagged early (draft). */
export const DEFAULT_EARLY_GRACE_DAYS = 4;
/** The reminder goes out this many days before the due date (docs/21 §3). */
export const DEFAULT_REMINDER_LEAD_DAYS = 2;

// ---------------------------------------------------------------- schedule computation

/** A dose recorded as given (`immunisation_given`), reduced to what the schedule needs. */
export interface GivenDose {
  id: string;
  /** `DTP-2`; null for a vaccine outside the schedule. */
  itemCode: string | null;
  givenOn: string;
}

export type DoseWarning = 'early' | 'after_max_age';

export interface ScheduleRow {
  code: string;
  item: ScheduleItem;
  status: ImmunisationStatus;
  /** When the dose is due: its recommended age, moved later by catch-up; null once not applicable. */
  dueDate: string | null;
  /** Earliest valid date (minimum age and interval from the previous dose). */
  earliestDate: string | null;
  /** Last date (maximum age) or null. */
  latestDate: string | null;
  givenOn: string | null;
  givenId: string | null;
  /** Days past the due date today (positive), for `due`/`overdue` rows. */
  daysLate: number;
  /** The previous dose of the series that is still missing, when this one waits for it. */
  waitingFor: string | null;
  notApplicable: NotApplicableReason | null;
  warnings: DoseWarning[];
}

export interface ScheduleOptions {
  dob: string;
  sex: 'F' | 'M' | 'O' | null;
  today: string;
  items: readonly ScheduleItem[];
  given: readonly GivenDose[];
  overdueGraceDays?: number;
  earlyGraceDays?: number;
}

const plus = (iso: string, days: number): string => toIsoDate(addDays(parseIsoDate(iso), days));
const diff = (a: string, b: string): number => daysBetween(parseIsoDate(a), parseIsoDate(b));
const later = (a: string, b: string): string => (a >= b ? a : b);

/** Every dose of the schedule with its status for this child, in schedule order. */
export function computeImmunisationSchedule(o: ScheduleOptions): ScheduleRow[] {
  const grace = o.overdueGraceDays ?? DEFAULT_OVERDUE_GRACE_DAYS;
  const earlyGrace = o.earlyGraceDays ?? DEFAULT_EARLY_GRACE_DAYS;
  const givenByCode = new Map<string, GivenDose>();
  for (const g of [...o.given].sort((a, b) => a.givenOn.localeCompare(b.givenOn))) {
    if (g.itemCode && !givenByCode.has(g.itemCode)) givenByCode.set(g.itemCode, g);
  }
  const bySeries = new Map<string, ScheduleItem[]>();
  for (const i of o.items) {
    const list = bySeries.get(i.vaccineCode) ?? [];
    list.push(i);
    bySeries.set(i.vaccineCode, list);
  }
  const rows = new Map<string, ScheduleRow>();
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.doseNo - b.doseNo);
    /** Date the previous dose was (or could be) given: actual, or `max(due, today)` when missing. */
    let prevDate: string | null = null;
    let prevCode: string | null = null;
    let prevGiven = true;
    let seriesClosed = false;
    for (const item of list) {
      const code = scheduleItemCode(item);
      const rec = givenByCode.get(code) ?? null;
      const fromAge = plus(o.dob, item.minAgeDays);
      const afterPrev: string | null =
        prevDate && item.minIntervalDays !== null ? plus(prevDate, item.minIntervalDays) : prevDate;
      const earliest = afterPrev ? later(fromAge, afterPrev) : fromAge;
      const due = later(plus(o.dob, item.dueAgeDays), earliest);
      const latest = item.maxAgeDays === null ? null : plus(o.dob, item.maxAgeDays);
      const row: ScheduleRow = {
        code,
        item,
        status: 'upcoming',
        dueDate: due,
        earliestDate: earliest,
        latestDate: latest,
        givenOn: null,
        givenId: null,
        daysLate: 0,
        waitingFor: !prevGiven ? prevCode : null,
        notApplicable: null,
        warnings: [],
      };
      if (rec) {
        row.status = 'given';
        row.givenOn = rec.givenOn;
        row.givenId = rec.id;
        row.waitingFor = null;
        if (diff(rec.givenOn, earliest) > earlyGrace) row.warnings.push('early');
        if (latest && rec.givenOn > latest) row.warnings.push('after_max_age');
        prevDate = rec.givenOn;
        prevGiven = true;
      } else {
        const na: NotApplicableReason | null =
          item.onlySex && o.sex !== item.onlySex
            ? 'sex'
            : seriesClosed
              ? 'series_closed'
              : latest && (o.today > latest || due > latest)
                ? 'age_exceeded'
                : null;
        if (na) {
          row.status = 'not_applicable';
          row.notApplicable = na;
          row.dueDate = null;
          row.earliestDate = null;
          row.waitingFor = null;
          if (na !== 'sex') seriesClosed = true;
          // A closed dose does not hold the rest of the series back.
        } else {
          const late = diff(due, o.today);
          row.daysLate = Math.max(late, 0);
          row.status = late < 0 ? 'upcoming' : late <= grace ? 'due' : 'overdue';
          prevDate = later(due, o.today);
          prevGiven = false;
        }
      }
      prevCode = code;
      rows.set(code, row);
    }
  }
  return o.items.map((i) => rows.get(scheduleItemCode(i))!);
}

/** Doses still to give (upcoming, due or overdue), compulsory ones first, by due date. */
export function outstandingDoses(rows: readonly ScheduleRow[]): ScheduleRow[] {
  return rows
    .filter((r) => r.status === 'upcoming' || r.status === 'due' || r.status === 'overdue')
    .sort(
      (a, b) =>
        Number(a.item.isOptional) - Number(b.item.isOptional) ||
        a.dueDate!.localeCompare(b.dueDate!) ||
        a.code.localeCompare(b.code),
    );
}

/**
 * The next date the child is due for compulsory vaccines (docs/11 §4.1 "next due date"): the
 * earliest due date among the outstanding, non-optional doses. Null when nothing is left.
 */
export function nextDueDate(rows: readonly ScheduleRow[]): string | null {
  const dates = rows
    .filter(
      (r) =>
        !r.item.isOptional &&
        (r.status === 'upcoming' || r.status === 'due' || r.status === 'overdue'),
    )
    .map((r) => r.dueDate!)
    .sort();
  return dates[0] ?? null;
}

/** The compulsory doses falling due on `date` (a visit lists every vaccine of the day together). */
export function dosesDueOn(rows: readonly ScheduleRow[], date: string): ScheduleRow[] {
  return rows.filter(
    (r) =>
      !r.item.isOptional &&
      (r.status === 'upcoming' || r.status === 'due' || r.status === 'overdue') &&
      r.dueDate === date,
  );
}

/**
 * Doses to remind about: compulsory, not given, due `leadDays` from `today` (a dose already past
 * its due date is chased by the staff list, not by a message every day).
 */
export function reminderDoses(
  rows: readonly ScheduleRow[],
  today: string,
  leadDays = DEFAULT_REMINDER_LEAD_DAYS,
): ScheduleRow[] {
  return dosesDueOn(rows, plus(today, leadDays));
}

/** First outstanding dose of a series: the one a new "given" record fills by default. */
export function firstOutstandingOfSeries(
  rows: readonly ScheduleRow[],
  vaccineCode: string,
): ScheduleRow | null {
  return (
    rows
      .filter(
        (r) =>
          r.item.vaccineCode === vaccineCode &&
          (r.status === 'upcoming' || r.status === 'due' || r.status === 'overdue'),
      )
      .sort((a, b) => a.item.doseNo - b.item.doseNo)[0] ?? null
  );
}

export type DoseTimingProblem =
  | 'already_given'
  | 'before_birth'
  | 'future_date'
  | 'too_early'
  | 'after_max_age'
  | 'previous_dose_missing'
  | 'not_in_schedule';

/**
 * Checks when a dose is recorded. `before_birth`, `future_date`, `already_given` and
 * `not_in_schedule` block the entry; the rest are warnings the person can confirm past
 * (the nurse may have good reason, and the record must show what was really given).
 */
export function checkDoseTiming(o: {
  dob: string;
  today: string;
  givenOn: string;
  rows: readonly ScheduleRow[];
  itemCode: string | null;
  earlyGraceDays?: number;
}): { blocking: DoseTimingProblem[]; warnings: DoseTimingProblem[] } {
  const blocking: DoseTimingProblem[] = [];
  const warnings: DoseTimingProblem[] = [];
  if (o.givenOn < o.dob) blocking.push('before_birth');
  if (o.givenOn > o.today) blocking.push('future_date');
  if (o.itemCode !== null) {
    const row = o.rows.find((r) => r.code === o.itemCode);
    if (!row) blocking.push('not_in_schedule');
    else if (row.status === 'given') blocking.push('already_given');
    else {
      const grace = o.earlyGraceDays ?? DEFAULT_EARLY_GRACE_DAYS;
      const earliest = row.earliestDate ?? plus(o.dob, row.item.minAgeDays);
      if (diff(o.givenOn, earliest) > grace) warnings.push('too_early');
      if (row.item.maxAgeDays !== null && o.givenOn > plus(o.dob, row.item.maxAgeDays)) {
        warnings.push('after_max_age');
      }
      if (row.waitingFor) warnings.push('previous_dose_missing');
    }
  }
  return { blocking, warnings };
}

// ---------------------------------------------------------------- zod inputs

/** Free text on the vaccination screens: trimmed and guarded (D-10, `always` tier). */
const guarded = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine(...noForbiddenTerms('always'));

export const recordDoseSchema = z.object({
  idempotencyKey: z.uuid(),
  patientId: uuidSchema,
  encounterId: uuidSchema.nullable().default(null),
  /** `DTP-2`; null for a vaccine outside the schedule (then `vaccineName` is required). */
  itemCode: z
    .string()
    .regex(/^[A-Z0-9]+-\d{1,2}$/)
    .nullable(),
  vaccineName: guarded(1, 80),
  brand: guarded(1, 80).nullable().default(null),
  batchNo: guarded(1, 40),
  expiry: isoDateSchema,
  site: z.enum(VACCINE_SITES),
  route: z.enum(VACCINE_ROUTES),
  givenOn: isoDateSchema,
  /** The person typed past the timing warnings. */
  confirmWarnings: z.boolean().default(false),
});
export type RecordDoseInput = z.infer<typeof recordDoseSchema>;

/** A dose can be given from a batch that has not expired on the day (an expired one is blocked). */
export const batchUsable = (expiry: string, givenOn: string): boolean => expiry >= givenOn;

// ---------------------------------------------------------------- reminder timing (docs/21 §3–4)

const IST_OFFSET_MS = 19_800_000;
/** Reminders go out at 10:00 IST (docs/21 §3 follow-up reminder time). */
const REMINDER_HOUR_IST = 10;
/** No reminders 9 pm – 8 am (docs/21 §4). */
const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 8;

const istParts = (d: Date) => {
  const x = new Date(d.getTime() + IST_OFFSET_MS);
  return { date: x.toISOString().slice(0, 10), hour: x.getUTCHours() };
};
/** The instant of `hour`:00 IST on a calendar date. */
const istInstant = (date: string, hour: number): Date => {
  const { year, month, day } = parseIsoDate(date);
  return new Date(Date.UTC(year, month - 1, day, hour) - IST_OFFSET_MS);
};

/**
 * When the reminder for doses due on `dueDate` should go out: 10:00 IST, `leadDays` before. If
 * that time has gone (the dose was just recorded and the next one is close) it goes as soon as
 * quiet hours allow, as long as that is still before the due date. Null when the due date is
 * today or past: a dose already due is chased from the staff list, not by a message.
 */
export function reminderSendAt(dueDate: string, leadDays: number, now: Date): Date | null {
  const today = istParts(now).date;
  if (dueDate <= today) return null;
  const target = istInstant(plus(dueDate, -leadDays), REMINDER_HOUR_IST);
  if (target.getTime() > now.getTime()) return target;
  const { date, hour } = istParts(now);
  let at = now;
  if (hour >= QUIET_FROM_HOUR) at = istInstant(plus(date, 1), QUIET_UNTIL_HOUR);
  else if (hour < QUIET_UNTIL_HOUR) at = istInstant(date, QUIET_UNTIL_HOUR);
  return istParts(at).date < dueDate ? at : null;
}

export const setScheduleSchema = z.object({
  patientId: uuidSchema,
  scheduleName: z.enum(IMMUNISATION_SCHEDULES),
});
export const patientOnlySchema = z.object({ patientId: uuidSchema });
export const cancelRecordSchema = z.object({
  id: uuidSchema,
  reason: guarded(3, 200),
});
export const setConsentSchema = z.object({ patientId: uuidSchema, granted: z.boolean() });
