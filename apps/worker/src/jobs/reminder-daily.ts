import { queueDailyRemindersAll } from '@hmis/db';
import { z } from 'zod';
import { defineJob } from './types';

export const REMINDER_DAILY_QUEUE = 'reminder.daily';
/** 19:00 every day, hospital time (docs/01 §2). */
export const REMINDER_DAILY_CRON = '0 19 * * *';

/** Queues tomorrow morning's follow-up, ANC and vaccine reminders into the outbox (MSG-01). */
export const reminderDailyJob = defineJob({
  name: REMINDER_DAILY_QUEUE,
  schema: z.object({}).strict(),
  async handle(_data, { db, logger }) {
    const run = await queueDailyRemindersAll(db, new Date());
    logger.info({ facilities: Object.keys(run).length }, 'daily reminders queued');
    return run;
  },
});
