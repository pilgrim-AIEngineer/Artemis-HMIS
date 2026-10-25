import { MasterList } from '@/components/masters/master-list';
import { MastersNav } from '@/components/masters/masters-nav';
import { requirePagePermission } from '@/server/auth/page-session';

/** Static sibling of `[kind]` so that `/tariffs/<id>` (rates) can sit beneath it. */
export default async function TariffsPage() {
  const auth = await requirePagePermission('admin.tariff.manage');
  return (
    <div className="space-y-5">
      <MastersNav permissions={auth.permissions} current="tariffs" />
      <MasterList kind="tariffs" />
    </div>
  );
}
