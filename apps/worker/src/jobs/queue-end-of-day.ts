import { runEndOfDayNoShow } from '@hmis/db';
import { z } from 'zod';
import { defineJob } from './types';

export const QUEUE_END_OF_DAY = 'queue.endOfDay';
/** 23:30 every day, hospital time (docs/10 §5: unseen tokens become no-show at end of day). */
export const QUEUE_END_OF_DAY_CRON = '30 23 * * *';

/** Marks every facility's unseen tokens of today as no-show, with a reason (REG-04). */
export const queueEndOfDayJob = defineJob({
  name: QUEUE_END_OF_DAY,
  schema: z.object({}).strict(),
  async handle(_data, { db, logger }) {
    const changed = await runEndOfDayNoShow(db, new Date());
    logger.info({ tokens: Object.values(changed).reduce((a, b) => a + b, 0) }, 'end of day done');
    return changed;
  },
});
