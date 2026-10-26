import {
  advanceToken,
  callNext,
  hasDisplayKey,
  markDone,
  markNoShow,
  markSeen,
  queueBoard,
  readSetting,
  recall,
  rotateDisplayKey,
  reinstate,
  sendIn,
  setPriority,
  skip,
  transfer,
} from '@hmis/db';
import {
  callNextSchema,
  noShowSchema,
  prioritySchema,
  queueBoardSchema,
  tokenIdSchema,
  transferSchema,
} from '@hmis/shared';
import { protectedProcedure, router } from '../../init';
import { mapped } from '../visits';

const view = protectedProcedure.meta({ permission: 'patient.view' });
/** Doctor-room actions: call next, send in, recall, skip, seen (docs/10 §5). */
const room = protectedProcedure.meta({ permission: 'queue.call' });
/** Desk actions: no-show, reinstate, transfer, priority. */
const desk = protectedProcedure.meta({ permission: 'queue.manage' });
/** The waiting-hall TV link (docs/03: `queue.display.manage`). */
const display = protectedProcedure.meta({ permission: 'queue.display.manage' });
/** Vitals desk (docs/10 §8). */
const vitals = protectedProcedure.meta({ permission: 'vitals.record' });

/** Updated token rows carry no patient data; the board re-reads through `queue.board`. */
const pick = <T extends { id: string; queueState: string; tokenNo: number }>(t: T) => ({
  id: t.id,
  tokenNo: t.tokenNo,
  queueState: t.queueState,
});

export const queueRouter = router({
  board: view
    .input(queueBoardSchema)
    .query(({ ctx, input }) =>
      ctx.tx((tx) => queueBoard(tx, ctx.auth.facilityId, input, ctx.now())),
    ),

  /** Whether a TV link exists. The key itself is never readable: only its hash is stored. */
  displayStatus: display.query(async ({ ctx }) => ({
    configured: await hasDisplayKey(ctx.db(), ctx.auth.facilityId),
  })),

  /**
   * Creates or replaces the TV link key and returns it once (REG-05). The old link stops
   * working immediately; the TV must be opened with the new one.
   */
  rotateDisplayKey: display.mutation(async ({ ctx }) => ({
    key: await ctx.tx((tx) => rotateDisplayKey(tx, ctx.auth.facilityId)),
  })),

  /**
   * Vitals taken: `waiting` → `vitals_done`. Saving the vitals themselves arrives with OPD-01,
   * which calls the same step. `printSheet` tells the screen to print the OPD sheet now
   * (`opd.sheetPrintAt` = `vitals`, the default, docs/10 §7).
   */
  vitalsDone: vitals.input(tokenIdSchema).mutation(({ ctx, input }) =>
    mapped(() =>
      ctx.tx(async (tx) => {
        const t = await advanceToken(tx, a(ctx), input.tokenId, 'vitals_done', ctx.now(), 'vitals');
        const at = await readSetting(tx, ctx.auth.facilityId, 'opd.sheetPrintAt');
        return { ...pick(t), encounterId: t.encounterId, printSheet: at === 'vitals' };
      }),
    ),
  ),

  callNext: room
    .input(callNextSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => callNext(tx, a(ctx), input.doctorId, ctx.now()).then(pick))),
    ),
  sendIn: room
    .input(tokenIdSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => sendIn(tx, a(ctx), input.tokenId, ctx.now()).then(pick))),
    ),
  recall: room
    .input(tokenIdSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => recall(tx, a(ctx), input.tokenId, ctx.now()).then(pick))),
    ),
  skip: room
    .input(tokenIdSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => skip(tx, a(ctx), input.tokenId, ctx.now()).then(pick))),
    ),
  markSeen: room
    .input(tokenIdSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => markSeen(tx, a(ctx), input.tokenId, ctx.now()).then(pick))),
    ),
  markDone: room
    .input(tokenIdSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => markDone(tx, a(ctx), input.tokenId, ctx.now()).then(pick))),
    ),

  markNoShow: desk
    .input(noShowSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) => markNoShow(tx, a(ctx), input.tokenId, input.reason, ctx.now()).then(pick)),
      ),
    ),
  reinstate: desk
    .input(tokenIdSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => reinstate(tx, a(ctx), input.tokenId, ctx.now()).then(pick))),
    ),
  transfer: desk
    .input(transferSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) => transfer(tx, a(ctx), input.tokenId, input.doctorId, ctx.now()).then(pick)),
      ),
    ),
  setPriority: desk
    .input(prioritySchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          setPriority(tx, a(ctx), input.tokenId, input.priority, ctx.now()).then(pick),
        ),
      ),
    ),
});

function a(ctx: { auth: { facilityId: string; userId: string } }) {
  return { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId };
}
