import { z } from 'zod';
import { financialYearOf, istCalendarDate } from './fy';

/**
 * Number series catalogue (docs/02 §4). Rows in `number_series` hold the running counter per
 * facility + key + period; this file holds defaults and formatting. Daily OPD tokens are not a
 * series (see `allocateDailyToken` in @hmis/db).
 */

export const SERIES_RESETS = ['never', 'fy', 'calendar'] as const;
export type SeriesReset = (typeof SERIES_RESETS)[number];

export interface SeriesDefinition {
  reset: SeriesReset;
  prefix: string;
  padding: number;
}

export const NUMBER_SERIES = {
  // Prefix is configurable per facility (docs/02 §4 example `GH-000123`); neutral default.
  uhid: { reset: 'never', prefix: 'UH', padding: 6 },
  opd_visit: { reset: 'fy', prefix: 'OP', padding: 6 },
  opd_bill: { reset: 'fy', prefix: 'OB', padding: 6 },
  ipd_admission: { reset: 'fy', prefix: 'IP', padding: 5 },
  ipd_bill: { reset: 'fy', prefix: 'IB', padding: 5 },
  receipt: { reset: 'fy', prefix: 'RC', padding: 6 },
  deposit: { reset: 'fy', prefix: 'DP', padding: 5 },
  credit_note: { reset: 'fy', prefix: 'CN', padding: 5 },
  pharmacy_invoice: { reset: 'fy', prefix: 'PH', padding: 6 },
  purchase_grn: { reset: 'fy', prefix: 'GRN', padding: 5 },
  lab_order: { reset: 'fy', prefix: 'LB', padding: 6 },
  // Legal registers: calendar year per docs/02 §4, pending confirmation with the Appropriate
  // Authority; overridable via the `numberSeries.config` setting without code changes.
  form_f: { reset: 'calendar', prefix: 'FF', padding: 4 },
  mtp_register: { reset: 'calendar', prefix: 'MTP', padding: 3 },
  birth_register: { reset: 'calendar', prefix: 'BR', padding: 4 },
} as const satisfies Record<string, SeriesDefinition>;

export type SeriesKey = keyof typeof NUMBER_SERIES;
export const SERIES_KEYS = Object.keys(NUMBER_SERIES) as SeriesKey[];

export const seriesKeySchema = z.enum(SERIES_KEYS as [SeriesKey, ...SeriesKey[]]);

/** `number_series.fy` value for series that never reset. */
export const NEVER_RESET_PERIOD = 'all';

const prefixSchema = z
  .string()
  .min(1)
  .max(12)
  .regex(/^[A-Z0-9]+$/, 'Uppercase letters and digits only');

/**
 * Setting `numberSeries.config`: per-key overrides of the defaults above. Prefix/padding apply
 * when a new period row is created (existing rows keep theirs); changing `reset` mid-period
 * restarts numbering and is an admin-only decision.
 */
export const numberSeriesConfigSchema = z
  .partialRecord(
    seriesKeySchema,
    z
      .object({
        reset: z.enum(SERIES_RESETS),
        prefix: prefixSchema,
        padding: z.number().int().min(1).max(12),
      })
      .partial()
      .strict(),
  )
  .default({});

export type NumberSeriesConfig = z.infer<typeof numberSeriesConfigSchema>;
export const NUMBER_SERIES_CONFIG_SETTING = 'numberSeries.config';

export function resolveSeriesDefinition(
  key: SeriesKey,
  config: NumberSeriesConfig = {},
): SeriesDefinition {
  return { ...NUMBER_SERIES[key], ...config[key] };
}

export interface SeriesPeriod {
  /** Stored in `number_series.fy`: `2026-27`, `2026` or `all`. */
  period: string;
  /** Middle segment of the formatted number: `26-27`, `2026` or `null`. */
  label: string | null;
}

/** Period of a business instant on the IST calendar. */
export function seriesPeriod(reset: SeriesReset, at: Date): SeriesPeriod {
  switch (reset) {
    case 'never':
      return { period: NEVER_RESET_PERIOD, label: null };
    case 'fy': {
      const fy = financialYearOf(at);
      return { period: fy.label, label: fy.short };
    }
    case 'calendar': {
      const year = String(istCalendarDate(at).year);
      return { period: year, label: year };
    }
  }
}

/** `UH-000123`, `OP/26-27/004512`, `FF/2026/0001`. Values past the padding simply grow. */
export function formatSeriesNumber(
  prefix: string,
  periodLabel: string | null,
  value: number,
  padding: number,
): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid value: ${value}`);
  const digits = String(value).padStart(padding, '0');
  return periodLabel === null ? `${prefix}-${digits}` : `${prefix}/${periodLabel}/${digits}`;
}
