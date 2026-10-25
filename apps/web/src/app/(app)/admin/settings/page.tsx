import { SettingsEditor } from '@/components/admin/settings-editor';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function SettingsPage() {
  await requirePagePermission('admin.settings.manage');
  return <SettingsEditor />;
}
