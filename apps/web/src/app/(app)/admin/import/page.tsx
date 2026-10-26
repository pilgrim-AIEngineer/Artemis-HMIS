import { ImportStart } from '@/components/admin/import-start';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function ImportPage() {
  await requirePagePermission('admin.import.run');
  return <ImportStart />;
}
