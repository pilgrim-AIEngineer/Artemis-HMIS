import {
  amountInWordsEn,
  amountInWordsHi,
  formatDateTime,
  formatINR,
  maskRef,
  type PaymentMode,
} from '@hmis/shared';
import { L } from '../labels';
import type { Bilingual } from '../types';

/** What a payment receipt shows (docs/12 §3). The QR (in `PrintMeta`) encodes the receipt id only. */
export interface ReceiptPrintData {
  number: string;
  /** `refund` (BIL-04): amounts arrive negative and print as money handed back. */
  kind: 'payment' | 'refund';
  receivedAt: Date;
  receivedBy: string | null;
  status: 'valid' | 'reversed';
  totalPaise: bigint;
  tenders: {
    mode: PaymentMode;
    amountPaise: bigint;
    upiRef: string | null;
    cardLast4: string | null;
  }[];
  patient: { name: string; nameHi: string | null; ageSex: string; uhid: string };
  encounterNumber: string | null;
  doctorName: string | null;
  bill: {
    number: string | null;
    status: 'draft' | 'final' | 'cancelled';
    netPaise: bigint;
    paidPaise: bigint;
    balancePaise: bigint;
    lines: {
      description: string;
      descriptionHi: string | null;
      qty: string;
      amountPaise: bigint;
    }[];
  } | null;
}

const bi = (l: Bilingual) => `${l.hi} / ${l.en}`;

const MODE: Partial<Record<PaymentMode, Bilingual>> = {
  cash: L.modeCash,
  upi: L.modeUpi,
  card: L.modeCard,
};

/** `1.000` → `1`, `1.500` → `1.5` */
const qtyText = (q: string) => q.replace(/\.?0+$/, '');

/**
 * Payment receipt on the 80 mm roll (BIL-02; the A5 layout and reprint rules come with BIL-05):
 * UHID, bill number, items, amount, mode(s) with only the last digits of a UTR or card, balance,
 * who received it, and the amount in words in Hindi and English. Bilingual for the patient.
 */
export function Receipt({ data }: { data: ReceiptPrintData }) {
  const { patient, bill } = data;
  const refund = data.kind === 'refund';
  // A refund voucher prints the money handed back as a positive amount.
  const shown = refund ? -data.totalPaise : data.totalPaise;
  return (
    <div className="receipt" data-testid="receipt">
      {data.status === 'reversed' && <p className="receipt-status">{bi(L.reversed)}</p>}
      {refund && <p className="receipt-status">{bi(L.refundTitle)}</p>}
      {!refund && bill?.status === 'cancelled' && (
        <p className="receipt-status" data-testid="receipt-bill-cancelled">
          {bi(L.billCancelled)}
        </p>
      )}
      <div className="receipt-row">
        <span className="receipt-k">{bi(refund ? L.creditNoteNo : L.receiptNo)}</span>
        <strong data-testid="receipt-number">{data.number}</strong>
      </div>
      <div className="receipt-row">
        <span className="receipt-k">{bi(L.dateTime)}</span>
        <span>{formatDateTime(data.receivedAt)}</span>
      </div>
      <div className="receipt-patient">
        <p className="receipt-name">{patient.name}</p>
        {patient.nameHi && <p>{patient.nameHi}</p>}
        <div className="receipt-row">
          <span>
            {L.uhid.en}: <strong>{patient.uhid}</strong>
          </span>
          <span>{patient.ageSex}</span>
        </div>
        {data.encounterNumber && (
          <div className="receipt-row">
            <span className="receipt-k">{bi(L.visitNo)}</span>
            <span>{data.encounterNumber}</span>
          </div>
        )}
        {data.doctorName && (
          <div className="receipt-row">
            <span className="receipt-k">{bi(L.doctor)}</span>
            <span>{data.doctorName}</span>
          </div>
        )}
        {bill && (
          <div className="receipt-row">
            <span className="receipt-k">{bi(L.billNo)}</span>
            <span>{bill.number ?? bi(L.billDraft)}</span>
          </div>
        )}
      </div>
      {bill && bill.lines.length > 0 && (
        <table className="print-table">
          <thead>
            <tr>
              <th>{bi(L.item)}</th>
              <th className="num">{L.amount.en}</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.descriptionHi ? `${l.descriptionHi} / ${l.description}` : l.description}
                  {qtyText(l.qty) !== '1' && ` × ${qtyText(l.qty)}`}
                </td>
                <td className="num">{formatINR(l.amountPaise)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{bi(L.billTotal)}</td>
              <td className="num">{formatINR(bill.netPaise)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      <div className="receipt-row receipt-paid">
        <span>{bi(refund ? L.refundedNow : L.paidNow)}</span>
        <span data-testid="receipt-amount">{formatINR(shown)}</span>
      </div>
      {data.tenders.map((t) => (
        <div className="receipt-row" key={t.mode}>
          <span>
            {bi(MODE[t.mode] ?? L.modeOther)}
            {t.upiRef && ` · ${L.utr.en} ${maskRef(t.upiRef)}`}
            {t.cardLast4 && ` · ${L.cardEnding.en} …${t.cardLast4}`}
          </span>
          <span className="receipt-amount">
            {formatINR(refund ? -t.amountPaise : t.amountPaise)}
          </span>
        </div>
      ))}
      <p className="receipt-words">
        {bi(L.inWords)}: {amountInWordsHi(shown)} / {amountInWordsEn(shown)}
      </p>
      {bill && (
        <>
          <div className="receipt-row">
            <span className="receipt-k">{bi(L.paidTotal)}</span>
            <span>{formatINR(bill.paidPaise)}</span>
          </div>
          <div className="receipt-row">
            <strong>{bi(L.balanceDue)}</strong>
            <strong data-testid="receipt-balance">{formatINR(bill.balancePaise)}</strong>
          </div>
        </>
      )}
      {data.receivedBy && (
        <div className="receipt-row">
          <span className="receipt-k">{bi(L.receivedBy)}</span>
          <span>{data.receivedBy}</span>
        </div>
      )}
    </div>
  );
}
