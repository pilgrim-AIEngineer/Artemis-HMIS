import { canSeeGroup } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { PatientSearch } from '@/components/reception/patient-search';
import { requirePageSession } from '@/server/auth/page-session';

/** Reception home: patient search first (docs/05 §1.5). Cosmetic guard; procedures check again. */
export default async function Page() {
  const auth = await requirePageSession();
  if (!canSeeGroup('reception', auth.permissions)) notFound();
  return <PatientSearch canCreate={auth.permissions.has('patient.create')} />;
}
