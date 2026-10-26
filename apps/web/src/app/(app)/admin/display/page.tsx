import { DisplayLink } from '@/components/admin/display-link';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function DisplayLinkPage() {
  await requirePagePermission('queue.display.manage');
  return <DisplayLink />;
}
