import { describe, expect, it } from 'vitest';
import {
  cancelMasterSchema,
  consultationRuleInputSchema,
  departmentInputSchema,
  drugInputSchema,
  MASTER_KINDS,
  MASTER_KIND_PERMISSION,
  searchQueryText,
  serviceInputSchema,
  serviceRateInputSchema,
  tariffInputSchema,
  usgProcedureInputSchema,
} from './masters';
import { isPermission } from './permissions';

const uuid = '0190f0a0-0000-7000-8000-000000000001';

describe('master kinds', () => {
  it('map to documented permissions', () => {
    for (const kind of MASTER_KINDS) expect(isPermission(MASTER_KIND_PERMISSION[kind])).toBe(true);
  });
});

describe('master input schemas', () => {
  it('normalises codes and blanks', () => {
    const d = departmentInputSchema.parse({ name: ' Pathology ', code: 'path', nameHi: '  ' });
    expect(d).toMatchObject({ name: 'Pathology', code: 'PATH', nameHi: null, isActive: true });
  });

  it('rejects an exempt service with a GST rate', () => {
    const base = { code: 'x1', name: 'Dressing', category: 'procedure' as const };
    expect(
      serviceInputSchema.safeParse({ ...base, isExempt: true, defaultGstRateBp: 500 }).success,
    ).toBe(false);
    expect(
      serviceInputSchema.safeParse({ ...base, isExempt: false, defaultGstRateBp: 500 }).success,
    ).toBe(true);
  });

  it('keeps GST in basis points', () => {
    expect(drugInputSchema.safeParse({ brandName: 'Calcium', gstRateBp: 12000 }).success).toBe(
      false,
    );
    expect(drugInputSchema.parse({ brandName: 'Calcium', gstRateBp: 1200 }).gstRateBp).toBe(1200);
  });

  it('parses rates as paise bigint and refuses fractions or negatives', () => {
    const base = { serviceId: uuid, tariffId: uuid, effectiveFrom: '2026-10-26' };
    expect(serviceRateInputSchema.parse({ ...base, ratePaise: '50000' }).ratePaise).toBe(50000n);
    expect(serviceRateInputSchema.safeParse({ ...base, ratePaise: 500.5 }).success).toBe(false);
    expect(serviceRateInputSchema.safeParse({ ...base, ratePaise: -1 }).success).toBe(false);
  });

  it('orders tariff dates', () => {
    const ok = tariffInputSchema.safeParse({
      name: 'Standard',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
    });
    const bad = tariffInputSchema.safeParse({
      name: 'Standard',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2026-03-31',
    });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it('defaults Form F gating on for USG procedures (legal safe default)', () => {
    expect(
      usgProcedureInputSchema.parse({ code: 'NT', name: 'NT scan', category: 'obstetric' })
        .requiresFormFIfPregnant,
    ).toBe(true);
  });

  it('consultation rules default to the settings fallbacks', () => {
    const r = consultationRuleInputSchema.parse({
      doctorId: uuid,
      visitType: 'follow_up',
      serviceId: uuid,
    });
    expect(r.followUpValidityDays).toBeNull();
    expect(r.freeFollowUpsCount).toBeNull();
  });

  it('requires a reason to cancel', () => {
    expect(cancelMasterSchema.safeParse({ id: uuid, reason: ' ' }).success).toBe(false);
    expect(cancelMasterSchema.safeParse({ id: uuid, reason: 'Duplicate entry' }).success).toBe(
      true,
    );
  });
});

describe('searchQueryText', () => {
  it('lower-cases and folds punctuation, keeping Devanagari', () => {
    expect(searchQueryText('  Inj. Oxytocin-10 IU ')).toBe('inj oxytocin 10 iu');
    expect(searchQueryText('कैप्सूल, गोली')).toBe('कैप्सूल गोली');
  });
});
