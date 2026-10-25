import { describe, expect, it } from 'vitest';
import { NUMBER_SERIES_CONFIG_SETTING } from './number-series';
import {
  DEDICATED_SETTINGS,
  EDITABLE_SETTING_KEYS,
  GENERIC_SETTING_KEYS,
  HIDDEN_SETTINGS,
  isEditableSetting,
  isGenericSetting,
  SETTING_GROUPS,
  settingEditor,
  settingGroup,
} from './settings-meta';
import { getSettingDefault, SETTING_KEYS } from './settings';

describe('settings screen metadata (FND-06)', () => {
  it('hides secrets, numbering and MTP config from every editor', () => {
    for (const k of ['queue.displayKey', NUMBER_SERIES_CONFIG_SETTING, 'mtp.rules'] as const) {
      expect(HIDDEN_SETTINGS).toContain(k);
      expect(isEditableSetting(k)).toBe(false);
      expect(GENERIC_SETTING_KEYS).not.toContain(k);
    }
    expect(isEditableSetting('opd.followUpValidityDays')).toBe(true);
    expect(isEditableSetting('not.a.key')).toBe(false);
  });

  it('keeps dedicated keys editable but out of the generic list', () => {
    for (const k of DEDICATED_SETTINGS) {
      expect(EDITABLE_SETTING_KEYS).toContain(k);
      expect(GENERIC_SETTING_KEYS).not.toContain(k);
    }
  });

  it('puts every generic key in a known group', () => {
    for (const k of GENERIC_SETTING_KEYS) expect(SETTING_GROUPS, k).toContain(settingGroup(k));
    expect(GENERIC_SETTING_KEYS.length + HIDDEN_SETTINGS.length + DEDICATED_SETTINGS.length).toBe(
      SETTING_KEYS.length,
    );
  });

  it('derives the editor from the schema', () => {
    expect(settingEditor('billing.roundToRupee')).toEqual({ kind: 'boolean' });
    expect(settingEditor('opd.followUpValidityDays')).toEqual({
      kind: 'integer',
      min: 0,
      max: 365,
      paise: false,
    });
    expect(settingEditor('billing.refundApprovalAbovePaise')).toMatchObject({
      kind: 'integer',
      paise: true,
    });
    expect(settingEditor('opd.sheetPrintAt')).toEqual({
      kind: 'enum',
      options: ['reception', 'vitals'],
    });
    expect(settingEditor('usg.reportFooter')).toEqual({ kind: 'text', maxLength: 2000 });
    expect(settingEditor('ui.bilingualLabels')).toMatchObject({ kind: 'enumArray' });
    expect(settingEditor('auth.lanNetworks')).toEqual({ kind: 'lines' });
    expect(settingEditor('billing.discountLimits')).toEqual({ kind: 'json' });
  });

  it('classifies every generic key, and its default fits the editor', () => {
    for (const k of GENERIC_SETTING_KEYS) {
      const e = settingEditor(k);
      const d: unknown = getSettingDefault(k);
      switch (e.kind) {
        case 'boolean':
          expect(typeof d, k).toBe('boolean');
          break;
        case 'integer':
          expect(Number.isInteger(d), k).toBe(true);
          break;
        case 'enum':
          expect(e.options, k).toContain(d);
          break;
        case 'text':
          expect(typeof d, k).toBe('string');
          break;
        case 'enumArray':
        case 'lines':
          expect(Array.isArray(d), k).toBe(true);
          break;
        case 'json':
          expect(typeof d, k).toBe('object');
          break;
      }
    }
  });

  it('tells the generic editor to skip dedicated keys but show every generic one', () => {
    // The list API returns all editable keys (the print screen needs print.header); the generic
    // editor must filter with this predicate or it renders them without wording (#29).
    for (const k of DEDICATED_SETTINGS) expect(isGenericSetting(k), k).toBe(false);
    for (const k of GENERIC_SETTING_KEYS) expect(isGenericSetting(k), k).toBe(true);
    for (const k of HIDDEN_SETTINGS) expect(isGenericSetting(k), k).toBe(false);
  });
});
