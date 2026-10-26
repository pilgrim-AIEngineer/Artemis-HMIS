import { z } from 'zod';
import { ROLE_KEYS } from './permissions';
import { NUMBER_SERIES_CONFIG_SETTING } from './number-series';
import { SETTING_KEYS, SETTINGS, type SettingKey } from './settings';

/**
 * How the settings screen (Admin → Settings) shows each registry key (FND-06). The editor is
 * derived from the zod schema, so a new registry entry appears on the screen with no UI work; only
 * wording (`settings.items.<key>` in the message files) is added by hand — a test enforces it.
 */

/** Keys with their own screen or flow; the generic editor never shows them. */
export const DEDICATED_SETTINGS = [
  'print.header',
  'ui.accentColor',
] as const satisfies SettingKey[];

/** Keys nobody edits by hand: generated secrets, numbering (own screen later), MTP config (restricted). */
export const HIDDEN_SETTINGS: readonly SettingKey[] = [
  'queue.displayKey',
  NUMBER_SERIES_CONFIG_SETTING,
  'mtp.rules',
  'mtp.whatsapp',
];

const hidden: ReadonlySet<string> = new Set(HIDDEN_SETTINGS);
const dedicated: ReadonlySet<string> = new Set(DEDICATED_SETTINGS);

/** Keys the `admin.updateSetting` procedure accepts. */
export const EDITABLE_SETTING_KEYS: readonly SettingKey[] = SETTING_KEYS.filter(
  (k) => !hidden.has(k),
);
export const isEditableSetting = (k: string): k is SettingKey =>
  (EDITABLE_SETTING_KEYS as readonly string[]).includes(k);

/** Keys shown in the generic editor. */
export const GENERIC_SETTING_KEYS: readonly SettingKey[] = EDITABLE_SETTING_KEYS.filter(
  (k) => !dedicated.has(k),
);

export const isGenericSetting = (k: string): boolean =>
  (GENERIC_SETTING_KEYS as readonly string[]).includes(k);

export const SETTING_GROUPS = [
  'opd',
  'queue',
  'registration',
  'billing',
  'ipd',
  'newborn',
  'rx',
  'print',
  'vitals',
  'anc',
  'usg',
  'pcpndt',
  'pmjay',
  'auth',
  'whatsapp',
  'features',
  'ui',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const settingGroup = (key: SettingKey): string => key.split('.')[0]!;

export type SettingEditor =
  | { kind: 'boolean' }
  | { kind: 'integer'; min: number | null; max: number | null; paise: boolean }
  | { kind: 'enum'; options: string[] }
  | { kind: 'text'; maxLength: number | null }
  | { kind: 'enumArray'; options: string[] }
  | { kind: 'lines' }
  | { kind: 'json' };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;

/** Picks the editor for a key from its schema (falls back to a JSON box for anything complex). */
export function settingEditor(key: SettingKey): SettingEditor {
  let js: Json;
  try {
    js = z.toJSONSchema(SETTINGS[key].schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return { kind: 'json' };
  }
  const options = (j: unknown): string[] | null =>
    isObj(j) && Array.isArray(j.enum) && j.enum.every((x) => typeof x === 'string') ? j.enum : null;
  switch (js.type) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'integer':
    case 'number':
      return {
        kind: 'integer',
        min: typeof js.minimum === 'number' ? js.minimum : null,
        max: typeof js.maximum === 'number' ? js.maximum : null,
        paise: key.endsWith('Paise'),
      };
    case 'string': {
      const o = options(js);
      return o
        ? { kind: 'enum', options: o }
        : { kind: 'text', maxLength: typeof js.maxLength === 'number' ? js.maxLength : null };
    }
    case 'array': {
      const o = options(js.items);
      if (o) return { kind: 'enumArray', options: o };
      if (isObj(js.items) && js.items.type === 'string') return { kind: 'lines' };
      return { kind: 'json' };
    }
    default:
      return { kind: 'json' };
  }
}

export const ROLE_KEY_SET: ReadonlySet<string> = new Set(ROLE_KEYS);
