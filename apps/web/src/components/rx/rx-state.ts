import {
  buildInstruction,
  rxQuantity,
  rxWarnings,
  type DrugForm,
  type DurationUnit,
  type FrequencyCode,
  type ParsedRxLine,
  type RxDraftPayload,
  type RxPhrasesOverride,
  type RxRoute,
  type RxTiming,
  type PaedsCheckContext,
  type RxWarning,
  type SaveRxInput,
} from '@hmis/shared';

/**
 * State of the transcription screen (OPD-02 … OPD-04) and its conversions: from a saved Rx, to and
 * from the autosaved draft (docs/01 §3), and to the save input. Pure, so it is unit tested.
 * Quantity and instructions stay `null` until the assistant overrides them; the shown value is
 * computed from the row (docs/11 §2.3).
 */

export interface RxRow {
  /** Client key for React lists. */
  key: string;
  drugId: string | null;
  drugName: string;
  genericName: string | null;
  /** The drug's strength (`250 mg`), for the paediatric dose check. */
  strength?: string | null;
  form: DrugForm | null;
  doseText: string | null;
  frequencyCode: FrequencyCode | null;
  pattern: string | null;
  timing: RxTiming | null;
  route: RxRoute | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  /** Typed by the assistant; null = computed. */
  quantity: number | null;
  /** Typed by the assistant; null = built from the row. */
  instructionsHi: string | null;
  instructionsEn: string | null;
  sourceLine: string | null;
  extra: string | null;
}

export interface RxState {
  rows: RxRow[];
  /** The shorthand line being typed. */
  line: string;
  /** Ordered services (lab, USG, procedures). */
  orders: string[];
  admission: { advised: boolean; expectedDate: string | null; note: string | null };
  note: {
    complaints: string[];
    complaintsText: string | null;
    diagnosis: string | null;
    advice: string[];
    adviceText: string | null;
  };
  followUpDate: string | null;
  scanDocumentId: string | null;
}

export const emptyState = (scanDocumentId: string | null = null): RxState => ({
  rows: [],
  line: '',
  orders: [],
  admission: { advised: false, expectedDate: null, note: null },
  note: { complaints: [], complaintsText: null, diagnosis: null, advice: [], adviceText: null },
  followUpDate: null,
  scanDocumentId,
});

let keySeq = 0;
export const newRowKey = () => `r${++keySeq}`;

/** A drug from the master as the grid shows it: `Paracetamol 650 mg`. */
export const drugLabel = (d: { brandName: string; strength: string | null }) =>
  d.strength ? `${d.brandName} ${d.strength}` : d.brandName;

export interface DrugChoice {
  id: string;
  brandName: string;
  genericName: string | null;
  strength: string | null;
  form: DrugForm;
}

/** A grid row from a parsed shorthand line and the drug picked for it (or free text). */
export function rowFromParsed(p: ParsedRxLine, d: DrugChoice | null): RxRow {
  return {
    key: newRowKey(),
    drugId: d?.id ?? null,
    drugName: d ? drugLabel(d) : p.drugText || p.raw,
    genericName: d?.genericName ?? null,
    strength: d?.strength ?? null,
    form: d?.form ?? p.form,
    doseText: p.doseText,
    frequencyCode: p.frequencyCode,
    pattern: p.pattern,
    timing: p.timing,
    route: p.route,
    durationValue: p.durationValue,
    durationUnit: p.durationUnit,
    quantity: null,
    instructionsHi: null,
    instructionsEn: null,
    sourceLine: p.raw || null,
    extra: p.extra,
  };
}

/** Quantity shown in the grid: the typed one, else pattern × days for solids. */
export const shownQuantity = (r: RxRow): number | null =>
  r.quantity ??
  rxQuantity({
    form: r.form,
    pattern: r.pattern,
    frequencyCode: r.frequencyCode,
    durationValue: r.durationValue,
    durationUnit: r.durationUnit,
  });

export const shownInstruction = (r: RxRow, lang: 'hi' | 'en', phrases: RxPhrasesOverride) =>
  (lang === 'hi' ? r.instructionsHi : r.instructionsEn) ?? buildInstruction(r, lang, phrases);

export const warningsOf = (
  rows: readonly RxRow[],
  paeds: PaedsCheckContext | null = null,
): RxWarning[] =>
  rows.length === 0
    ? []
    : rxWarnings(
        rows.map((r) => ({ ...r, quantity: shownQuantity(r) })),
        paeds,
      );

// ---------------------------------------------------------------- saved Rx → state

export interface SavedItem {
  drugId: string | null;
  drugName: string;
  genericName: string | null;
  form: DrugForm | null;
  doseText: string | null;
  frequencyCode: FrequencyCode | null;
  pattern: string | null;
  timing: RxTiming | null;
  route: RxRoute | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  quantity: number | null;
  instructionsEn: string | null;
  instructionsHi: string | null;
  sourceLine: string | null;
}

/**
 * Rows of a saved (or the last) Rx. A stored quantity or instruction that equals the computed one
 * goes back to "computed", so editing the pattern in a correction updates it; one the assistant
 * had typed stays as typed.
 */
