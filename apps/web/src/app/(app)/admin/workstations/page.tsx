import { WorkstationList } from '@/components/admin/workstation-list';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function WorkstationsPage() {
  await requirePagePermission('admin.settings.manage');
  return <WorkstationList />;
}
