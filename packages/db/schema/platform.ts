/**
 * Platform tables (docs/04 §1, FND-04/05). Grants, triggers and helper functions that drizzle-kit
 * cannot express live in the custom migration `0001_platform_roles_audit.sql`.
 */
import {
  AUDIT_ACTIONS,
  DOCUMENT_KINDS,
  INTEGRATION_DIRECTIONS,
  INTEGRATION_EVENT_STATUSES,
  INTEGRATION_SYSTEMS,
  RECORD_STATUSES,
  USER_LOCALES,
} from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, idColumn, sqlIn } from './columns';

/**
 * MTP data (AGENTS.md rule 8). Empty until MTP-01; every table here needs RLS (see
 * packages/db/README.md) and its own audit sink, so `hmis_register_business_table` refuses it.
 */
export const restrictedSchema = pgSchema('restricted');

export const facility = pgTable(
  'facility',
  {
    id: idColumn(),
    /** Always equals `id`: keeps "every table has facility_id" true for generic code. */
    facilityId: uuid().notNull(),
    name: text().notNull(),
    shortName: text(),
    address: text(),
    district: text(),
    state: text(),
    pincode: text(),
    phone: text(),
    email: text(),
    gstin: text(),
    clinicalEstablishmentRegNo: text(),
    pcpndtRegNo: text(),
    mtpApprovalNo: text(),
    drugLicenceNos: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    hfrId: text(),
    logoFileId: uuid(),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    check('facility_facility_id_is_id', sql`${t.facilityId} = ${t.id}`),
    check('facility_pincode_format', sql`${t.pincode} ~ '^[1-9][0-9]{5}$'`),
    check('facility_gstin_format', sql`${t.gstin} ~ '^[0-9]{2}[A-Z0-9]{13}$'`),
  ],
);

const facilityRef = () =>
  uuid()
    .notNull()
    .references(() => facility.id);

export const appUser = pgTable(
  'app_user',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    username: text().notNull(),
    fullName: text().notNull(),
    mobile: text(),
    /** argon2id; NULL = cannot log in with a password yet. Redacted in audit_log. */
    passwordHash: text(),
    pinHash: text(),
    preferredLocale: text().notNull().default('en'),
    isActive: boolean().notNull().default(true),
    lastLoginAt: timestamp({ withTimezone: true }),
    /** AES-256-GCM with `HMIS_SECRET_KEY`; enforced only once `totp_confirmed_at` is set. */
    totpSecretEnc: text(),
    totpConfirmedAt: timestamp({ withTimezone: true }),
    /** Last accepted TOTP time step: a code is never accepted twice (replay). */
    totpLastStep: bigint({ mode: 'number' }),
    /** Password lockout (docs/01 §5): count resets on success or when the lock is set. */
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    /** PIN has its own lockout, separate from the password one. */
    pinFailedCount: integer().notNull().default(0),
    pinLockedUntil: timestamp({ withTimezone: true }),
    /** Set by an admin password reset: the user must choose a new password after login. */
    passwordMustChange: boolean().notNull().default(false),
    passwordChangedAt: timestamp({ withTimezone: true }),
    /** Users are deactivated, never deleted (AGENTS.md rule 4). */
    deactivatedAt: timestamp({ withTimezone: true }),
    deactivatedBy: uuid(),
    deactivateReason: text(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('app_user_username_key').on(sql`lower(${t.username})`),
    check('app_user_preferred_locale', sqlIn(t.preferredLocale, USER_LOCALES)),
    check('app_user_username_format', sql`${t.username} ~ '^[A-Za-z0-9._-]{3,40}$'`),
    check(
      'app_user_failed_counts_nonnegative',
      sql`${t.failedLoginCount} >= 0 and ${t.pinFailedCount} >= 0`,
    ),
  ],
);

