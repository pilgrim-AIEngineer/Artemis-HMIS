import {
  cancelImportBatch,
  commitImportStep,
  countPendingImportRows,
  createImportBatch,
  getImportBatch,
  ImportError,
  type ImportContext,
  listImportBatches,
  listImportRows,
  remapImportBatch,
} from '@hmis/db/import';
import { buildWorkbook } from '@hmis/db/templates';
import { TEMPLATES } from '@hmis/db/templates/spec';
import {
  IMPORT_COMMIT_BATCH,
  IMPORT_KINDS,
  IMPORT_ROW_STATUSES,
  IMPORT_TARGETS,
  importOptionsSchema,
  MAX_IMPORT_BYTES,
  uuidSchema,
} from '@hmis/shared';
import { z } from 'zod';
import { appError, protectedProcedure, router } from '../../init';

/** MIG-01 (docs/10 §9): everything here needs `admin.import.run`; rows hold patient data. */
const run = protectedProcedure.meta({ permission: 'admin.import.run' });

const TEMPLATE_FILE = { patients: 'patients.xlsx', services_rates: 'services_rates.xlsx' } as const;

/** Import errors from the db layer become i18n keys (docs/02 §7). */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ImportError) {
      throw appError(
        err.key === 'import.notFound' ? 'NOT_FOUND' : 'BAD_REQUEST',
        `errors.${err.key}`,
      );
    }
    throw err;
  }
}

const batchId = z.object({ batchId: uuidSchema });

export const importerRouter = router({
  /** The empty Excel template of a kind, as base64 (generated from the same spec as the committed files). */
  template: run.input(z.object({ kind: z.enum(IMPORT_KINDS) })).query(async ({ input }) => {
    const spec = TEMPLATES.find((t) => t.file === TEMPLATE_FILE[input.kind])!;
    const wb = buildWorkbook(spec);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    return { fileName: spec.file, base64: bytes.toString('base64') };
  }),

  /** Upload + first dry run. The file arrives as base64 (≤ 5 MB) so it goes through the same gate. */
  upload: run
    .input(
      z.object({
        kind: z.enum(IMPORT_KINDS),
        fileName: z.string().trim().min(1).max(200),
        base64: z.string().max(Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 8),
        options: importOptionsSchema.partial().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const bytes = Buffer.from(input.base64, 'base64');
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_BYTES) {
        throw appError('BAD_REQUEST', 'errors.import.fileTooBig');
      }
      return mapped(async () => ({
        batchId: await createImportBatch(
          importCtx(ctx),
          { kind: input.kind, fileName: input.fileName, bytes, options: input.options },
          ctx.now(),
        ),
      }));
    }),

  list: run.query(({ ctx }) => ctx.tx((tx) => listImportBatches(tx, ctx.auth.facilityId))),

  get: run.input(batchId).query(({ ctx, input }) =>
    mapped(async () => {
      const { b, pending } = await ctx.tx(async (tx) => {
        const b = await getImportBatch(tx, ctx.auth.facilityId, input.batchId);
        return { b, pending: await countPendingImportRows(tx, ctx.auth.facilityId, b) };
      });
      return {
        id: b.id,
        pending,
        kind: b.kind as (typeof IMPORT_KINDS)[number],
        fileName: b.fileName,
        stage: b.stage,
        headers: b.headers,
        mapping: b.mapping,
        options: importOptionsSchema.parse(b.options),
        totalRows: b.totalRows,
        counts: b.counts,
        targets: IMPORT_TARGETS[b.kind as (typeof IMPORT_KINDS)[number]],
        commitBatchSize: IMPORT_COMMIT_BATCH,
        createdAt: b.createdAt,
      };
    }),
  ),

  rows: run
    .input(
      batchId.extend({
        statuses: z.array(z.enum(IMPORT_ROW_STATUSES)).max(6).optional(),
        afterSeq: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).default(50),
      }),
    )
    .query(({ ctx, input }) =>
      mapped(async () => {
        await ctx.tx((tx) => getImportBatch(tx, ctx.auth.facilityId, input.batchId));
        return ctx.tx((tx) =>
          listImportRows(tx, ctx.auth.facilityId, input.batchId, {
            statuses: input.statuses,
            afterSeq: input.afterSeq,
            limit: input.limit,
          }),
        );
      }),
    ),

  /** Everything the user has to look at, with the original cells, for the error report download. */
  report: run.input(batchId).query(({ ctx, input }) =>
    mapped(async () => {
      const b = await ctx.tx((tx) => getImportBatch(tx, ctx.auth.facilityId, input.batchId));
      const rows = await ctx.tx((tx) =>
        listImportRows(tx, ctx.auth.facilityId, input.batchId, {
          statuses: ['error', 'duplicate', 'failed'],
          limit: 10_000,
        }),
      );
      return {
        fileName: b.fileName,
        headers: b.headers,
        rows: rows.map((r) => ({
          sourceRow: r.sourceRow,
          raw: r.raw,
          status: r.status,
          issues: r.issues.map(({ field, code }) => ({ field, code })),
        })),
      };
    }),
  ),

  /** New column mapping and / or options: the rows are checked again. */
  remap: run
    .input(
      batchId.extend({
        mapping: z.array(z.string().max(40).nullable()).max(200).optional(),
        options: importOptionsSchema.partial().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapped(async () => {
        await remapImportBatch(importCtx(ctx), input, ctx.now());
        return { ok: true as const };
      }),
    ),

  /** Commits the next batch of rows; the screen calls it until `done`. */
  commitStep: run
    .input(batchId)
    .mutation(({ ctx, input }) =>
      mapped(() => commitImportStep(importCtx(ctx), input.batchId, ctx.now())),
    ),

  cancel: run
    .input(batchId.extend({ reason: z.string().trim().min(3).max(200) }))
    .mutation(({ ctx, input }) =>
      mapped(async () => {
        await cancelImportBatch(importCtx(ctx), input.batchId, input.reason);
        return { ok: true as const };
      }),
    ),
});

function importCtx(ctx: {
  db: () => ImportContext['db'];
  auth: {
    userId: string;
    facilityId: string;
    workstationId: string | null;
    permissions: ReadonlySet<string>;
  };
}): ImportContext {
  return {
    db: ctx.db(),
    userId: ctx.auth.userId,
    facilityId: ctx.auth.facilityId,
    workstationId: ctx.auth.workstationId,
    permissions: [...ctx.auth.permissions],
  };
}
