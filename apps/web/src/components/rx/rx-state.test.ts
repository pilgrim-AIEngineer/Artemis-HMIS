import { parseRxShorthand, rxDraftPayloadSchema, saveRxSchema } from '@hmis/shared';
import { describe, expect, it } from 'vitest';
import {
  clearAllLocalDrafts,
  draftStorageKey,
  emptyState,
  fromDraft,
  hasContent,
  pickDraft,
  rowFromParsed,
  rowsFromSaved,
  shownInstruction,
  shownQuantity,
  toDraft,
  toSaveInput,
  warningsOf,
  type RxState,
} from './rx-state';

const pcm = {
  id: '0190a000-0000-7000-8000-000000000001',
  brandName: 'Paracetamol',
  genericName: 'Paracetamol',
  strength: '650 mg',
  form: 'tab' as const,
};

describe('transcription screen state (OPD-02)', () => {
  it('builds a row from a shorthand line and a picked drug', () => {
    const r = rowFromParsed(parseRxShorthand('dolo 650 1-0-1 af 5d'), pcm);
    expect(r).toMatchObject({
      drugId: pcm.id,
      drugName: 'Paracetamol 650 mg',
      form: 'tab',
      pattern: '1-0-1',
    });
    expect(shownQuantity(r)).toBe(10);
    expect(shownInstruction(r, 'hi', {})).toBe('1-0-1, खाने के बाद, 5 दिन');
    expect(shownQuantity({ ...r, quantity: 12 })).toBe(12);
    expect(shownInstruction({ ...r, instructionsHi: 'अपना' }, 'hi', {})).toBe('अपना');
  });

  it('keeps an unknown drug as free text and the unknown words in the instructions', () => {
    const r = rowFromParsed(parseRxShorthand('syp mystery 5ml tds 3d if fever'), null);
    expect(r).toMatchObject({ drugId: null, drugName: 'mystery', form: 'syp', extra: 'if fever' });
    expect(shownQuantity(r)).toBeNull();
    expect(shownInstruction(r, 'en', {})).toBe('5 ml, 1-1-1, 3 days, if fever');
    expect(warningsOf([r])).toEqual([{ code: 'free_text_drug', row: 0 }]);
  });

  it('round-trips through the draft payload and validates as one', () => {
    const s: RxState = {
      ...emptyState('0190a000-0000-7000-8000-00000000000a'),
      rows: [rowFromParsed(parseRxShorthand('dolo 650 1-0-1 af 5d'), pcm)],
      line: 'folvite bd',
      orders: ['0190a000-0000-7000-8000-000000000002'],
      admission: { advised: true, expectedDate: '2026-11-02', note: 'LSCS' },
      followUpDate: '2026-11-02',
    };
    const payload = toDraft(s);
    expect(rxDraftPayloadSchema.safeParse(payload).success).toBe(true);
    const back = fromDraft(payload);
    expect({ ...back, rows: back.rows.map(({ key: _k, ...r }) => r) }).toEqual({
      ...s,
      rows: s.rows.map(({ key: _k, ...r }) => r),
    });
    expect(hasContent(emptyState())).toBe(false);
    expect(hasContent(s)).toBe(true);
  });

  it('makes a save input the server accepts', () => {
    const s: RxState = {
      ...emptyState('0190a000-0000-7000-8000-00000000000a'),
      rows: [rowFromParsed(parseRxShorthand('dolo 650 1-0-1 af 5d'), pcm)],
      orders: ['0190a000-0000-7000-8000-000000000002'],
    };
    const input = toSaveInput(
      s,
      '0190a000-0000-7000-8000-000000000003',
      '0190a000-0000-7000-8000-000000000004',
      {},
    );
    const parsed = saveRxSchema.parse(input);
    expect(parsed.items[0]).toMatchObject({
      quantity: 10,
      instructionsHi: '1-0-1, खाने के बाद, 5 दिन',
      sourceLine: 'dolo 650 1-0-1 af 5d',
    });
    expect(parsed.orders).toEqual([
      { serviceId: '0190a000-0000-7000-8000-000000000002', priority: 'routine', notes: null },
    ]);
  });

  it('loads a saved Rx with computed values back as computed, typed ones as typed', () => {
    const [a, b] = rowsFromSaved(
      [
        {
          ...rowFromParsed(parseRxShorthand('dolo 650 1-0-1 af 5d'), pcm),
          quantity: 10,
          instructionsHi: '1-0-1, खाने के बाद, 5 दिन',
          instructionsEn: '1-0-1, after food, 5 days',
        },
        {
          ...rowFromParsed(parseRxShorthand('dolo 650 1-0-1 af 5d'), pcm),
          quantity: 12,
          instructionsHi: 'अपना',
          instructionsEn: null,
        },
      ],
      {},
    );
    expect([a!.quantity, a!.instructionsHi, a!.instructionsEn]).toEqual([null, null, null]);
    expect(shownInstruction({ ...a!, pattern: '1-1-1' }, 'hi', {})).toBe(
      '1-1-1, खाने के बाद, 5 दिन',
    );
    expect([b!.quantity, b!.instructionsHi]).toEqual([12, 'अपना']);
  });

  it('offers the newest draft that is newer than the saved Rx', () => {
    const d = (savedAt: string) => ({ savedAt, payload: toDraft(emptyState()) });
    const local = d('2026-10-26T05:00:10.000Z');
    const server = d('2026-10-26T05:00:00.000Z');
    expect(pickDraft(local, server, null)?.from).toBe('local');
    expect(pickDraft(null, server, null)?.from).toBe('server');
    expect(pickDraft(local, server, new Date('2026-10-26T05:00:05.000Z'))?.from).toBe('local');
    expect(pickDraft(local, server, new Date('2026-10-26T05:01:00.000Z'))).toBeNull();
    expect(pickDraft(null, null, null)).toBeNull();
  });
});

describe('browser storage on a shared workstation (ASVS 8.2.2)', () => {
  it('sign-out removes every Rx draft and nothing else', () => {
    const data = new Map<string, string>([
      [draftStorageKey('0190a000-0000-7000-8000-00000000000a'), '{"payload":1}'],
      [draftStorageKey('0190a000-0000-7000-8000-00000000000b'), '{"payload":2}'],
      ['hmis.lastDoctor', 'doctor-1'],
    ]);
    clearAllLocalDrafts({
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      removeItem: (k) => void data.delete(k),
    });
    expect([...data.keys()]).toEqual(['hmis.lastDoctor']);
  });
});
