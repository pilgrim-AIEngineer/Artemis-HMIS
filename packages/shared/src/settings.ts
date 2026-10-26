import { z } from 'zod';
import { accentColorSchema } from './accent';
import { displayKeyHashSchema } from './display';
import { cidrSchema, DEFAULT_LAN_CIDRS } from './network';
import { NUMBER_SERIES_CONFIG_SETTING, numberSeriesConfigSchema } from './number-series';
import { ROLE_KEYS, type RoleKey } from './permissions';
import { PRIORITY_CLASSES } from './visits';
import {
  DEFAULT_HEIGHT_PROMPT_DAYS,
  DEFAULT_VITALS_THRESHOLDS,
  vitalsThresholdsSchema,
} from './vitals';

/**
 * Settings registry (docs/01 §7). One entry per `setting.key`: a zod schema plus the default used
 * until the hospital changes it. Defaults come from the specs or, for open questions, from
 * docs/40 "Default until answered" (referenced as `Qn`). Money inside JSON settings is stored as
 * integer paise in a safe-integer JSON number (field names end in `Paise`) and converted to bigint
 * by the reader, because jsonb has no bigint.
 *
 * No `if (facility === 'X')` anywhere (AGENTS.md rule 16): differences live here.
 */

const paiseJson = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const roleKey = z.enum(ROLE_KEYS);
const uuid = z.uuid();

const followUpRuleSchema = z.object({
  validityDays: z.number().int().min(0).max(365),
  freeFollowUps: z.number().int().min(0).max(20),
});
export type FollowUpRule = z.infer<typeof followUpRuleSchema>;

const discountLimitSchema = z.object({
  /** null = unlimited */
  maxPercentBp: z.number().int().min(0).max(10_000).nullable(),
  /** null = unlimited */
  maxAmountPaise: paiseJson.nullable(),
});
export type DiscountLimit = z.infer<typeof discountLimitSchema>;

const upiRefSchema = z.object({
  mode: z.enum(['off', 'optional', 'required_above_amount']),
  /** Threshold for `required_above_amount` (docs/12 §3 example: ₹2,000). */
  abovePaise: paiseJson.default(200_000),
});

/**
 * Hospital header on every print (docs/05 §6). English name, address, phone and registration
 * numbers come from the facility profile; this adds the Hindi line and wording, so printouts for
 * patients are bilingual (Hindi first, docs/05 §6).
 */
export const printHeaderSchema = z.object({
  nameHi: z.string().trim().max(120).default(''),
  taglineEn: z.string().trim().max(120).default(''),
  taglineHi: z.string().trim().max(120).default(''),
  addressHi: z.string().trim().max(300).default(''),
  /** Registration numbers (clinical establishment, GSTIN) under the address. */
  showRegistrationNos: z.boolean().default(true),
  footerNoteEn: z.string().trim().max(300).default(''),
  footerNoteHi: z.string().trim().max(300).default(''),
});
export type PrintHeaderSettings = z.output<typeof printHeaderSchema>;

interface SettingDef<T extends z.ZodType = z.ZodType> {
  schema: T;
  default: z.output<T>;
}

const def = <T extends z.ZodType>(schema: T, defaultValue: z.output<T>): SettingDef<T> => ({
  schema,
  default: defaultValue,
});

