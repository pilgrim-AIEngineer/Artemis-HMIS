import { L } from '../labels';
import type { PaperSize } from '../paper';
import type { PrintHeaderData } from '../types';

/**
 * Hospital header on every print (docs/05 §6): Hindi name first, English second, then address,
 * phone and registration numbers. Labels carry no header (the sticker is too small).
 */
export function PrintHeader({ header, paper }: { header: PrintHeaderData; paper: PaperSize }) {
  if (paper === 'label50x25') return null;
  const showHiAddress = header.addressHi && paper !== 'thermal80';
  const contact = [
    header.phone && `${L.phone.hi} / ${L.phone.en}: ${header.phone}`,
    paper !== 'thermal80' && header.email,
  ].filter(Boolean);
  return (
    <header className="print-header">
      {header.nameHi && <h1 className="print-name-hi">{header.nameHi}</h1>}
      <h1 className="print-name">{header.nameEn}</h1>
      {(header.taglineHi || header.taglineEn) && (
        <p className="print-tagline">
          {[header.taglineHi, header.taglineEn].filter(Boolean).join(' · ')}
        </p>
      )}
      {showHiAddress && <p className="print-line">{header.addressHi}</p>}
      {header.addressEn && <p className="print-line">{header.addressEn}</p>}
      {contact.length > 0 && <p className="print-line">{contact.join(' · ')}</p>}
      {header.registrationNos.length > 0 && (
        <p className="print-line">
          {header.registrationNos
            .map((r) => `${r.label.hi} / ${r.label.en}: ${r.value}`)
            .join(' · ')}
        </p>
      )}
    </header>
  );
}
