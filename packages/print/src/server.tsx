/**
 * Server side of printing (web print route and worker `pdf.render`): loads the facility header
 * and the template's data from the database and assembles a `PrintDocument`. Import from
 * `@hmis/print/server`; the client-safe pieces are in `@hmis/print`.
 */
import { readSettings, type Db, type Tx } from '@hmis/db';
import { facility } from '@hmis/db/schema';
import { eq } from 'drizzle-orm';
import type { ReactNode } from 'react';
import { L } from './labels';
import { initials, qrSvg } from './doc-utils';
import { SampleDocument } from './templates/sample';
import { findTemplateMeta, PRINT_TEMPLATE_METAS } from './templates/meta';
import type { PrintDocument, PrintHeaderData, PrintMeta, PrintTemplateMeta } from './types';

type Queryable = Db | Tx;

export interface LoadContext {
  db: Queryable;
  facilityId: string;
  entityId: string;
}

/** Server-side half of a template: loads its data (null = entity not found) and draws the body. */
interface TemplateImpl<D> {
  meta: PrintTemplateMeta;
  load(ctx: LoadContext): Promise<D | null>;
  body(data: D, meta: PrintMeta): ReactNode;
}

const impl = <D,>(t: TemplateImpl<D>) => t as unknown as TemplateImpl<unknown>;

/** The sample's entity is the facility itself (`/print/sample-a4/<facility id>`). */
const sampleTemplates = PRINT_TEMPLATE_METAS.filter((t) => t.key.startsWith('sample-')).map(
  (meta) =>
    impl({
      meta,
      load: ({ facilityId, entityId }) =>
        Promise.resolve(entityId === facilityId ? { ref: entityId.slice(-8).toUpperCase() } : null),
      body: (data: { ref: string }, pm: PrintMeta) => (
        <SampleDocument paper={meta.paper} data={data} meta={pm} />
      ),
    }),
);

const IMPLS = new Map<string, TemplateImpl<unknown>>(sampleTemplates.map((t) => [t.meta.key, t]));

/** Facility profile + `print.header` + `ui.accentColor`, shaped for the header component. */
export async function loadPrintHeader(q: Queryable, facilityId: string): Promise<PrintHeaderData> {
  const [f] = await q.select().from(facility).where(eq(facility.id, facilityId)).limit(1);
  const s = await readSettings(q, facilityId, ['print.header', 'ui.accentColor']);
  const h = s['print.header'];
  const addressEn = [f?.address, f?.district, f?.state, f?.pincode].filter(Boolean).join(', ');
  const regs: PrintHeaderData['registrationNos'] = [];
  if (h.showRegistrationNos) {
    if (f?.clinicalEstablishmentRegNo) {
      regs.push({ label: L.clinicalEstablishmentRegNo, value: f.clinicalEstablishmentRegNo });
    }
    if (f?.gstin) regs.push({ label: L.gstin, value: f.gstin });
  }
  return {
    nameEn: f?.name ?? '',
    nameHi: h.nameHi,
    taglineEn: h.taglineEn,
    taglineHi: h.taglineHi,
    addressEn,
    addressHi: h.addressHi,
    phone: f?.phone ?? '',
    email: f?.email ?? '',
    registrationNos: regs,
    footerNoteEn: h.footerNoteEn,
    footerNoteHi: h.footerNoteHi,
    accent: s['ui.accentColor'],
  };
}

export const getTemplateMeta = findTemplateMeta;

/** True when `entityId` is something this template can print for the facility. */
export async function printEntityExists(
  input: Pick<PrepareInput, 'db' | 'facilityId' | 'template' | 'entityId'>,
): Promise<boolean> {
  const t = IMPLS.get(input.template);
  if (!t) return false;
  return (
    (await t.load({ db: input.db, facilityId: input.facilityId, entityId: input.entityId })) !==
    null
  );
}

export interface PrepareInput {
  db: Queryable;
  facilityId: string;
  template: string;
  entityId: string;
  copyNo: number;
  printedAt: Date;
  printedByName: string;
}

/**
 * Builds the document for one print, or null when the template or entity does not exist (for
 * this facility). Permission checks and `print_log` are the caller's job.
 */
export async function preparePrintDocument(input: PrepareInput): Promise<PrintDocument | null> {
  const t = IMPLS.get(input.template);
  if (!t) return null;
  const data = await t.load({
    db: input.db,
    facilityId: input.facilityId,
    entityId: input.entityId,
  });
  if (data === null) return null;
  const header = await loadPrintHeader(input.db, input.facilityId);
  const meta: PrintMeta = {
    copyNo: input.copyNo,
    printedAt: input.printedAt,
    printedBy: initials(input.printedByName),
    docRef: input.entityId,
    qrSvg: await qrSvg(input.entityId),
  };
  return { template: t.meta, header, meta, body: t.body(data, meta) };
}
