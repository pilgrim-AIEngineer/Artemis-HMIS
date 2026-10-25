import { formatDateTime } from '@hmis/shared';
import { L } from '../labels';
import type { PrintHeaderData, PrintMeta } from '../types';

/** QR of the document id, print time and user initials (docs/05 §6), plus the hospital's note. */
export function PrintFooter({ header, meta }: { header: PrintHeaderData; meta: PrintMeta }) {
  return (
    <footer className="print-footer">
      <div
        className="print-qr"
        role="img"
        aria-label="QR"
        dangerouslySetInnerHTML={{ __html: meta.qrSvg }}
      />
      <div className="print-footer-text">
        {header.footerNoteHi && <p>{header.footerNoteHi}</p>}
        {header.footerNoteEn && <p>{header.footerNoteEn}</p>}
        <p>
          {L.printedOn.hi} / {L.printedOn.en}: {formatDateTime(meta.printedAt)} {L.by.hi} /{' '}
          {L.by.en} {meta.printedBy}
          {meta.copyNo > 1 ? ` · ${L.duplicate.en} #${meta.copyNo}` : ''}
        </p>
      </div>
    </footer>
  );
}
