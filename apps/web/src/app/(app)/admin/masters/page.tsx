import { MASTER_KINDS, MASTER_KIND_PERMISSION } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { getMastersT } from '@/lib/masters-t';
import { MASTER_DEFS } from '@/components/masters/definitions';
import { TileGrid } from '@/components/tile-grid';
import { requirePageSession } from '@/server/auth/page-session';

/** Master data hub: one big tile per list the user may manage (docs/05 §1.1). */
export default async function MastersHomePage() {
  const auth = await requirePageSession();
  const kinds = MASTER_KINDS.filter((k) => auth.permissions.has(MASTER_KIND_PERMISSION[k]));
  if (kinds.length === 0) notFound();
  const t = await getMastersT();
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <p className="max-w-3xl text-muted-foreground">{t('help.hub')}</p>
      </div>
      <TileGrid
        tiles={kinds.map((k) => ({
          href: `/admin/masters/${k}`,
          title: t(`kinds.${k}.title`),
          hint: t(`kinds.${k}.hint`),
          icon: MASTER_DEFS[k].icon,
        }))}
      />
    </div>
  );
}