export const SETTINGS = {
  // --- OPD / queue (docs/10, Q6, Q11)
  'opd.followUpValidityDays': def(z.number().int().min(0).max(365), 7), // Q6
  'opd.freeFollowUps': def(z.number().int().min(0).max(20), 1), // Q6
  /** Per-doctor overrides of the two settings above, keyed by doctor id (docs/10 §4). */
  'opd.followUpRulesByDoctor': def(z.record(uuid, followUpRuleSchema), {}),
  'opd.sheetPrintAt': def(z.enum(['reception', 'vitals']), 'vitals'), // Q11
  'opd.quickOrders': def(z.record(uuid, z.array(z.string().min(1).max(80)).max(30)), {}),
  'opd.notesRequired': def(z.boolean(), false),
  'queue.showNameOnDisplay': def(z.boolean(), false),
  'queue.issueTokenBeforePayment': def(z.boolean(), false),
  /** Order of the priority classes above normal tokens, one per line (docs/10 §5). */
  'queue.priorityOrder': def(
    z
      .array(z.string())
      .refine(
        (a) =>
          a.length <= PRIORITY_CLASSES.length &&
          new Set(a).size === a.length &&
          a.every((v) => (PRIORITY_CLASSES as readonly string[]).includes(v)),
        'validation.invalid',
      ),
    [...PRIORITY_CLASSES],
  ),
  /** Speak "token N, Dr X" in Hindi on the TV when a token is called (browser voice; chime only if none). */
  'queue.displayVoice': def(z.boolean(), false),
  /**
   * SHA-256 of the long random key in the `/display/queue` URL (docs/01 §2). Only the hash is
   * stored, so neither `setting` reads nor `audit_log` ever reveal the key; null = no link yet.
   */
  'queue.displayKey': def(displayKeyHashSchema.nullable(), null),

  // --- Vitals (docs/11 §1): clinical seeds the owner reviews before go-live
  'vitals.thresholds': def(vitalsThresholdsSchema, DEFAULT_VITALS_THRESHOLDS),
  /** Ask for height again when the last measurement is at least this many days old. */
  'vitals.heightPromptDays': def(z.number().int().min(30).max(3650), DEFAULT_HEIGHT_PROMPT_DAYS),

  // --- Registration (docs/10 §3)
  /** Duplicate check: phonetic name similarity (percent) at or above which a patient on the same mobile is a possible duplicate. */
  'registration.duplicateMinSimilarityPct': def(z.number().int().min(30).max(100), 60),
  /** Duplicate check: age (years) tolerance between the new and the existing patient. */
  'registration.duplicateAgeToleranceYears': def(z.number().int().min(0).max(10), 2),

  // --- Billing (docs/02 §2, docs/12, docs/03 §4)
  'billing.roundToRupee': def(z.boolean(), true),
  'billing.splitUsgBill': def(z.boolean(), false),
  'billing.allowOpdCredit': def(z.boolean(), false),
  'billing.upiRefRequired': def(upiRefSchema, { mode: 'optional', abovePaise: 200_000 }),
  'billing.discountLimits': def(z.partialRecord(roleKey, discountLimitSchema), {
    reception: { maxPercentBp: 0, maxAmountPaise: 0 },
    // 10% or ₹500, whichever is lower.
    cashier: { maxPercentBp: 1000, maxAmountPaise: 50_000 },
    admin: { maxPercentBp: null, maxAmountPaise: null },
    owner: { maxPercentBp: null, maxAmountPaise: null },
  } satisfies Partial<Record<RoleKey, DiscountLimit>>),
  /** Refunds above this need approver PIN (docs/12 §5: ₹1,000). */
  'billing.refundApprovalAbovePaise': def(paiseJson, 100_000),
  /**
   * Cancelling a final bill (credit note) above this needs approver PIN (docs/03 §3 "requires
   * approval above limit"; the limit is not stated, so it follows the refund one: ₹1,000).
   */
  'billing.cancelApprovalAbovePaise': def(paiseJson, 100_000),
  /** IPD deposit balance below this raises a top-up alert (docs/12 §7.3 example: ₹5,000). */
  'billing.depositLowBalancePaise': def(paiseJson, 500_000),
  'billing.packageRoomChange': def(
    z.enum(['reprice_to_new_category', 'charge_difference_per_day']),
    'reprice_to_new_category',
  ),

  // --- IPD / newborn
  'ipd.bedDayRule': def(z.enum(['midnight', '24h_from_admission']), 'midnight'), // Q8
  /** Safest default: assistant-entered IPD orders need doctor verification. */
  'ipd.ordersRequireVerify': def(z.boolean(), true),
  'ipd.requireSummaryBeforeFinalBill': def(z.boolean(), true),
  'newborn.billing': def(z.enum(['mother_bill', 'separate']), 'mother_bill'),

  // --- Clinical / compliance
  'rx.verifyMode': def(z.enum(['off', 'sample', 'all']), 'sample'), // Q15
  'rx.verifySamplePercent': def(z.number().int().min(1).max(100), 10),
  'rx.requirePhoto': def(z.boolean(), false),
  'print.rxCopy': def(z.boolean(), false), // Q16
  'print.header': def(printHeaderSchema, printHeaderSchema.parse({})),
  'usg.reportFooter': def(z.string().max(2000), ''),
  'pcpndt.patientDeclarationBeforeScan': def(z.boolean(), true),
  /** Gestation-based MTP rules, maintained by the MTP doctor (docs/14); free-form JSON. */
  'mtp.rules': def(z.record(z.string(), z.unknown()), {}),
  'mtp.whatsapp': def(z.enum(['none', 'generic']), 'none'),
  'pmjay.blockPatientCharges': def(z.boolean(), true),

  // --- Platform / auth (docs/01 §5, docs/03 §6)
  'auth.idleLockMinutes': def(z.number().int().min(1).max(240), 10),
  /** Absolute session lifetime. */
  'auth.sessionHours': def(z.number().int().min(1).max(24), 12),
  /** Wrong passwords (or TOTP codes) before the account locks. */
  'auth.maxLoginFailures': def(z.number().int().min(3).max(20), 5),
  'auth.lockoutMinutes': def(z.number().int().min(1).max(1440), 15),
  /** Wrong PINs before PIN unlock is disabled and the locked session is ended. */
  'auth.maxPinFailures': def(z.number().int().min(3).max(20), 5),
  'auth.pinLockoutMinutes': def(z.number().int().min(1).max(1440), 15),
  /** Roles that need TOTP when signing in from outside `auth.lanNetworks`. */
  'auth.totpRequiredRoles': def(z.array(roleKey).min(1), ['owner', 'admin'] as RoleKey[]),
  /** Client networks treated as the hospital LAN; anything else (incl. Tailscale) is remote. */
  'auth.lanNetworks': def(z.array(cidrSchema).max(50), [...DEFAULT_LAN_CIDRS] as string[]),
  'whatsapp.enabled': def(z.boolean(), false),
  'features.pmjay': def(z.boolean(), false),
  'features.cardiology': def(z.boolean(), false),
  'features.trainingMode': def(z.boolean(), false),
  /** Brand accent for the UI and print rules; null = neutral blue (Q20). */
  'ui.accentColor': def(accentColorSchema.nullable(), null),
  /** Roles whose screens show `हिंदी / English` labels together (docs/05 §8). */
  'ui.bilingualLabels': def(z.array(roleKey), ['reception', 'cashier', 'nurse'] as RoleKey[]),
  [NUMBER_SERIES_CONFIG_SETTING]: def(numberSeriesConfigSchema, {}),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTINGS, k);

