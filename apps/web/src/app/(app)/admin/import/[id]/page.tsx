import { uuidSchema } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { ImportReview } from '@/components/admin/import-review';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function ImportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission('admin.import.run');
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) notFound();
  return <ImportReview batchId={id.data} />;
}
