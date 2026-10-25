import { uuidSchema } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { EditUser } from '@/components/admin/user-editor';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission('admin.users.manage');
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) notFound();
  return <EditUser userId={id.data} />;
}