export const settingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);

export function getSettingDefault<K extends SettingKey>(key: K): SettingValue<K> {
  // Fresh copy so callers cannot mutate the registry default.
  return structuredClone(SETTINGS[key].default) as SettingValue<K>;
}

/** Validates a value for a key (settings UI / `admin.settings.update`); throws `ZodError`. */
export function parseSettingValue<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  return SETTINGS[key].schema.parse(raw) as SettingValue<K>;
}

export function safeParseSettingValue<K extends SettingKey>(key: K, raw: unknown) {
  return SETTINGS[key].schema.safeParse(raw) as z.ZodSafeParseResult<SettingValue<K>>;
}

/**
 * Value to use at runtime: the stored one if present and valid, else the default. An invalid stored
 * value (hand-edited jsonb, older schema) falls back to the default instead of taking the counter
 * down (rule 11); callers that want to surface it use `safeParseSettingValue`.
 */
export function resolveSetting<K extends SettingKey>(key: K, stored: unknown): SettingValue<K> {
  if (stored === undefined) return getSettingDefault(key);
  const r = safeParseSettingValue(key, stored);
  return r.success ? r.data : getSettingDefault(key);
}

/** The discount limit that applies to a user holding `roles`: the most permissive one wins. */
export function effectiveDiscountLimit(
  limits: SettingValue<'billing.discountLimits'>,
  roles: readonly RoleKey[],
): DiscountLimit {
  let best: DiscountLimit = { maxPercentBp: 0, maxAmountPaise: 0 };
  for (const r of roles) {
    const l = limits[r];
    if (!l) continue;
    best = {
      maxPercentBp: maxNullable(best.maxPercentBp, l.maxPercentBp),
      maxAmountPaise: maxNullable(best.maxAmountPaise, l.maxAmountPaise),
    };
  }
  return best;
}

/** `null` means unlimited. */
const maxNullable = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : Math.max(a, b);
