import {
  attachRxScan,
  discardRxDraft,
  IdempotencyConflictError,
  lastRxItems,
  rxContext,
  RxInputError,
  rxVerificationQueue,
  saveRx,
  saveRxDraft,
  searchDrugs,
  searchOrderables,
  transcriptionList,
  verifyRx,
  VisitInputError,
} from '@hmis/db';
import { filesDirFromEnv, removeFile, storeFile } from '@hmis/db/files';
import {
  attachRxScanSchema,
  drugSearchSchema,
  encounterIdSchema,
  MAX_UPLOAD_BYTES,
  orderSearchSchema,
  saveRxDraftSchema,
  saveRxSchema,
  verifyRxSchema,
} from '@hmis/shared';
import { appError, protectedProcedure, requirePermission, router } from '../../init';

/**
 * Rx transcription (OPD-02 … OPD-04, docs/11 §2). The assistant's procedures need
 * `rx.transcribe` (placing orders also `order.create`); the doctor's verification queue needs
 * `rx.verify` (AGENTS.md rule 6).
 */
const transcribe = protectedProcedure.meta({ permission: 'rx.transcribe' });
const verify = protectedProcedure.meta({ permission: 'rx.verify' });

const NOT_FOUND = new Set<string>(['rx.encounterNotFound', 'rx.notFound']);
const CONFLICT = new Set<string>([
  'rx.encounterNotOpen',
  'rx.orderBilled',
  'rx.notPendingVerification',
  'queue.invalidTransition',
]);
const FORBIDDEN = new Set<string>(['rx.notYourPatient']);

/** Domain errors from the db layer become i18n message keys (docs/02 §7). */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RxInputError || err instanceof VisitInputError) {
      const code = NOT_FOUND.has(err.key)
        ? 'NOT_FOUND'
        : CONFLICT.has(err.key)
          ? 'CONFLICT'
          : FORBIDDEN.has(err.key)
            ? 'FORBIDDEN'
            : 'BAD_REQUEST';
      throw appError(code, `errors.${err.key}`);
    }
    if (err instanceof IdempotencyConflictError) {
      throw appError('CONFLICT', 'errors.idempotency.conflict');
    }
    throw err;
  }
}

/** JPEG files start with the SOI marker and a segment marker (FF D8 FF). */
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export const rxRouter = router({
  /** Today's "Seen — to transcribe" and "Transcribed today" lists (docs/11 §2.1). */
  list: transcribe.query(({ ctx }) =>
    ctx.tx((tx) => transcriptionList(tx, ctx.auth.facilityId, ctx.now())),
  ),

  /** Everything the transcription screen needs for one visit. */
  context: transcribe
    .input(encounterIdSchema)
    .query(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => rxContext(tx, ctx.auth.facilityId, input.encounterId))),
    ),

  /** The previous Rx of the same doctor for this patient ("Repeat last Rx"). */
  lastRx: transcribe
    .input(encounterIdSchema)
    .query(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => lastRxItems(tx, ctx.auth.facilityId, input.encounterId))),
    ),

  /** Drug type-ahead ranked by the visit doctor's use, then stocked items. */
  searchDrugs: transcribe.input(drugSearchSchema).query(({ ctx, input }) =>
    mapped(() =>
      ctx.tx((tx) =>
        searchDrugs(tx, ctx.auth.facilityId, input.encounterId, {
          q: input.q,
          form: input.form ?? null,
        }),
      ),
    ),
  ),

  /** Lab tests, USG procedures and procedures to order (Orders tab search). */
  searchOrders: transcribe
    .input(orderSearchSchema)
    .query(({ ctx, input }) => ctx.tx((tx) => searchOrderables(tx, ctx.auth.facilityId, input.q))),

  /** Server copy of the draft (every 20 s, docs/01 §3). */
  saveDraft: transcribe
    .input(saveRxDraftSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          saveRxDraft(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),

  discardDraft: transcribe
    .input(encounterIdSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          discardRxDraft(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input.encounterId,
          ),
        ),
      ),
    ),

  /**
   * Photo of the paper Rx, compressed in the browser (≤ 1600 px, JPEG 0.8, docs/01 §2). The file
   * is written to the files volume, then registered; a failed registration removes the file.
   */
  attachScan: transcribe.input(attachRxScanSchema).mutation(async ({ ctx, input }) => {
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (bytes.byteLength > MAX_UPLOAD_BYTES)
      throw appError('BAD_REQUEST', 'errors.rx.scanTooLarge');
    if (!isJpeg(bytes)) throw appError('BAD_REQUEST', 'errors.rx.scanInvalid');
    const root = filesDirFromEnv();
    const now = ctx.now();
    const file = await storeFile(root, ctx.auth.facilityId, 'jpg', bytes, now);
    try {
      return await mapped(() =>
        ctx.tx((tx) =>
          attachRxScan(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            { encounterId: input.encounterId, replacesDocumentId: input.replacesDocumentId, file },
            now,
          ),
        ),
      );
    } catch (err) {
      await removeFile(root, file.relPath);
      throw err;
    }
  }),

  /** Saves the transcription with its orders, note and follow-up (docs/11 §2.7). */
  save: transcribe.input(saveRxSchema).mutation(({ ctx, input }) => {
    if (input.orders.length > 0 || input.admission.advised) {
      requirePermission(ctx.auth, 'order.create');
    }
    return mapped(() =>
      ctx.tx((tx) =>
        saveRx(tx, { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId }, input, ctx.now()),
      ),
    );
  }),

  /** The doctor's verification queue: sampled transcriptions of their own patients. */
  verificationQueue: verify.query(({ ctx }) =>
    ctx.tx((tx) => rxVerificationQueue(tx, ctx.auth.facilityId, ctx.auth.userId)),
  ),

  /** "Verify": the typed Rx matches the paper. */
  verify: verify
    .input(verifyRxSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          verifyRx(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input.prescriptionId,
            ctx.now(),
          ),
        ),
      ),
    ),
});
