import { QueueBoard } from '@/components/queue/queue-board';
import { requirePagePermission } from '@/server/auth/page-session';

/** Queue for reception and the vitals desk (REG-04). */
export default async function Page() {
  await requirePagePermission('patient.view');
  return <QueueBoard mode="desk" />;
}
