import { noopJob } from './noop';
import { opsBackupCheckJob } from './ops-backup-check';
import { opsHealthPingJob } from './ops-health-ping';
import { outboxWhatsappJob } from './outbox-whatsapp';
import { pdfRenderJob } from './pdf-render';
import { queueEndOfDayJob } from './queue-end-of-day';
import { reminderDailyJob } from './reminder-daily';
import type { JobDefinition } from './types';

export const JOBS: readonly JobDefinition[] = [
  noopJob,
  pdfRenderJob,
  queueEndOfDayJob,
  outboxWhatsappJob,
  reminderDailyJob,
  opsBackupCheckJob,
  opsHealthPingJob,
];