export const role = pgTable(
  'role',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    key: text().notNull(),
    name: text().notNull(),
    nameHi: text(),
    description: text(),
    isSystem: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    unique('role_facility_key').on(t.facilityId, t.key),
    check('role_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

export const permission = pgTable(
  'permission',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    /** `module.action` (docs/03 §2). */
    key: text().notNull(),
    module: text().notNull(),
    description: text(),
    ...auditColumns(),
  },
  (t) => [
    unique('permission_facility_key').on(t.facilityId, t.key),
    check('permission_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`),
  ],
);

/** Grants are revoked (never deleted) so the history stays in the table and audit_log. */
export const rolePermission = pgTable(
  'role_permission',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    permissionId: uuid()
      .notNull()
      .references(() => permission.id),
    revokedAt: timestamp({ withTimezone: true }),
    revokedBy: uuid(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('role_permission_active_key')
      .on(t.roleId, t.permissionId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export const userRole = pgTable(
  'user_role',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    revokedAt: timestamp({ withTimezone: true }),
    revokedBy: uuid(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('user_role_active_key')
      .on(t.userId, t.roleId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export const workstation = pgTable(
  'workstation',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    name: text().notNull(),
    location: text(),
    defaultPrinterThermal: text(),
    defaultPrinterA4: text(),
    defaultPrinterA5: text(),
    qzEnabled: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    /**
     * SHA-256 of the secret in the paired browser's workstation cookie (admin pairing, docs/01 §5).
     * Re-pairing replaces it, which unpairs the previous browser. Redacted in audit_log.
     */
    pairingTokenHash: text(),
    pairedAt: timestamp({ withTimezone: true }),
    pairedBy: uuid(),
    ...auditColumns(),
  },
  (t) => [unique('workstation_facility_name').on(t.facilityId, t.name)],
);

export const session = pgTable(
  'session',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    /** SHA-256 of the cookie token; the token itself is never stored. Redacted in audit_log. */
    tokenHash: text().notNull(),
    workstationId: uuid().references(() => workstation.id),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    revokeReason: text(),
    /** Explicit lock ("Lock" button or client idle timer); idle time past the limit also locks. */
    lockedAt: timestamp({ withTimezone: true }),
    /** Remote sign-in of a TOTP role: the session is usable only after `mfa_verified_at`. */
    mfaRequired: boolean().notNull().default(false),
    mfaVerifiedAt: timestamp({ withTimezone: true }),
    /** Client address as seen behind Caddy; not patient data. */
    clientIp: text(),
    isRemote: boolean().notNull().default(false),
    ...auditColumns(),
  },
  (t) => [
    unique('session_token_hash_key').on(t.tokenHash),
    index('session_user_active_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export const setting = pgTable(
  'setting',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    key: text().notNull(),
    value: jsonb().notNull(),
    ...auditColumns(),
  },
  (t) => [
    unique('setting_facility_key').on(t.facilityId, t.key),
    check('setting_key_format', sql`${t.key} ~ '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)+$'`),
  ],
);

/** docs/02 §4. Allocate only through `allocateNumber` (packages/db/src/number-series.ts). */
export const numberSeries = pgTable(
  'number_series',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    key: text().notNull(),
    /** Period: FY label `2026-27`, calendar year `2026`, or `all` for never-reset series. */
    fy: text().notNull(),
    prefix: text().notNull(),
    nextValue: bigint({ mode: 'number' }).notNull().default(1),
    padding: integer().notNull(),
    ...auditColumns(),
  },
  (t) => [
    unique('number_series_facility_key_fy').on(t.facilityId, t.key, t.fy),
    check('number_series_next_value_positive', sql`${t.nextValue} >= 1`),
    check('number_series_padding_range', sql`${t.padding} between 1 and 12`),
    check('number_series_fy_format', sql`${t.fy} ~ '^([0-9]{4}(-[0-9]{2})?|all)$'`),
  ],
);

/**
 * Written only by the `hmis_audit_row()` trigger (SECURITY DEFINER). The app role may SELECT;
 * INSERT/UPDATE/DELETE are revoked. No `updated_*` columns (docs/04 §1).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey(),
    facilityId: uuid(),
    tableName: text().notNull(),
    rowId: uuid().notNull(),
    action: text().notNull(),
    changedBy: uuid(),
    workstationId: uuid(),
    changedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    before: jsonb(),
    after: jsonb(),
  },
  (t) => [
    index('audit_log_row_idx').on(t.tableName, t.rowId, t.changedAt),
    index('audit_log_changed_at_idx').on(t.changedAt),
    check('audit_log_action', sqlIn(t.action, AUDIT_ACTIONS)),
  ],
);

/** Reads of restricted records (MTP, Form F, break-glass). App role: SELECT + INSERT only. */
export const accessLog = pgTable(
  'access_log',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    workstationId: uuid().references(() => workstation.id),
    entity: text().notNull(),
    entityId: uuid().notNull(),
    purpose: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ...auditColumns(),
  },
  (t) => [
    index('access_log_entity_idx').on(t.entity, t.entityId, t.at),
    index('access_log_user_idx').on(t.userId, t.at),
  ],
);

/** docs/02 §7: client-generated key; a duplicate submit returns the stored result. */
export const idempotency = pgTable(
  'idempotency',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    key: uuid().notNull(),
    procedure: text().notNull(),
    result: jsonb().notNull(),
    ...auditColumns(),
  },
  (t) => [unique('idempotency_key_key').on(t.key)],
);

export const document = pgTable(
  'document',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    kind: text().notNull(),
    entity: text(),
    entityId: uuid(),
    /** Relative to the files volume: `facility/yyyy/mm/<uuid>.<ext>` (docs/01 §2). */
    filePath: text().notNull(),
    mime: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    sha256: text().notNull(),
    pages: integer(),
    status: text().notNull().default('active'),
    cancelReason: text(),
    cancelledBy: uuid(),
    cancelledAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    index('document_entity_idx').on(t.entity, t.entityId),
    check('document_kind', sqlIn(t.kind, DOCUMENT_KINDS)),
    check('document_status', sqlIn(t.status, RECORD_STATUSES)),
    check('document_size_nonnegative', sql`${t.sizeBytes} >= 0`),
    check('document_sha256_format', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'document_cancel_fields',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelReason} is not null)`,
    ),
  ],
);

/** Append-only (docs/01 §4). Reprints (`copy_no > 1`) show DUPLICATE. */
export const printLog = pgTable(
  'print_log',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    template: text().notNull(),
    entity: text().notNull(),
    entityId: uuid().notNull(),
    copyNo: integer().notNull(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    workstationId: uuid().references(() => workstation.id),
    ...auditColumns(),
  },
  (t) => [
    index('print_log_entity_idx').on(t.entity, t.entityId),
    check('print_log_copy_no_positive', sql`${t.copyNo} >= 1`),
  ],
);

/**
 * Outbox/inbox for external systems (docs/04 §13, docs/01 §10). Never block the counter on the
 * internet (AGENTS.md rule 11): the worker drains `pending` rows and retries. WhatsApp uses its
 * own `message_outbox` (MSG-01).
 */
export const integrationEvent = pgTable(
  'integration_event',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    system: text().notNull(),
    direction: text().notNull(),
    eventType: text().notNull(),
    payload: jsonb().notNull(),
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    index('integration_event_due_idx').on(t.status, t.nextAttemptAt),
    check('integration_event_system', sqlIn(t.system, INTEGRATION_SYSTEMS)),
    check('integration_event_direction', sqlIn(t.direction, INTEGRATION_DIRECTIONS)),
    check('integration_event_status', sqlIn(t.status, INTEGRATION_EVENT_STATUSES)),
    check('integration_event_attempts_nonnegative', sql`${t.attempts} >= 0`),
  ],
);
