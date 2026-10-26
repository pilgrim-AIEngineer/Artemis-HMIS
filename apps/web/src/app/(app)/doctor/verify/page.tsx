import { VerificationQueue } from '@/components/rx/verification-queue';
import { requirePagePermission } from '@/server/auth/page-session';

/** The doctor's queue of typed prescriptions to check against the paper (OPD-02, Q15). */
export default async function Page() {
  await requirePagePermission('rx.verify');
  return <VerificationQueue />;
}
