import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import hi from '../messages/hi.json';

const keys = (o: object, prefix = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe('i18n messages', () => {
  it('hi has exactly the same keys as en', () => {
    expect(keys(hi).sort()).toEqual(keys(en).sort());
  });

  it('has no empty strings', () => {
    for (const [name, m] of Object.entries({ en, hi })) {
      const empty = keys(m).filter((k) => {
        const v = k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], m);
        return typeof v !== 'string' || v.trim() === '';
      });
      expect(empty, name).toEqual([]);
    }
  });
});
