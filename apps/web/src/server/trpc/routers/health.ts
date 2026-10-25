import { healthStatusSchema } from '@hmis/shared';
import { getHealth } from '../../health';
import { publicProcedure, router } from '../init';

export const healthRouter = router({
  check: publicProcedure
    .meta({ permission: 'public' })
    .output(healthStatusSchema)
    .query(({ ctx }) => getHealth(ctx.db)),
});
