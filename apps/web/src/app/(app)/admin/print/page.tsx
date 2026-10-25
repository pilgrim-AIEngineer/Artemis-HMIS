import { PrintSettings } from '@/components/admin/print-settings';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function PrintSettingsPage() {
  await requirePagePermission('admin.settings.manage');
  return <PrintSettings />;
}
