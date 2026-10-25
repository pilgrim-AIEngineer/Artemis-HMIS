import { createCallerFactory, router } from './init';
import { adminRouter } from './routers/admin';
import { authRouter } from './routers/auth';
import { healthRouter } from './routers/health';
import { printRouter } from './routers/print';

export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
  admin: adminRouter,
  print: printRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
