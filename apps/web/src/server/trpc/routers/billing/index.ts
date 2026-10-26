import {
  addBillLine,
  applyDiscount,
  billableServices,
  BillingInputError,
  billsForEncounter,
  cancellationReport,
  cancelFinalBill,
  clearDiscount,
  collectPayment,
  createOpdBill,
  discountReport,
  finalizeBill,
  getBillView,
  IdempotencyConflictError,
  loadUserAccess,
  pendingBills,
  readSetting,
  readSettings,
  removeBillLine,
  VisitInputError,
  voidDraftBill,
  type Db,
} from '@hmis/db';
import { ApprovalError, verifyApproverPin } from '@hmis/db/approvals';
import { reasonCode } from '@hmis/db/schema';
import {
  addBillLineSchema,
  adjustmentReportSchema,
  applyDiscountSchema,
  approverSchema,
  APPROVER_PERMISSION,
  billIdSchema,
  cancelBillSchema,
  clearDiscountSchema,
  collectPaymentSchema,
  createOpdBillSchema,
  effectiveDiscountLimit,
  finalizeBillSchema,
  istDateString,
  pendingBillsSchema,
  removeBillLineSchema,
  ROLE_KEYS,
  uuidSchema,
  voidDraftBillSchema,
  type RoleKey,
} from '@hmis/shared';
import { and, asc, eq } from 'drizzle-orm';
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
  'billing.discountNotFound',
  'billing.reasonNotFound',
  'visit.notFound',
]);
const CONFLICT = new Set<string>([
  'billing.notDraft',
  'billing.billCancelled',
  'billing.encounterNotOpen',
  'billing.nothingDue',
  'billing.belowPaid',
  'billing.notFinal',
  'billing.hasPayments',
  'billing.nothingToCredit',
  'visit.notOpen',
  'visit.tokenAlreadyIssued',
]);
const FORBIDDEN = new Set<string>([
  'billing.finalizeNotAllowed',
  'billing.approvalRequired',
  'billing.approverLimit',
  'billing.refundNotAllowed',
]);

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
    if (err instanceof ApprovalError) {
      const code =
        err.key === 'approval.locked'
          ? 'TOO_MANY_REQUESTS'
          : err.key === 'approval.notAuthorised'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST';
      throw appError(code, `errors.${err.key}`, err.params);
    }
    if (err instanceof IdempotencyConflictError) {
      throw appError('CONFLICT', 'errors.idempotency.conflict');
    }
    throw err;
  }
}

const discount = protectedProcedure.meta({ permission: 'billing.discount.apply' });
const cancel = protectedProcedure.meta({ permission: 'billing.bill.cancel' });
const financialReport = protectedProcedure.meta({ permission: 'reports.financial' });

const approverInput = z.object({ approver: approverSchema.optional() });
const roleKeys: readonly string[] = ROLE_KEYS;

/**
 * Checks the supervisor's username + PIN typed on the requester's screen, in a transaction of its
 * own so a wrong PIN still counts towards the lockout when the money transaction fails. Null when
 * no approver was given (the db layer then asks for one only if the amount needs it).
 */
async function verifiedApprover(
  ctx: { db: () => Db; auth: { facilityId: string; userId: string }; now: () => Date },
  approver: z.infer<typeof approverSchema> | undefined,
): Promise<string | null> {
  if (!approver) return null;
  return mapped(() =>
    verifyApproverPin(
      ctx.db(),
      {
        facilityId: ctx.auth.facilityId,
        requesterId: ctx.auth.userId,
        username: approver.username,
        pin: approver.pin,
      },
      ctx.now(),
    ),
  );
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

  /** Limits and thresholds the discount / cancel dialogs show before asking for an approver. */
  adjustmentSettings: create.query(async ({ ctx }) => {
    const [cfg, access] = await Promise.all([
      readSettings(ctx.db(), ctx.auth.facilityId, [
        'billing.discountLimits',
        'billing.cancelApprovalAbovePaise',
        'billing.refundApprovalAbovePaise',
      ]),
      loadUserAccess(ctx.db(), ctx.auth.userId),
    ]);
    const roles = access.roles.filter((r): r is RoleKey => roleKeys.includes(r));
    return {
      discountLimit: effectiveDiscountLimit(cfg['billing.discountLimits'], roles),
      cancelApprovalAbovePaise: cfg['billing.cancelApprovalAbovePaise'],
      refundApprovalAbovePaise: cfg['billing.refundApprovalAbovePaise'],
      canApprove: access.permissions.includes(APPROVER_PERMISSION),
    };
  }),

  /** Active reason codes of a kind for the discount / cancel pick lists. */
  reasons: create
    .input(z.object({ kind: z.enum(['discount', 'cancel']) }))
    .query(({ ctx, input }) =>
      ctx
        .db()
        .select({
          id: reasonCode.id,
          code: reasonCode.code,
          label: reasonCode.label,
          labelHi: reasonCode.labelHi,
        })
        .from(reasonCode)
        .where(
          and(
            eq(reasonCode.facilityId, ctx.auth.facilityId),
            eq(reasonCode.kind, input.kind),
            eq(reasonCode.status, 'active'),
            eq(reasonCode.isActive, true),
          ),
        )
        .orderBy(asc(reasonCode.label)),
    ),

  /**
   * BIL-03: discount on a draft's line or whole bill. Above the role limit the answer is
   * `errors.billing.approvalRequired` until a supervisor's username + PIN come with the request.
   */
  applyDiscount: discount
    .input(applyDiscountSchema.and(approverInput))
    .mutation(async ({ ctx, input }) => {
      const { approver, ...request } = input;
      const approverId = await verifiedApprover(ctx, approver);
      return mapped(() =>
        ctx.tx((tx) =>
          applyDiscount(
            tx,
            {
              facilityId: ctx.auth.facilityId,
              userId: ctx.auth.userId,
              workstationId: ctx.auth.workstationId,
            },
            request,
            ctx.now(),
            { approverId },
          ),
        ),
      );
    }),

  clearDiscount: discount
    .input(clearDiscountSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          clearDiscount(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),

  /** An unpaid draft is voided (status cancelled, reason kept). */
  voidDraft: cancel
    .input(voidDraftBillSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          voidDraftBill(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),

  /**
   * BIL-04: credit note against a final bill (full = the bill is cancelled), with the refund of
   * the money no longer owed. The refund needs `billing.refund.create` (checked in the db layer
   * because a credit that returns nothing does not need it).
   */
  cancelBill: cancel.input(cancelBillSchema.and(approverInput)).mutation(async ({ ctx, input }) => {
    const { approver, ...request } = input;
    const approverId = await verifiedApprover(ctx, approver);
    return mapped(() =>
      ctx.tx((tx) =>
        cancelFinalBill(
          tx,
          {
            facilityId: ctx.auth.facilityId,
            userId: ctx.auth.userId,
            workstationId: ctx.auth.workstationId,
          },
          request,
          ctx.now(),
          { approverId },
        ),
      ),
    );
  }),

  /** Report hooks for the owner (docs/12 §4–5): discounts given and cancellations with refunds. */
  discountReport: financialReport
    .input(adjustmentReportSchema)
    .query(({ ctx, input }) => discountReport(ctx.db(), ctx.auth.facilityId, input)),

  cancellationReport: financialReport
    .input(adjustmentReportSchema)
    .query(({ ctx, input }) => cancellationReport(ctx.db(), ctx.auth.facilityId, input)),
});
