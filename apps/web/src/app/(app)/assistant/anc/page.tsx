import { AncDesk } from '@/components/anc/anc-desk';
import { requirePagePermission } from '@/server/auth/page-session';

/** ANC desk (OPD-05). Cosmetic guard; `anc.*` procedures check again (AGENTS.md rule 6). */
export default async function Page() {
  await requirePagePermission('patient.view');
  return <AncDesk />;
}
