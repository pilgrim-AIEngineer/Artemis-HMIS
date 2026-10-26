import { isReportKey, REPORT_PERMISSION, type ReportKey } from '@hmis/shared';
import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import { AdjustmentsReport } from '@/components/reports/adjustments-report';
import { AncReport } from '@/components/reports/anc-report';
import { CollectionReport } from '@/components/reports/collection-report';
import { OpdReport } from '@/components/reports/opd-report';
import { VaccinesReport } from '@/components/reports/vaccines-report';
import { requirePagePermission } from '@/server/auth/page-session';

const REPORTS: Record<ReportKey, () => ReactElement> = {
  collection: () => <CollectionReport />,
  opd: () => <OpdReport />,
  anc: () => <AncReport />,
  vaccines: () => <VaccinesReport />,
  adjustments: () => <AdjustmentsReport />,
};

/** One report (RPT-01). Cosmetic guard: the procedures behind it check the permission again. */
export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!isReportKey(key)) notFound();
  await requirePagePermission(REPORT_PERMISSION[key]);
  return REPORTS[key]();
}
