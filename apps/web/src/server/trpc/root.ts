import { createCallerFactory, router } from './init';
import { adminRouter } from './routers/admin';
import { ancRouter } from './routers/anc';
import { authRouter } from './routers/auth';
import { billingRouter } from './routers/billing';
import { dayCloseRouter } from './routers/billing/day-close';
import { healthRouter } from './routers/health';
import { mastersRouter } from './routers/masters';
import { patientsRouter } from './routers/patients';
import { printRouter } from './routers/print';
import { queueRouter } from './routers/queue';
import { rxRouter } from './routers/rx';
import { visitsRouter } from './routers/visits';
import { vitalsRouter } from './routers/vitals';

export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
  admin: adminRouter,
  masters: mastersRouter,
  patients: patientsRouter,
  print: printRouter,
  visit: visitsRouter,
  queue: queueRouter,
  vitals: vitalsRouter,
  anc: ancRouter,
  rx: rxRouter,
  billing: billingRouter,
  dayClose: dayCloseRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
