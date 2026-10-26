/**
 * Excel / CSV import staging (MIG-01, docs/10 §9). A batch is one uploaded file: its rows are kept
 * as read (`raw`, aligned with `headers`) with the dry-run verdict, so the error report, a remap
 * and a resumed commit all work from the database, not from the browser. `import_row` is staging
 * (rebuilt from the file at any time) and is not audited; the rows an import creates (patients,
 * services, rates) are audited like any other write. Nothing is deleted: a batch is cancelled
 * with a reason (AGENTS.md rule 4).
 */
import { IMPORT_KINDS, IMPORT_ROW_STATUSES } from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, cancelChecks, cancelColumns, idColumn, sqlIn } from './columns';
import { facilityRef } from './platform';

export const IMPORT_BATCH_STAGES = ['dry_run', 'committing', 'committed', 'cancelled'] as const;

export const importBatch = pgTable(
  'import_batch',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    kind: text().notNull(),
    fileName: text().notNull(),
    fileSha256: text().notNull(),
    /** Source column titles in file order. */
    headers: jsonb().$type<string[]>().notNull(),
    /** One entry per header: the template column it feeds, or null (ignored). */
    mapping: jsonb().$type<(string | null)[]>().notNull(),
    /** Importer options (duplicate policy, default dates …). */
    options: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Where the import is; `status` (below) is the record's active / cancelled flag. */
    stage: text().notNull().default('dry_run'),
    totalRows: integer().notNull().default(0),
    /** Rows per status after the last dry run / commit step. */
    counts: jsonb().$type<Record<string, number>>().notNull().default({}),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    index('import_batch_facility_idx').on(t.facilityId, t.createdAt),
    check('import_batch_kind', sqlIn(t.kind, IMPORT_KINDS)),
    check('import_batch_stage', sqlIn(t.stage, IMPORT_BATCH_STAGES)),
    ...cancelChecks('import_batch', t),
  ],
);

export const importRow = pgTable(
  'import_row',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    batchId: uuid()
      .notNull()
      .references(() => importBatch.id),
    /** Ordinal in the file after the header (1-based): commit order. */
    seq: integer().notNull(),
    /** Row number in the source file, for the user. */
    sourceRow: integer().notNull(),
    raw: jsonb().$type<string[]>().notNull(),
    status: text().notNull().default('ok'),
    /** `[{ field, code, level: 'error' | 'warning' }]` */
    issues: jsonb().$type<{ field: string; code: string; level: 'error' | 'warning' }[]>()
      .notNull()
      .default([]),
    /** A few display fields for the preview table (name, mobile, rate …). */
    preview: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** The existing patient a duplicate row matched. */
    duplicateOfId: uuid(),
    /** The patient / service rate this row created or changed. */
    resultId: uuid(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('import_row_seq_key').on(t.batchId, t.seq),
    index('import_row_status_idx').on(t.batchId, t.status, t.seq),
    check('import_row_status_check', sqlIn(t.status, IMPORT_ROW_STATUSES)),
    check('import_row_seq_positive', sql`${t.seq} >= 1`),
  ],
);
