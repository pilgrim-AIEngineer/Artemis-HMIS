import { noopJob } from './noop';
import type { JobDefinition } from './types';

export const JOBS: readonly JobDefinition[] = [noopJob];
