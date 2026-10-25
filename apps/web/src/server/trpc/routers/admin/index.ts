import { router } from '../../init';
import { roleProcedures } from './roles';
import { userProcedures } from './users';
import { workstationProcedures } from './workstations';

/** FND-03: users, roles and the permission matrix, sessions, workstation pairing. */
export const adminRouter = router({
  ...userProcedures,
  ...roleProcedures,
  ...workstationProcedures,
});
