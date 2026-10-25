import { MASTER_KINDS, MASTER_KIND_PERMISSION, type MasterKind } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { MasterList } from '@/components/masters/master-list';
import { MastersNav } from '@/components/masters/masters-nav';
import { requirePagePermission } from '@/server/auth/page-session';

const isKind = (v: string): v is MasterKind => (MASTER_KINDS as readonly string[]).includes(v);

export default async function MasterKindPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!isKind(kind)) notFound();
  const auth = await requirePagePermission(MASTER_KIND_PERMISSION[kind]);
  return (
    <div className="space-y-5">
      <MastersNav permissions={auth.permissions} current={kind} />
      <MasterList kind={kind} />
    </div>
  );
}
