import { Button } from '@hmis/ui/components/button';
import { NotebookPen } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { QueueBoard } from '@/components/queue/queue-board';
import { ScanToOpen } from '@/components/rx/transcription-list';
import { requirePagePermission } from '@/server/auth/page-session';

/**
 * Assistant home: the doctor room's queue (REG-04) with the Rx transcription entry on top
 * (OPD-02): scan the OPD sheet's QR, or open the "Seen — to transcribe" list.
 */
export default async function Page() {
  const auth = await requirePagePermission('patient.view');
  const t = await getTranslations('rx');
  return (
    <div className="space-y-6">
      {auth.permissions.has('rx.transcribe') && (
        <section
          aria-label={t('list.title')}
          className="flex flex-wrap items-end justify-between gap-4 rounded-lg border-2 bg-card p-4"
        >
          <div className="min-w-72 flex-1">
            <ScanToOpen />
          </div>
          <Button asChild size="lg">
            <Link href="/assistant/rx">
              <NotebookPen aria-hidden />
              {t('list.title')}
            </Link>
          </Button>
        </section>
      )}
      <QueueBoard mode="room" />
    </div>
  );
}
