import { nextCopyNo, recordPrint } from '@hmis/db';
import { findTemplateMeta } from '@hmis/print';
import { printEntityExists } from '@hmis/print/server';
import { uuidSchema } from '@hmis/shared';
import { z } from 'zod';
import { appError, protectedProcedure, requirePermission, router } from '../init';

/**
 * Printing (docs/01 §4). `begin` is what the Print button calls: it checks the template's own
 * permission, appends the `print_log` row and returns the copy number the print page draws
 * (copy > 1 → DUPLICATE). The browser then prints `/print/<template>/<id>?copy=<n>`.
 */
export const printRouter = router({
  begin: protectedProcedure
    .meta({ permission: 'session' })
    .input(z.object({ template: z.string().min(1).max(80), entityId: uuidSchema }))
    .mutation(async ({ ctx, input }) => {
      const meta = findTemplateMeta(input.template);
      if (!meta) throw appError('NOT_FOUND', 'errors.notFound');
      requirePermission(ctx.auth, meta.permission);
      const target = {
        facilityId: ctx.auth.facilityId,
        template: meta.key,
        entityId: input.entityId,
      };
      if (!(await printEntityExists({ db: ctx.db(), ...target }))) {
        throw appError('NOT_FOUND', 'errors.notFound');
      }
      return ctx.tx((tx) =>
        recordPrint(tx, {
          ...target,
          entity: meta.entity,
          userId: ctx.auth.userId,
          workstationId: ctx.auth.workstationId,
        }),
      );
    }),

  /** The copy number the next print of a document would get (for the preview's DUPLICATE mark). */
  nextCopy: protectedProcedure
    .meta({ permission: 'session' })
    .input(z.object({ template: z.string().min(1).max(80), entityId: uuidSchema }))
    .query(async ({ ctx, input }) => {
      const meta = findTemplateMeta(input.template);
      if (!meta) throw appError('NOT_FOUND', 'errors.notFound');
      requirePermission(ctx.auth, meta.permission);
      return {
        copyNo: await nextCopyNo(ctx.db(), {
          facilityId: ctx.auth.facilityId,
          template: meta.key,
          entityId: input.entityId,
        }),
      };
    }),
});
