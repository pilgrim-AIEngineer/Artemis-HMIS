import { code128Svg } from '../barcode';
import { L } from '../labels';
import type { Bilingual, PrintHeaderData, PrintMeta } from '../types';

/** What a sticker or UHID card shows. The QR encodes the UHID only (an identifier, not a name). */
export interface PatientLabelData {
  uhid: string;
  name: string;
  nameHi: string | null;
  /** `28y / F` */
  ageSex: string;
  mobileLast4: string | null;
}

/** REG-07: 50 × 25 mm sticker for files, sample tubes and forms. */
export function PatientSticker({ data, meta }: { data: PatientLabelData; meta: PrintMeta }) {
  return (
    <div className="print-label">
      <div className="print-label-text">
        <p className="sticker-name">{data.name}</p>
        {data.nameHi && <p className="sticker-name-hi">{data.nameHi}</p>}
        <p>{data.ageSex}</p>
        <p className="sticker-uhid">{data.uhid}</p>
        {data.mobileLast4 && (
          <p>
            {L.mobile.en} XXXXXX{data.mobileLast4}
          </p>
        )}
      </div>
      <div
        className="print-qr"
        role="img"
        aria-label="QR"
        dangerouslySetInnerHTML={{ __html: meta.qrSvg }}
      />
    </div>
  );
}

const bi = (l: Bilingual) => `${l.hi} / ${l.en}`;

/**
 * REG-07: UHID card, front and back, printed on an A5 sheet to cut out (85.6 × 54 mm, credit-card
 * size). There is no card-printer paper size in docs/01 §4; this prints on any office printer.
 */
export function UhidCard({
  data,
  header,
  meta,
}: {
  data: PatientLabelData;
  header: PrintHeaderData;
  meta: PrintMeta;
}) {
  return (
    <div className="cards">
      <div className="card card-front" data-testid="uhid-card-front">
        <p className="card-tag">
          {bi(L.cardFold)} · {bi(L.cutHere)}
        </p>
        <div className="card-head">
          {header.nameHi && <p className="card-hospital-hi">{header.nameHi}</p>}
          <p className="card-hospital">{header.nameEn}</p>
          <p className="card-sub">{bi(L.patientCard)}</p>
        </div>
        <div className="card-main">
          <div className="card-text">
            <p className="card-name">{data.name}</p>
            {data.nameHi && <p className="card-name-hi">{data.nameHi}</p>}
            <p>{data.ageSex}</p>
            {data.mobileLast4 && (
              <p>
                {bi(L.mobile)} XXXXXX{data.mobileLast4}
              </p>
            )}
            <p className="card-uhid">
              {L.uhid.en}: {data.uhid}
            </p>
          </div>
          <div
            className="card-qr"
            role="img"
            aria-label="QR"
            dangerouslySetInnerHTML={{ __html: meta.qrSvg }}
          />
        </div>
        <div className="card-barcode" dangerouslySetInnerHTML={{ __html: code128Svg(data.uhid) }} />
      </div>

      <div className="card card-back" data-testid="uhid-card-back">
        <p className="card-tag">
          {bi(L.cardBack)} · {bi(L.cutHere)}
        </p>
        <p className="card-note">{L.cardBring.hi}</p>
        <p className="card-note">{L.cardBring.en}</p>
        <p className="card-note">{L.cardLost.hi}</p>
        <p className="card-note">{L.cardLost.en}</p>
        <div className="card-contact">
          {header.addressEn && <p>{header.addressEn}</p>}
          {header.phone && (
            <p>
              {bi(L.phone)}: {header.phone}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