export function rowsFromSaved(items: readonly SavedItem[], phrases: RxPhrasesOverride): RxRow[] {
  return items.map((i) => {
    const row: RxRow = { ...i, key: newRowKey(), extra: null };
    const computed = { ...row, quantity: null, instructionsHi: null, instructionsEn: null };
    return {
      ...row,
      quantity: row.quantity === shownQuantity(computed) ? null : row.quantity,
      instructionsHi:
        row.instructionsHi === buildInstruction(row, 'hi', phrases) ? null : row.instructionsHi,
      instructionsEn:
        row.instructionsEn === buildInstruction(row, 'en') ? null : row.instructionsEn,
    };
  });
}

// ---------------------------------------------------------------- draft

export interface StoredDraft {
  savedAt: string;
  payload: RxDraftPayload;
}

export function toDraft(s: RxState): RxDraftPayload {
  return {
    items: s.rows.map(({ key: _k, ...r }) => r),
    line: s.line || null,
    orders: s.orders,
    admission: s.admission,
    note: s.note,
    followUpDate: s.followUpDate,
    scanDocumentId: s.scanDocumentId,
  };
}

export function fromDraft(p: RxDraftPayload): RxState {
  return {
    rows: p.items.map((i) => ({
      key: newRowKey(),
      drugId: i.drugId ?? null,
      drugName: i.drugName ?? '',
      genericName: i.genericName ?? null,
      strength: i.strength ?? null,
      form: i.form ?? null,
      doseText: i.doseText ?? null,
      frequencyCode: i.frequencyCode ?? null,
      pattern: i.pattern ?? null,
      timing: i.timing ?? null,
      route: i.route ?? null,
      durationValue: i.durationValue ?? null,
      durationUnit: i.durationUnit ?? null,
      quantity: i.quantity ?? null,
      instructionsHi: i.instructionsHi ?? null,
      instructionsEn: i.instructionsEn ?? null,
      sourceLine: i.sourceLine ?? null,
      extra: i.extra ?? null,
    })),
    line: p.line ?? '',
    orders: p.orders,
    admission: {
      advised: p.admission.advised,
      expectedDate: p.admission.expectedDate ?? null,
      note: p.admission.note ?? null,
    },
    note: {
      complaints: p.note.complaints,
      complaintsText: p.note.complaintsText ?? null,
      diagnosis: p.note.diagnosis ?? null,
      advice: p.note.advice,
      adviceText: p.note.adviceText ?? null,
    },
    followUpDate: p.followUpDate ?? null,
    scanDocumentId: p.scanDocumentId ?? null,
  };
}

/** True when the state holds anything worth keeping as a draft. */
export const hasContent = (s: RxState) =>
  s.rows.length > 0 ||
  !!s.line.trim() ||
  s.orders.length > 0 ||
  s.admission.advised ||
  !!s.followUpDate ||
  s.note.complaints.length > 0 ||
  s.note.advice.length > 0 ||
  !!s.note.complaintsText ||
  !!s.note.diagnosis ||
  !!s.note.adviceText;

/**
 * Which draft to offer for restore: the newer of the browser's copy (every 5 s) and the server's
 * (every 20 s), and only if it is newer than the Rx already saved for the visit.
 */
export function pickDraft(
  local: StoredDraft | null,
  server: StoredDraft | null,
  savedRxAt: Date | null,
): (StoredDraft & { from: 'local' | 'server' }) | null {
  const candidates = [
    local && { ...local, from: 'local' as const },
    server && { ...server, from: 'server' as const },
  ].filter((c): c is StoredDraft & { from: 'local' | 'server' } => !!c);
  const fresh = candidates
    .filter((c) => !savedRxAt || new Date(c.savedAt).getTime() > savedRxAt.getTime())
    .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
  return fresh[0] ?? null;
}

export const draftStorageKey = (encounterId: string) => `hmis.rx.draft.${encounterId}`;

export function readLocalDraft(encounterId: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(draftStorageKey(encounterId));
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredDraft;
    return typeof v.savedAt === 'string' && v.payload ? v : null;
  } catch {
    return null;
  }
}

export function writeLocalDraft(encounterId: string, d: StoredDraft): void {
  try {
    window.localStorage.setItem(draftStorageKey(encounterId), JSON.stringify(d));
  } catch {
    // Storage full or disabled: the server copy still runs.
  }
}

export function clearLocalDraft(encounterId: string): void {
  try {
    window.localStorage.removeItem(draftStorageKey(encounterId));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- save input

export function toSaveInput(
  s: RxState,
  encounterId: string,
  idempotencyKey: string,
  phrases: RxPhrasesOverride,
): SaveRxInput {
  return {
    encounterId,
    idempotencyKey,
    items: s.rows.map((r) => ({
      drugId: r.drugId,
      drugName: r.drugName,
      form: r.form,
      doseText: r.doseText,
      frequencyCode: r.frequencyCode,
      pattern: r.pattern,
      timing: r.timing,
      route: r.route,
      durationValue: r.durationValue,
      durationUnit: r.durationUnit,
      quantity: shownQuantity(r),
      instructionsHi: shownInstruction(r, 'hi', phrases) || null,
      instructionsEn: shownInstruction(r, 'en', phrases) || null,
      sourceLine: r.sourceLine,
    })),
    orders: s.orders.map((serviceId) => ({ serviceId })),
    admission: s.admission,
    note: s.note,
    followUpDate: s.followUpDate,
    scanDocumentId: s.scanDocumentId,
  };
}
