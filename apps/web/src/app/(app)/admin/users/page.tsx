import { UserList } from '@/components/admin/user-list';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function UsersPage() {
  await requirePagePermission('admin.users.manage');
  return <UserList />;
}
