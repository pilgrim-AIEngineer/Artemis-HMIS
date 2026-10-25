import { MASTER_KINDS, MASTER_KIND_PERMISSION, type Permission } from '@hmis/shared';
import { cn } from '@hmis/ui/lib/utils';
import Link from 'next/link';
import { getMastersT } from '@/lib/masters-t';

/** Tabs across the master lists; only those the user may open (cosmetic, procedures re-check). */
export async function MastersNav({
  permissions,
  current,
}: {
  permissions: ReadonlySet<Permission>;
  current?: string;
}) {
  const t = await getMastersT();
  const kinds = MASTER_KINDS.filter((k) => permissions.has(MASTER_KIND_PERMISSION[k]));
  return (
    <nav aria-label={t('title')} className="-mt-2">
      <ul className="flex flex-wrap gap-1">
        {kinds.map((k) => (
          <li key={k}>
            <Link
              href={`/admin/masters/${k}`}
              aria-current={k === current ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center rounded-md px-3 text-base font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/60',
                k === current &&
                  'bg-secondary text-secondary-foreground underline decoration-2 underline-offset-8',
              )}
            >
              {t(`kinds.${k}.title`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
