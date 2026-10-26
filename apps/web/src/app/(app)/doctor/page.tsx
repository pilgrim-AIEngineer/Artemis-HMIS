import { Button } from '@hmis/ui/components/button';
import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { QueueBoard } from '@/components/queue/queue-board';
import { requirePagePermission } from '@/server/auth/page-session';

/** Doctor home: the doctor room's queue (REG-04) and the Rx verification queue (OPD-02). */
export default async function Page() {
  const auth = await requirePagePermission('patient.view');
  const t = await getTranslations('rx.verify');
  return (
    <div className="space-y-6">
      {auth.permissions.has('rx.verify') && (
        <div className="flex justify-end">
          <Button asChild size="lg" variant="outline">
            <Link href="/doctor/verify">
              <ClipboardCheck aria-hidden />
              {t('title')}
            </Link>
          </Button>
        </div>
      )}
      <QueueBoard mode="room" />
    </div>
  );
}
