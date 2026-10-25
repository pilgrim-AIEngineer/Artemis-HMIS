import { paiseToRupees, rupeesToPaise, type SettingEditor } from '@hmis/shared';

/**
 * What a settings row holds while it is being edited. Everything is text/boolean/list so the
 * inputs stay controlled; `fromDraft` turns it back into the JSON value the server validates.
 */
export type Draft = string | boolean | string[];

export type DraftResult = { ok: true; value: unknown } | { ok: false; error: string };

export function toDraft(editor: SettingEditor, value: unknown): Draft {
  switch (editor.kind) {
    case 'boolean':
      return value === true;
    case 'integer':
      return editor.paise && typeof value === 'number'
        ? paiseToRupees(BigInt(value)).replace(/\.00$/, '')
        : typeof value === 'number' || typeof value === 'string'
          ? String(value)
          : '';
    case 'enum':
    case 'text':
      return typeof value === 'string' ? value : '';
    case 'enumArray':
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    case 'lines':
      return Array.isArray(value) ? value.join('\n') : '';
    case 'json':
      return JSON.stringify(value ?? null, null, 2);
  }
}

export function fromDraft(editor: SettingEditor, draft: Draft): DraftResult {
  switch (editor.kind) {
    case 'boolean':
      return { ok: true, value: draft === true };
    case 'integer': {
      const text = String(draft).trim();
      if (!text) return { ok: false, error: 'validation.required' };
      if (editor.paise) {
        // Rupees with at most two decimals → integer paise (never a float).
        if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: 'validation.invalid' };
        const paise = Number(rupeesToPaise(text));
        return Number.isSafeInteger(paise)
          ? { ok: true, value: paise }
          : { ok: false, error: 'validation.invalid' };
      }
      if (!/^-?\d+$/.test(text)) return { ok: false, error: 'validation.invalid' };
      return { ok: true, value: Number(text) };
    }
    case 'enum':
    case 'text':
      return { ok: true, value: String(draft) };
    case 'enumArray':
      return { ok: true, value: Array.isArray(draft) ? draft : [] };
    case 'lines':
      return {
        ok: true,
        value: String(draft)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      };
    case 'json':
      try {
        return { ok: true, value: JSON.parse(String(draft)) as unknown };
      } catch {
        return { ok: false, error: 'admin.settings.jsonInvalid' };
      }
  }
}

export const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b);
