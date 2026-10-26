import { PaedsDesk } from '@/components/paeds/paeds-desk';
import { requirePagePermission } from '@/server/auth/page-session';

/** Paediatrics desk (OPD-06). Cosmetic guard; `paeds.*` procedures check again (AGENTS.md rule 6). */
export default async function Page() {
  await requirePagePermission('patient.view');
  return <PaedsDesk />;
}
