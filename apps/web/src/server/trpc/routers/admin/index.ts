import { router } from '../../init';
import { facilityProcedures } from './facility';
import { roleProcedures } from './roles';
import { settingsProcedures } from './settings';
import { userProcedures } from './users';
import { workstationProcedures } from './workstations';

/** FND-03: users, roles, sessions, workstation pairing. FND-06: facility profile, settings. */
export const adminRouter = router({
  ...userProcedures,
  ...roleProcedures,
  ...workstationProcedures,
  ...facilityProcedures,
  ...settingsProcedures,
});
