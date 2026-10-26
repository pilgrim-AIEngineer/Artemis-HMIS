import { OwnerDashboard } from '@/components/reports/owner-dashboard';
import { requirePagePermission } from '@/server/auth/page-session';

/** Owner dashboard (RPT-02): read-only, phone first. The procedure checks the permission again. */
export default async function Page() {
  await requirePagePermission('reports.owner_dashboard');
  return <OwnerDashboard />;
}
