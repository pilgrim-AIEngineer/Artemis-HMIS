import { RoleMatrix } from '@/components/admin/role-matrix';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function RolesPage() {
  await requirePagePermission('admin.roles.manage');
  return <RoleMatrix />;
}
