import { createCallerFactory, router } from './init';
import { adminRouter } from './routers/admin';
import { authRouter } from './routers/auth';
import { healthRouter } from './routers/health';
import { mastersRouter } from './routers/masters';
import { printRouter } from './routers/print';

export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
  admin: adminRouter,
  masters: mastersRouter,
  print: printRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
