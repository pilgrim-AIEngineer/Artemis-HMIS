import { noopJob } from './noop';
import { pdfRenderJob } from './pdf-render';
import { queueEndOfDayJob } from './queue-end-of-day';
import type { JobDefinition } from './types';

export const JOBS: readonly JobDefinition[] = [noopJob, pdfRenderJob, queueEndOfDayJob];
