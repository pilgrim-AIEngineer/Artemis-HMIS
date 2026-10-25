import { findPrintCopy, nextCopyNo } from '@hmis/db';
import { findTemplateMeta, PrintPage } from '@hmis/print';
import { preparePrintDocument } from '@hmis/print/server';
import { uuidSchema } from '@hmis/shared';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { AutoPrint } from '@/components/print/auto-print';
import { PrintToolbar } from '@/components/print/print-toolbar';
import { getPageSession } from '@/server/auth/page-session';
import { getDb } from '@/server/db';

// Session- and print_log-dependent: never cached.
export const dynamic = 'force-dynamic';

const searchSchema = z.object({
  copy: z.coerce.number().int().min(1).max(10_000).optional(),
  embed: z.literal('1').optional(),
});

/**
 * `/print/[template]/[id]` (docs/01 §2, §4): the document exactly as it prints, drawn by the same
 * `PrintPage` the worker renders to PDF.
 * - without `copy`: a preview of the next print (it shows DUPLICATE if the document was printed
 *   before) with a toolbar; viewing never writes `print_log`;
 * - `?copy=N`: copy N that this user logged through `print.begin`; `&embed=1` (the hidden print
 *   frame) opens the print dialog on load.
 * The template's permission is checked here as well as in `print.begin`.
 */
export default async function PrintRoute({
  params,
  searchParams,
}: {
  params: Promise<{ template: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ template, id }, rawSearch] = await Promise.all([params, searchParams]);
  const auth = await getPageSession();
  if (!auth || auth.state !== 'active') redirect('/login');
  const meta = findTemplateMeta(template);
  const parsedId = uuidSchema.safeParse(id);
  const search = searchSchema.safeParse({
    copy: Array.isArray(rawSearch.copy) ? undefined : rawSearch.copy,
    embed: Array.isArray(rawSearch.embed) ? undefined : rawSearch.embed,
  });
  if (!meta || !parsedId.success || !search.success) notFound();
  if (!auth.permissions.has(meta.permission)) notFound();

  const db = getDb();
  const target = { facilityId: auth.facilityId, template: meta.key, entityId: parsedId.data };
  let copyNo: number;
  let printedAt = new Date();
  if (search.data.copy !== undefined) {
    const logged = await findPrintCopy(db, {
      ...target,
      userId: auth.userId,
      copyNo: search.data.copy,
    });
    if (!logged) notFound();
    copyNo = search.data.copy;
    printedAt = logged.printedAt;
  } else {
    copyNo = await nextCopyNo(db, target);
  }
  const doc = await preparePrintDocument({
    db,
    ...target,
    copyNo,
    printedAt,
    printedByName: auth.fullName,
  });
  if (!doc) notFound();

  const embed = search.data.embed === '1';
  const t = await getTranslations('print');
  const locale = await getLocale();
  return (
    <>
      {!embed && (
        <PrintToolbar
          template={meta.key}
          entityId={parsedId.data}
          title={t('title', { name: locale === 'hi' ? meta.title.hi : meta.title.en })}
          shownCopy={search.data.copy ?? null}
          nextCopy={copyNo}
        />
      )}
      <PrintPage doc={doc} />
      {embed && <AutoPrint />}
    </>
  );
}
