import {
  addBillLine,
  billableServices,
  BillingInputError,
  billsForEncounter,
  collectPayment,
  createOpdBill,
  finalizeBill,
  getBillView,
  IdempotencyConflictError,
  pendingBills,
  readSetting,
  readSettings,
  removeBillLine,
  VisitInputError,
} from '@hmis/db';
import {
  addBillLineSchema,
  billIdSchema,
  collectPaymentSchema,
  createOpdBillSchema,
  finalizeBillSchema,
  istDateString,
  pendingBillsSchema,
  removeBillLineSchema,
  uuidSchema,
} from '@hmis/shared';
import { z } from 'zod';
import { appError, protectedProcedure, router } from '../../init';

/** Draft bills: open, view, add and remove lines (docs/03: reception and cashier). */
const create = protectedProcedure.meta({ permission: 'billing.bill.create' });
const finalize = protectedProcedure.meta({ permission: 'billing.bill.finalize' });
const collect = protectedProcedure.meta({ permission: 'billing.payment.collect' });

const NOT_FOUND = new Set<string>([
  'billing.billNotFound',
  'billing.lineNotFound',
  'billing.encounterNotFound',
  'billing.serviceNotFound',
  'visit.notFound',
]);
const CONFLICT = new Set<string>([
  'billing.notDraft',
  'billing.billCancelled',
  'billing.encounterNotOpen',
  'billing.nothingDue',
  'billing.belowPaid',
  'visit.notOpen',
  'visit.tokenAlreadyIssued',
]);
const FORBIDDEN = new Set<string>(['billing.finalizeNotAllowed']);

/** Domain errors from the db layer become i18n message keys (docs/02 §7). */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BillingInputError || err instanceof VisitInputError) {
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

export const billingRouter = router({
  /** Billing desk worklist: drafts with something to pay and final bills with a balance. */
  pending: create
    .input(pendingBillsSchema)
    .query(({ ctx, input }) => pendingBills(ctx.db(), ctx.auth.facilityId, { q: input.q })),

  get: create.input(billIdSchema).query(async ({ ctx, input }) => {
    const b = await getBillView(ctx.db(), ctx.auth.facilityId, input.billId);
    if (!b) throw appError('NOT_FOUND', 'errors.billing.billNotFound');
    return b;
  }),

  /** Bills of a visit (patient page → bill). */
  forEncounter: create
    .input(z.object({ encounterId: uuidSchema }))
    .query(({ ctx, input }) => billsForEncounter(ctx.db(), ctx.auth.facilityId, input.encounterId)),

  /** "Add service": active services with their rate in the bill's tariff today (null = no rate). */
  services: create
    .input(z.object({ billId: uuidSchema, q: z.string().trim().max(60).default('') }))
    .query(async ({ ctx, input }) => {
      const out = await billableServices(ctx.db(), ctx.auth.facilityId, {
        billId: input.billId,
        q: input.q,
        on: istDateString(ctx.now()),
      });
      if (!out) throw appError('NOT_FOUND', 'errors.billing.billNotFound');
      return out;
    }),

  createOpdBill: create
    .input(createOpdBillSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          createOpdBill(tx, { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId }, input),
        ),
      ),
    ),

  addLine: create
    .input(addBillLineSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          addBillLine(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),

  removeLine: create
    .input(removeBillLineSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          removeBillLine(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),

  finalize: finalize
    .input(finalizeBillSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          finalizeBill(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),

  /** Settings the payment dialog needs (UPI reference rule). */
  paymentSettings: collect.query(async ({ ctx }) => {
    const s = await readSettings(ctx.db(), ctx.auth.facilityId, [
      'billing.upiRefRequired',
      'billing.allowOpdCredit',
    ]);
    return { upiRef: s['billing.upiRefRequired'], allowOpdCredit: s['billing.allowOpdCredit'] };
  }),

  /**
   * Cash / UPI / card / split (BIL-02). Settling a draft finalises it, which also needs
   * `billing.bill.finalize`. `printSheet`: the payment released the token and
   * `opd.sheetPrintAt` = `reception`, so the OPD sheet prints now.
   */
  collect: collect.input(collectPaymentSchema).mutation(({ ctx, input }) =>
    mapped(() =>
      ctx.tx(async (tx) => {
        const r = await collectPayment(
          tx,
          {
            facilityId: ctx.auth.facilityId,
            userId: ctx.auth.userId,
            workstationId: ctx.auth.workstationId,
          },
          input,
          ctx.now(),
          { mayFinalize: ctx.auth.permissions.has('billing.bill.finalize') },
        );
        const printSheet =
          r.tokenNo !== null &&
          (await readSetting(tx, ctx.auth.facilityId, 'opd.sheetPrintAt')) === 'reception';
        return { ...r, printSheet };
      }),
    ),
  ),
});
