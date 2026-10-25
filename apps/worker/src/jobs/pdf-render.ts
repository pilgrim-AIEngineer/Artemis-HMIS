import { loadUserAccess, nextCopyNo, recordPrint, withTx } from '@hmis/db';
import { appUser, document } from '@hmis/db/schema';
import { embeddedFontCss } from '@hmis/print/node';
import { renderPrintHtml } from '@hmis/print/render';
import { getTemplateMeta, preparePrintDocument } from '@hmis/print/server';
import { uuidSchema } from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { removeFile, storeFile } from '../files';
import { countPdfPages, renderPdf } from '../pdf';
import { defineJob } from './types';

export const PDF_RENDER_QUEUE = 'pdf.render';

/**
 * Renders a print template to PDF (docs/01 §2): the same React template and fonts as the browser
 * print, drawn by headless Chromium, stored under `/data/files` and registered in `document`.
 * The enqueuing procedure has already checked the requester's permission; it is re-checked here.
 * `documentId` is chosen by the caller, so a retried or duplicated job returns the first result
 * instead of printing (and logging a copy) twice.
 */
export const pdfRenderJob = defineJob({
  name: PDF_RENDER_QUEUE,
  schema: z
    .object({
      facilityId: uuidSchema,
      template: z.string().min(1).max(80),
      entityId: uuidSchema,
      requestedBy: uuidSchema,
      documentId: uuidSchema,
      workstationId: uuidSchema.optional(),
    })
    .strict(),
  async handle(data, { db, filesDir, logger }) {
    const [existing] = await db
      .select({ id: document.id })
      .from(document)
      .where(and(eq(document.id, data.documentId), eq(document.facilityId, data.facilityId)));
    if (existing) return { documentId: existing.id, reused: true };

    const meta = getTemplateMeta(data.template);
    if (!meta) throw new Error(`unknown print template ${data.template}`);
    const [user] = await db
      .select({ fullName: appUser.fullName, isActive: appUser.isActive })
      .from(appUser)
      .where(and(eq(appUser.id, data.requestedBy), eq(appUser.facilityId, data.facilityId)));
    if (!user?.isActive) throw new Error('requesting user is not active in this facility');
    const access = await loadUserAccess(db, data.requestedBy);
    if (!access.permissions.includes(meta.permission)) {
      throw new Error(`requesting user lacks ${meta.permission}`);
    }

    const target = {
      facilityId: data.facilityId,
      template: data.template,
      entityId: data.entityId,
    };
    const copyNo = await nextCopyNo(db, target);
    const now = new Date();
    const doc = await preparePrintDocument({
      db,
      ...target,
      copyNo,
      printedAt: now,
      printedByName: user.fullName,
    });
    if (!doc) throw new Error(`nothing to print for ${data.template}`);

    const pdf = await renderPdf(renderPrintHtml(doc, embeddedFontCss()), meta.paper);
    const file = await storeFile(filesDir, data.facilityId, 'pdf', pdf, now);
    try {
      await withTx(
        {
          db,
          userId: data.requestedBy,
          facilityId: data.facilityId,
          workstationId: data.workstationId ?? null,
        },
        async (tx) => {
          const logged = await recordPrint(tx, {
            ...target,
            entity: meta.entity,
            userId: data.requestedBy,
            workstationId: data.workstationId ?? null,
          });
          // Another print slipped in while rendering: the DUPLICATE mark would be wrong. Retry.
          if (logged.copyNo !== copyNo) throw new Error('copy number changed while rendering');
          await tx.insert(document).values({
            id: data.documentId,
            facilityId: data.facilityId,
            kind: 'report_pdf',
            entity: meta.entity,
            entityId: data.entityId,
            filePath: file.relPath,
            mime: 'application/pdf',
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            pages: countPdfPages(pdf),
          });
        },
      );
    } catch (err) {
      await removeFile(filesDir, file.relPath);
      throw err;
    }
    logger.info({ documentId: data.documentId, template: data.template, copyNo }, 'pdf rendered');
    return { documentId: data.documentId, copyNo };
  },
});
