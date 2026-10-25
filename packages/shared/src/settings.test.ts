import { describe, expect, it } from 'vitest';
import {
  effectiveDiscountLimit,
  getSettingDefault,
  isSettingKey,
  parseSettingValue,
  resolveSetting,
  safeParseSettingValue,
  SETTING_KEYS,
  SETTINGS,
  settingKeySchema,
} from './settings';

describe('settings registry', () => {
  it('every default satisfies its own schema', () => {
    for (const key of SETTING_KEYS) {
      const r = SETTINGS[key].schema.safeParse(SETTINGS[key].default);
      expect(r.success, key).toBe(true);
    }
  });

  it('uses lower-camel dotted keys', () => {
    for (const key of SETTING_KEYS) expect(key).toMatch(/^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/);
  });

  it('carries the documented defaults (docs/40, docs/02, docs/03, docs/12)', () => {
    expect(getSettingDefault('opd.followUpValidityDays')).toBe(7); // Q6
    expect(getSettingDefault('opd.freeFollowUps')).toBe(1); // Q6
    expect(getSettingDefault('opd.sheetPrintAt')).toBe('vitals'); // Q11
    expect(getSettingDefault('ipd.bedDayRule')).toBe('midnight'); // Q8
    expect(getSettingDefault('rx.verifyMode')).toBe('sample'); // Q15
    expect(getSettingDefault('print.rxCopy')).toBe(false); // Q16
    expect(getSettingDefault('billing.roundToRupee')).toBe(true);
    expect(getSettingDefault('billing.splitUsgBill')).toBe(false);
    expect(getSettingDefault('billing.allowOpdCredit')).toBe(false);
    expect(getSettingDefault('billing.upiRefRequired').mode).toBe('optional');
    expect(getSettingDefault('billing.packageRoomChange')).toBe('reprice_to_new_category');
    expect(getSettingDefault('billing.refundApprovalAbovePaise')).toBe(100_000);
    expect(getSettingDefault('queue.showNameOnDisplay')).toBe(false);
    expect(getSettingDefault('queue.issueTokenBeforePayment')).toBe(false);
    expect(getSettingDefault('opd.notesRequired')).toBe(false);
    expect(getSettingDefault('mtp.whatsapp')).toBe('none');
    expect(getSettingDefault('pmjay.blockPatientCharges')).toBe(true);
    expect(getSettingDefault('pcpndt.patientDeclarationBeforeScan')).toBe(true);
    expect(getSettingDefault('ipd.requireSummaryBeforeFinalBill')).toBe(true);
    expect(getSettingDefault('newborn.billing')).toBe('mother_bill');
    expect(getSettingDefault('auth.idleLockMinutes')).toBe(10);
    expect(getSettingDefault('ui.bilingualLabels')).toEqual(['reception', 'cashier', 'nurse']);
    for (const f of ['features.pmjay', 'features.cardiology', 'features.trainingMode'] as const) {
      expect(getSettingDefault(f)).toBe(false);
    }
    expect(getSettingDefault('whatsapp.enabled')).toBe(false);
  });

  it('default discount limits follow docs/03 §4', () => {
    const l = getSettingDefault('billing.discountLimits');
    expect(l.reception).toEqual({ maxPercentBp: 0, maxAmountPaise: 0 });
    expect(l.cashier).toEqual({ maxPercentBp: 1000, maxAmountPaise: 50_000 });
    expect(l.admin).toEqual({ maxPercentBp: null, maxAmountPaise: null });
    expect(l.owner).toEqual({ maxPercentBp: null, maxAmountPaise: null });
  });

  it('hands out copies, so mutating a default cannot leak', () => {
    const a = getSettingDefault('billing.discountLimits');
    a.cashier = { maxPercentBp: 9999, maxAmountPaise: 1 };
    expect(getSettingDefault('billing.discountLimits').cashier?.maxPercentBp).toBe(1000);
  });

  it('includes the number series config from FND-05 with an empty default', () => {
    expect(getSettingDefault('numberSeries.config')).toEqual({});
    expect(
      parseSettingValue('numberSeries.config', { form_f: { reset: 'fy', prefix: 'FF' } }),
    ).toEqual({ form_f: { reset: 'fy', prefix: 'FF' } });
    expect(safeParseSettingValue('numberSeries.config', { form_f: { bogus: 1 } }).success).toBe(
      false,
    );
  });
});

