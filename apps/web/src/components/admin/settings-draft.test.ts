import type { SettingEditor } from '@hmis/shared';
import { describe, expect, it } from 'vitest';
import { fromDraft, sameDraft, toDraft } from './settings-draft';

describe('settings draft conversion', () => {
  it('shows paise settings in rupees and stores integer paise', () => {
    const e = { kind: 'integer', min: 0, max: null, paise: true } as const;
    expect(toDraft(e, 100_000)).toBe('1000');
    expect(toDraft(e, 123_456)).toBe('1234.56');
    expect(fromDraft(e, '1000')).toEqual({ ok: true, value: 100_000 });
    expect(fromDraft(e, '1234.5')).toEqual({ ok: true, value: 123_450 });
    expect(fromDraft(e, '12.345')).toEqual({ ok: false, error: 'validation.invalid' });
    expect(fromDraft(e, '-5')).toEqual({ ok: false, error: 'validation.invalid' });
    expect(fromDraft(e, '')).toEqual({ ok: false, error: 'validation.required' });
  });

  it('round-trips plain integers, booleans, enums, lists and JSON', () => {
    const int = { kind: 'integer', min: 0, max: 365, paise: false } as const;
    expect(fromDraft(int, toDraft(int, 7))).toEqual({ ok: true, value: 7 });
    expect(fromDraft(int, '7.5')).toEqual({ ok: false, error: 'validation.invalid' });
    expect(fromDraft({ kind: 'boolean' }, toDraft({ kind: 'boolean' }, true))).toEqual({
      ok: true,
      value: true,
    });
    const roles: SettingEditor = { kind: 'enumArray', options: ['owner', 'admin'] };
    expect(fromDraft(roles, toDraft(roles, ['admin']))).toEqual({ ok: true, value: ['admin'] });
    const lines = { kind: 'lines' } as const;
    expect(toDraft(lines, ['10.0.0.0/8', '192.168.0.0/16'])).toBe('10.0.0.0/8\n192.168.0.0/16');
    expect(fromDraft(lines, ' 10.0.0.0/8 \n\n192.168.0.0/16\n')).toEqual({
      ok: true,
      value: ['10.0.0.0/8', '192.168.0.0/16'],
    });
    const json = { kind: 'json' } as const;
    expect(fromDraft(json, toDraft(json, { a: [1] }))).toEqual({ ok: true, value: { a: [1] } });
    expect(fromDraft(json, '{oops')).toEqual({ ok: false, error: 'admin.settings.jsonInvalid' });
  });

  it('compares drafts structurally', () => {
    expect(sameDraft(['a'], ['a'])).toBe(true);
    expect(sameDraft(['a'], ['b'])).toBe(false);
    expect(sameDraft('1', '1')).toBe(true);
  });
});
