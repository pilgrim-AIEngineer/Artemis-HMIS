import { notFound } from 'next/navigation';
import { BillScreen } from '@/components/billing/bill-screen';
import { requirePagePermission } from '@/server/auth/page-session';

/** One bill (BIL-01, BIL-02). The procedures check `billing.*` again. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission('billing.bill.create');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <BillScreen billId={id} />;
}
