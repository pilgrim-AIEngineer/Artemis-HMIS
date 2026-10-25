import { FacilityForm } from '@/components/admin/facility-form';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function FacilityPage() {
  await requirePagePermission('admin.settings.manage');
  return <FacilityForm />;
}
