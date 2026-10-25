import { GENERIC_SETTING_KEYS, ROUTE_GROUPS, SETTING_GROUPS, settingEditor } from '@hmis/shared';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import hi from '../messages/hi.json';

const get = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, p) => (acc as Record<string, unknown> | undefined)?.[p], o);

describe.each([
  ['en', en],
  ['hi', hi],
])('%s wording for FND-06 screens', (_name, m) => {
  it('has a label and hint for every setting on the settings screen', () => {
    for (const key of GENERIC_SETTING_KEYS) {
      for (const part of ['label', 'hint']) {
        const v = get(m, `admin.settings.items.${key}.${part}`);
        expect(typeof v === 'string' && v.trim().length > 0, `${key}.${part}`).toBe(true);
      }
    }
  });

  it('names every settings group and every enum option', () => {
    for (const g of SETTING_GROUPS) {
      expect(typeof get(m, `admin.settings.groups.${g}`), g).toBe('string');
    }
    for (const key of GENERIC_SETTING_KEYS) {
      const e = settingEditor(key);
      if (e.kind !== 'enum') continue;
      for (const o of e.options) {
        expect(typeof get(m, `admin.settings.options.${o}`), `${key}:${o}`).toBe('string');
      }
    }
  });

  it('names every role home group in the menu and on its landing page', () => {
    for (const g of ROUTE_GROUPS) {
      expect(typeof get(m, `nav.groups.${g}`), g).toBe('string');
      expect(typeof get(m, `groups.${g}.hint`), g).toBe('string');
    }
  });
});
