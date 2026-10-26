import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TERMS } from './compliance/forbidden-terms';
import {
  afterQuietHours,
  backoffMs,
  inQuietHours,
  MESSAGE_KINDS,
  MESSAGE_TEMPLATES,
  nextRetry,
  normalizeMobile,
  providerTemplateName,
  receiptVariables,
  reminderInstant,
  renderTemplate,
  RETRY_WINDOW_MS,
  templateParams,
} from './messaging';

const IST = (iso: string) => new Date(`${iso}+05:30`);

describe('retry schedule', () => {
  it('doubles from one minute up to two hours', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(backoffMs(30)).toBe(2 * 3_600_000);
  });

  it('retries until 48 h after the first attempt, then fails', () => {
    const first = IST('2026-10-26T10:00:00');
    const base = { attempts: 3, firstDueAt: first, retryable: true };
    expect(nextRetry({ ...base, now: first })).toMatchObject({ action: 'retry' });
    const late = new Date(first.getTime() + RETRY_WINDOW_MS - 60_000);
    expect(nextRetry({ ...base, now: late }).action).toBe('fail');
    expect(nextRetry({ ...base, now: first, retryable: false })).toEqual({
      action: 'fail',
      at: null,
    });
  });
});

describe('mobile numbers', () => {
  it('turns Indian numbers into WhatsApp form and rejects the rest', () => {
    expect(normalizeMobile('98765 43210')).toBe('919876543210');
    expect(normalizeMobile('+91-98765-43210')).toBe('919876543210');
    expect(normalizeMobile('09876543210')).toBe('919876543210');
    expect(normalizeMobile('1234567890')).toBeNull();
    expect(normalizeMobile('98765')).toBeNull();
    expect(normalizeMobile('')).toBeNull();
  });
});

describe('quiet hours 9 pm – 8 am', () => {
  it('moves night times to 8 am IST and leaves the day alone', () => {
    expect(inQuietHours(IST('2026-10-26T21:00:00'))).toBe(true);
    expect(inQuietHours(IST('2026-10-26T07:59:00'))).toBe(true);
    expect(inQuietHours(IST('2026-10-26T08:00:00'))).toBe(false);
    expect(afterQuietHours(IST('2026-10-26T22:00:00'))).toEqual(IST('2026-10-27T08:00:00'));
    expect(afterQuietHours(IST('2026-10-26T03:00:00'))).toEqual(IST('2026-10-26T08:00:00'));
    const noon = IST('2026-10-26T12:00:00');
    expect(afterQuietHours(noon)).toEqual(noon);
    expect(reminderInstant('2026-10-27')).toEqual(IST('2026-10-27T10:00:00'));
  });
});

describe('templates', () => {
  it('has an English and a Hindi body whose placeholders match the variable list', () => {
    for (const kind of MESSAGE_KINDS) {
      const def = MESSAGE_TEMPLATES[kind];
      for (const lang of ['en', 'hi'] as const) {
        const nums = [...def.body[lang].matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
        expect(new Set(nums), `${kind}/${lang}`).toEqual(
          new Set(def.variables.map((_, i) => i + 1)),
        );
      }
      expect(def.body.hi).toMatch(/[ऀ-ॿ]/);
    }
    expect(providerTemplateName('receipt', 'hi')).toBe('hmis_receipt_hi');
  });

  it('puts variables in order, joins vaccines and shows a dash for empty values', () => {
    const p = templateParams('vaccine_reminder', 'hi', {
      childName: 'Baby',
      vaccines: ['BCG', 'OPV'],
      vaccinesHi: ['बीसीजी', 'ओपीवी'],
      dueDateText: '05-Nov-2026',
      hospitalName: 'City Hospital',
      hospitalPhone: '',
    });
    expect(p).toEqual(['Baby', 'बीसीजी, ओपीवी', '05-Nov-2026', 'City Hospital', '-']);
    expect(renderTemplate('vaccine_reminder', 'en', p)).toContain('Baby is due for');
  });

  it('formats a receipt amount from paise', () => {
    const v = receiptVariables({
      amountPaise: 123_456n,
      receiptNo: 'RC/26-27/000001',
      date: '26-Oct-2026',
    });
    expect(v.amount).toBe('₹1,234.56');
  });

  it('carries no forbidden term (AGENTS.md rule 7)', () => {
    const text = JSON.stringify(MESSAGE_TEMPLATES).toLowerCase();
    for (const t of FORBIDDEN_TERMS) {
      for (const ex of t.examples) expect(text).not.toContain(ex.toLowerCase());
    }
  });
});
