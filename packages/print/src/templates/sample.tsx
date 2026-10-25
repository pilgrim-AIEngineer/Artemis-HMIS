import { formatINR } from '@hmis/shared';
import { L } from '../labels';
import type { PaperSize } from '../paper';
import type { PrintMeta } from '../types';

export interface SampleData {
  /** Short code shown on the label (the facility id's first characters). */
  ref: string;
}

const LINES = [
  { name: { hi: 'ओपीडी परामर्श', en: 'OPD consultation' }, qty: 1, paise: 50_000n },
  { name: { hi: 'अल्ट्रासाउंड', en: 'Ultrasound' }, qty: 1, paise: 80_000n },
  { name: { hi: 'दवाइयाँ', en: 'Medicines' }, qty: 3, paise: 123_456n },
] as const;

/**
 * Sample template for every paper size: exercises the header, bilingual text, an Indian-grouped
 * money column, the QR footer and the DUPLICATE mark. Real templates (receipt, OPD sheet, …)
 * follow the same pattern in their own modules. Contains no patient data.
 */
export function SampleDocument({
  paper,
  data,
  meta,
}: {
  paper: PaperSize;
  data: SampleData;
  meta: PrintMeta;
}) {
  if (paper === 'label50x25') {
    return (
      <div className="print-label">
        <div className="print-label-text">
          <p style={{ fontWeight: 700 }}>
            {L.samplePatient.hi} / {L.samplePatient.en}
          </p>
          <p>{L.uhid.en}: GH-000123</p>
          <p>{data.ref}</p>
        </div>
        <div className="print-qr" dangerouslySetInnerHTML={{ __html: meta.qrSvg }} />
      </div>
    );
  }
  const total = LINES.reduce((sum, l) => sum + l.paise, 0n);
  return (
    <>
      <table className="print-table">
        <thead>
          <tr>
            <th>
              {L.item.hi} / {L.item.en}
            </th>
            <th className="num">{L.qty.en}</th>
            <th className="num">
              {L.amount.hi} / {L.amount.en}
            </th>
          </tr>
        </thead>
        <tbody>
          {LINES.map((l) => (
            <tr key={l.name.en}>
              <td>
                {l.name.hi} / {l.name.en}
              </td>
              <td className="num">{l.qty}</td>
              <td className="num">{formatINR(l.paise)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>
              {L.total.hi} / {L.total.en}
            </td>
            <td className="num">{formatINR(total)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="print-note">
        {L.sampleNote.hi}
        <br />
        {L.sampleNote.en}
      </p>
    </>
  );
}
