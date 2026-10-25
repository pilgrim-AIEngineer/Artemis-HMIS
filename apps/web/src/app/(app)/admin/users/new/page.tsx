import { NewUserForm } from '@/components/admin/user-editor';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function NewUserPage() {
  await requirePagePermission('admin.users.manage');
  return <NewUserForm />;
}
