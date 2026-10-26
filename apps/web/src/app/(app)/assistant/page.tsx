import { QueueBoard } from '@/components/queue/queue-board';
import { requirePagePermission } from '@/server/auth/page-session';

/** Assistant home: the doctor room's queue (REG-04); the transcription list joins in OPD-02. */
export default async function Page() {
  await requirePagePermission('patient.view');
  return <QueueBoard mode="room" />;
}
