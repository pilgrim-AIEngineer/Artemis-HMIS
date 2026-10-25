import { canSeeGroup, type RouteGroup } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/server/auth/page-session';

/**
 * Landing page of a role home route group (docs/01 §2). Each module adds its action tiles here
 * when it ships; until then the page says so plainly. Cosmetic guard: no permission → 404 (the
 * procedures behind the future tiles enforce permissions themselves).
 */
export async function GroupHome({ group }: { group: RouteGroup }) {
  const auth = await requirePageSession();
  if (!canSeeGroup(group, auth.permissions)) notFound();
  const t = await getTranslations('groups');
  const tNav = await getTranslations('nav.groups');
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{tNav(group)}</h1>
        <p className="text-lg text-muted-foreground">{t(`${group}.hint`)}</p>
      </div>
      <p className="max-w-3xl rounded-lg border-2 bg-card p-6 text-lg">{t('comingSoon')}</p>
    </div>
  );
}
