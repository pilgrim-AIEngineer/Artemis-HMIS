import { DEFAULT_ROLE_NAMES, readSettings, writeSetting } from '@hmis/db';
import {
  EDITABLE_SETTING_KEYS,
  getSettingDefault,
  isEditableSetting,
  settingEditor,
  settingGroup,
  SETTINGS,
  settingKeySchema,
  type SettingKey,
} from '@hmis/shared';
import { TRPCError } from '@trpc/server';
import { z, ZodError } from 'zod';
import { appError, protectedProcedure } from '../../init';

const settings = protectedProcedure.meta({ permission: 'admin.settings.manage' });

function editableKey(key: SettingKey): SettingKey {
  if (!isEditableSetting(key)) throw appError('FORBIDDEN', 'errors.admin.settingNotEditable');
  return key;
}

/** Stores a validated value; a value the registry schema rejects is a BAD_REQUEST, not a 500. */
async function save(
  ctx: { tx: <T>(fn: (tx: Parameters<typeof writeSetting>[0]) => Promise<T>) => Promise<T> },
  facilityId: string,
  key: SettingKey,
  value: unknown,
) {
  try {
    return await ctx.tx((tx) => writeSetting(tx, facilityId, key, value));
  } catch (err) {
    if (err instanceof ZodError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'validation.invalid', cause: err });
    }
    throw err;
  }
}

/**
 * Settings screen (docs/01 §7). Reads the registry and the `setting` table; writes validate with
 * the registry's zod schema, so the UI can never store a value the rest of the system would reject.
 * Every change is audited by the table trigger (who, when, before/after).
 */
export const settingsProcedures = {
  /** Editable settings with their editor description, current value and default. */
  listSettings: settings.query(async ({ ctx }) => {
    const keys = [...EDITABLE_SETTING_KEYS];
    const values = await readSettings(ctx.db(), ctx.auth.facilityId, keys);
    const items = keys.map((key) => {
      const value: unknown = values[key];
      const def: unknown = getSettingDefault(key);
      return {
        key,
        group: settingGroup(key),
        editor: settingEditor(key),
        value,
        default: def,
        isDefault: JSON.stringify(value) === JSON.stringify(def),
      };
    });
    // Role display names for the role pickers (`ui.bilingualLabels`, `auth.totpRequiredRoles`).
    return { items, roleNames: DEFAULT_ROLE_NAMES };
  }),

  updateSetting: settings
    .input(z.object({ key: settingKeySchema, value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const key = editableKey(input.key);
      const value = await save(ctx, ctx.auth.facilityId, key, input.value);
      return { key, value: value as unknown };
    }),

  /** "Back to the recommended value": stores the registry default (rows are never deleted). */
  resetSetting: settings
    .input(z.object({ key: settingKeySchema }))
    .mutation(async ({ ctx, input }) => {
      const key = editableKey(input.key);
      const value = await save(ctx, ctx.auth.facilityId, key, SETTINGS[key].default);
      return { key, value: value as unknown };
    }),
};