describe('parse / resolve', () => {
  it('validates values', () => {
    expect(parseSettingValue('opd.followUpValidityDays', 14)).toBe(14);
    for (const bad of [-1, 366, 1.5, '7', null]) {
      expect(safeParseSettingValue('opd.followUpValidityDays', bad).success).toBe(false);
    }
    expect(safeParseSettingValue('opd.sheetPrintAt', 'pharmacy').success).toBe(false);
    expect(safeParseSettingValue('billing.refundApprovalAbovePaise', 10.5).success).toBe(false);
    expect(safeParseSettingValue('billing.refundApprovalAbovePaise', -1).success).toBe(false);
    expect(safeParseSettingValue('queue.displayKey', 'short').success).toBe(false);
    expect(safeParseSettingValue('queue.displayKey', 'k'.repeat(32)).success).toBe(true);
  });

  it('validates per-doctor overrides keyed by uuid', () => {
    const id = '0192f0a8-5b7c-7c3e-8a52-5b8f2d1c9e10';
    expect(
      parseSettingValue('opd.followUpRulesByDoctor', {
        [id]: { validityDays: 10, freeFollowUps: 2 },
      }),
    ).toEqual({ [id]: { validityDays: 10, freeFollowUps: 2 } });
    expect(
      safeParseSettingValue('opd.followUpRulesByDoctor', {
        'not-a-uuid': { validityDays: 1, freeFollowUps: 1 },
      }).success,
    ).toBe(false);
  });

  it('fills the UPI threshold default', () => {
    expect(parseSettingValue('billing.upiRefRequired', { mode: 'required_above_amount' })).toEqual({
      mode: 'required_above_amount',
      abovePaise: 200_000,
    });
  });

  it('resolveSetting: missing → default, valid → stored, invalid → default (never throws)', () => {
    expect(resolveSetting('opd.followUpValidityDays', undefined)).toBe(7);
    expect(resolveSetting('opd.followUpValidityDays', 10)).toBe(10);
    expect(resolveSetting('opd.followUpValidityDays', 'ten')).toBe(7);
    expect(resolveSetting('opd.freeFollowUps', 0)).toBe(0);
  });

  it('knows its keys', () => {
    expect(isSettingKey('opd.followUpValidityDays')).toBe(true);
    expect(isSettingKey('toString')).toBe(false);
    expect(isSettingKey('nope.nope')).toBe(false);
    expect(settingKeySchema.safeParse('features.pmjay').success).toBe(true);
    expect(settingKeySchema.safeParse('features.nope').success).toBe(false);
  });
});

describe('effectiveDiscountLimit', () => {
  const limits = getSettingDefault('billing.discountLimits');
  it('is zero for roles without an entry', () => {
    expect(effectiveDiscountLimit(limits, ['nurse'])).toEqual({
      maxPercentBp: 0,
      maxAmountPaise: 0,
    });
    expect(effectiveDiscountLimit(limits, [])).toEqual({ maxPercentBp: 0, maxAmountPaise: 0 });
  });
  it('takes the most permissive role; null is unlimited', () => {
    expect(effectiveDiscountLimit(limits, ['reception', 'cashier'])).toEqual({
      maxPercentBp: 1000,
      maxAmountPaise: 50_000,
    });
    expect(effectiveDiscountLimit(limits, ['cashier', 'owner'])).toEqual({
      maxPercentBp: null,
      maxAmountPaise: null,
    });
  });
});
