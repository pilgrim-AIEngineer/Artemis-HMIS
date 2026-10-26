import { TranscriptionList } from '@/components/rx/transcription-list';
import { requirePagePermission } from '@/server/auth/page-session';

/** "Seen — to transcribe" list with the sheet-QR scan box (OPD-02). Cosmetic guard; rx.* checks. */
export default async function Page() {
  await requirePagePermission('rx.transcribe');
  return <TranscriptionList />;
}
