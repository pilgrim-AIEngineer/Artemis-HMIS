import { noopJob } from './noop';
import { pdfRenderJob } from './pdf-render';
import type { JobDefinition } from './types';

export const JOBS: readonly JobDefinition[] = [noopJob, pdfRenderJob];
