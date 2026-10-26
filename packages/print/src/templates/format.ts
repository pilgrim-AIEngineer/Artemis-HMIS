import type { VitalsRecord } from '@hmis/db';
import { ageFromDob, flagLevelByField, GRADE_SYMBOL, type Age } from '@hmis/shared';
import { L } from '../labels';
import type { Bilingual } from '../types';

/** `28y`, `6m`, `12d`: the same in Hindi and English, short enough for a sticker. */
export function shortAge(age: Age): string {
  return `${age.value}${age.unit === 'years' ? 'y' : age.unit === 'months' ? 'm' : 'd'}`;
}

export const SEX_LABELS: Record<string, Bilingual> = { F: L.sexF, M: L.sexM, O: L.sexO };

/** `28y / F` — age from the DOB on `at`, sex letter as stored (the patient's own sex). */
export function ageSex(dob: string, sex: string, at: Date): string {
  try {
    return `${shortAge(ageFromDob(dob, at))} / ${sex}`;
  } catch {
    return sex; // a DOB in the future is a data error; never stop a print for it
  }
}

/** Last four digits of a mobile number, or null; the full number is never printed on stickers. */
export const mobileLast4 = (mobile: string | null | undefined): string | null =>
  mobile && mobile.length >= 4 ? mobile.slice(-4) : null;

/** `62.50` → `62.5`, `62` → `62`: stored numerics without trailing zeros. */
const trim = (n: number) => String(Number(n.toFixed(2)));

/** What the OPD sheet shows of a saved reading (OPD-01): the five boxes, the extras, flags, alerts. */
export interface SheetVitals {
  vitals: Partial<Record<VitalKey, string>>;
  vitalFlags: Partial<Record<VitalKey, 'amber' | 'red'>>;
  vitalsMore: { label: Bilingual; value: string }[];
  alerts: 'raised_bp_pregnancy'[];
}

export type VitalKey = 'bp' | 'pulse' | 'weight' | 'temp' | 'spo2';

export function sheetVitals(r: VitalsRecord): SheetVitals {
  const vitals: SheetVitals['vitals'] = {};
  if (r.bpSys !== null && r.bpDia !== null) vitals.bp = `${r.bpSys}/${r.bpDia}`;
  if (r.pulse !== null) vitals.pulse = String(r.pulse);
  if (r.weightKg !== null) vitals.weight = trim(r.weightKg);
  if (r.tempF !== null) vitals.temp = trim(r.tempF);
  if (r.spo2 !== null) vitals.spo2 = String(r.spo2);

  const bands = flagLevelByField(r.flags);
  const vitalFlags: SheetVitals['vitalFlags'] = {};
  if (bands.bp) vitalFlags.bp = bands.bp;
  if (bands.pulse) vitalFlags.pulse = bands.pulse;
  if (bands.temp) vitalFlags.temp = bands.temp;
  if (bands.spo2) vitalFlags.spo2 = bands.spo2;

  const vitalsMore: SheetVitals['vitalsMore'] = [];
  const add = (label: Bilingual, value: string | null) => {
    if (value !== null) vitalsMore.push({ label, value });
  };
  const n = (v: number | null, unit = '') => (v === null ? null : `${trim(v)}${unit}`);
  add(L.height, n(r.heightCm, ' cm'));
  add(L.bmi, n(r.bmi));
  add(L.rr, n(r.rr, '/min'));
  add(L.headCirc, n(r.headCircCm, ' cm'));
  add(L.muac, n(r.muacCm, ' cm'));
  // Sugar carries its flag in the text itself (it has no box of its own).
  add(L.rbs, r.rbsMgdl === null ? null : `${r.rbsMgdl}${bands.rbs ? '*' : ''}`);
  add(L.fundalHeight, n(r.fundalHeightCm, ' cm'));
  add(L.fhr, n(r.fhr, '/min'));
  add(L.oedema, r.oedema === null ? null : GRADE_SYMBOL[r.oedema]);
  add(L.urineAlbumin, r.urineAlbumin === null ? null : GRADE_SYMBOL[r.urineAlbumin]);
  add(L.urineSugar, r.urineSugar === null ? null : GRADE_SYMBOL[r.urineSugar]);

  return {
    vitals,
    vitalFlags,
    vitalsMore,
    alerts: r.flags.some((f) => f.code === 'raised_bp_pregnancy') ? ['raised_bp_pregnancy'] : [],
  };
}
