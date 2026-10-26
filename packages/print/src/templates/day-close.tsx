import { formatDate, formatDateTime, formatINR, totalOfModes, type ModeTotals } from '@hmis/shared';
import { L } from '../labels';
import type { Bilingual } from '../types';

const bi = (l: Bilingual) => `${l.hi} / ${l.en}`;

const MODE_ROWS: [keyof ModeTotals, Bilingual][] = [
  ['cashPaise', L.modeCash],
  ['upiPaise', L.modeUpi],
  ['cardPaise', L.modeCard],
  ['otherPaise', L.modeOther],
];

/** What a user close shows on the 80 mm slip (BIL-06). */
export interface DayCloseSlipData {
  closeDate: string;
  closedAt: Date;
  userName: string | null;
  totals: ModeTotals;
  cashCountedPaise: bigint;
  differencePaise: bigint;
  differenceReason: string | null;
  paymentCount: number;
  denominations: {
    n500: number;
    n200: number;
    n100: number;
    n50: number;
    n20: number;
    n10: number;
    coinsPaise: bigint;
  } | null;
}

const NOTES = [500, 200, 100, 50, 20, 10] as const;

/** Signed difference: negative = short, positive = over. */
const diffText = (d: bigint) =>
  d === 0n ? formatINR(0n) : `${d > 0n ? '+' : '−'}${formatINR(d < 0n ? -d : d)}`;

/** A cashier's close of the counter: expected by mode, the denomination count and the variance. */
export function DayCloseSlip({ data }: { data: DayCloseSlipData }) {
  const d = data.denominations;
  return (
    <div className="receipt" data-testid="day-close-slip">
      <div className="receipt-row">
        <span className="receipt-k">{bi(L.closeDate)}</span>
        <strong data-testid="close-date">{formatDate(data.closeDate)}</strong>
      </div>
      <div className="receipt-row">
        <span className="receipt-k">{bi(L.closedAt)}</span>
        <span>{formatDateTime(data.closedAt)}</span>
      </div>
      {data.userName && (
        <div className="receipt-row">
          <span className="receipt-k">{bi(L.closedBy)}</span>
          <span>{data.userName}</span>
        </div>
      )}
      <div className="receipt-patient">
        <div className="receipt-row">
          <strong>{bi(L.expected)}</strong>
          <span>
            {data.paymentCount} {L.payments.en}
          </span>
        </div>
        {MODE_ROWS.filter(([k]) => k !== 'otherPaise' || data.totals.otherPaise !== 0n).map(
          ([k, label]) => (
            <div className="receipt-row" key={k}>
              <span>{bi(label)}</span>
              <span className="receipt-amount">{formatINR(data.totals[k])}</span>
            </div>
          ),
        )}
        <div className="receipt-row">
          <strong>{bi(L.totalCollected)}</strong>
          <strong className="receipt-amount">{formatINR(totalOfModes(data.totals))}</strong>
        </div>
      </div>
      {d && (
        <table className="print-table" data-testid="close-denominations">
          <thead>
            <tr>
              <th>{bi(L.denominations)}</th>
              <th className="num">×</th>
              <th className="num">{L.amount.en}</th>
            </tr>
          </thead>
          <tbody>
            {NOTES.filter((v) => d[`n${v}`] > 0).map((v) => (
              <tr key={v}>
                <td>₹{v}</td>
                <td className="num">{d[`n${v}`]}</td>
                <td className="num">{formatINR(BigInt(d[`n${v}`]) * BigInt(v) * 100n)}</td>
              </tr>
            ))}
            {d.coinsPaise > 0n && (
              <tr>
                <td>{bi(L.coins)}</td>
                <td className="num" />
                <td className="num">{formatINR(d.coinsPaise)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="receipt-row">
        <span>
          {bi(L.modeCash)} — {bi(L.expected)}
        </span>
        <span className="receipt-amount">{formatINR(data.totals.cashPaise)}</span>
      </div>
      <div className="receipt-row receipt-paid">
        <span>{bi(L.counted)}</span>
        <span data-testid="close-counted">{formatINR(data.cashCountedPaise)}</span>
      </div>
      <div className="receipt-row">
        <strong>
          {bi(L.difference)}
          {data.differencePaise < 0n
            ? ` (${L.differenceShort.en})`
            : data.differencePaise > 0n
              ? ` (${L.differenceOver.en})`
              : ''}
        </strong>
        <strong data-testid="close-difference">{diffText(data.differencePaise)}</strong>
      </div>
      {data.differenceReason && (
        <p className="receipt-words" data-testid="close-reason">
          {bi(L.reason)}: {data.differenceReason}
        </p>
      )}
      <div className="receipt-a5-sign-box">
        <span className="receipt-k">{bi(L.signedBy)}</span>
      </div>
    </div>
  );
}

export interface FacilityCloseSummaryData {
  closeDate: string;
  closedAt: Date;
  closedByName: string | null;
  totals: ModeTotals;
  cashCountedPaise: bigint;
  differencePaise: bigint;
  paymentCount: number;
  pendingAcknowledged: boolean;
  note: string | null;
  userCloses: {
    userName: string;
    closedAt: Date;
    cashExpectedPaise: bigint;
    cashCountedPaise: bigint;
    differencePaise: bigint;
    differenceReason: string | null;
  }[];
  byDoctor: { label: string; netPaise: bigint }[];
  byDepartment: { label: string; netPaise: bigint }[];
  upiStatus: 'none' | 'open' | 'reconciled';
  upiDifferencePaise: bigint | null;
}

const UPI_STATUS: Record<FacilityCloseSummaryData['upiStatus'], Bilingual> = {
  none: L.upiNone,
  open: L.upiOpen,
  reconciled: L.upiDone,
};

/** The owner's day-end summary (A4): user closes, totals by mode, department and doctor. */
export function FacilityCloseSummary({ data }: { data: FacilityCloseSummaryData }) {
  return (
    <div className="facility-close" data-testid="facility-close-summary">
      <div className="receipt-row">
        <span>
          {bi(L.closeDate)}: <strong data-testid="close-date">{formatDate(data.closeDate)}</strong>
        </span>
        <span>
          {bi(L.closedAt)}: {formatDateTime(data.closedAt)}
          {data.closedByName && ` · ${data.closedByName}`}
        </span>
      </div>

      <h3 className="facility-close-h">{bi(L.counters)}</h3>
      <table className="print-table" data-testid="facility-close-users">
        <thead>
          <tr>
            <th>{bi(L.closedBy)}</th>
            <th className="num">{bi(L.expected)}</th>
            <th className="num">{bi(L.counted)}</th>
            <th className="num">{bi(L.difference)}</th>
            <th>{bi(L.reason)}</th>
          </tr>
        </thead>
        <tbody>
          {data.userCloses.map((c, i) => (
            <tr key={i}>
              <td>{c.userName}</td>
              <td className="num">{formatINR(c.cashExpectedPaise)}</td>
              <td className="num">{formatINR(c.cashCountedPaise)}</td>
              <td className="num">{diffText(c.differencePaise)}</td>
              <td>{c.differenceReason ?? ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{bi(L.total)}</td>
            <td className="num">{formatINR(data.totals.cashPaise)}</td>
            <td className="num">{formatINR(data.cashCountedPaise)}</td>
            <td className="num" data-testid="facility-difference">
              {diffText(data.differencePaise)}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>

      <h3 className="facility-close-h">{bi(L.totalCollected)}</h3>
      <table className="print-table">
        <tbody>
          {MODE_ROWS.filter(([k]) => k !== 'otherPaise' || data.totals.otherPaise !== 0n).map(
            ([k, label]) => (
              <tr key={k}>
                <td>{bi(label)}</td>
                <td className="num">{formatINR(data.totals[k])}</td>
              </tr>
            ),
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>
              {bi(L.totalCollected)} ({data.paymentCount} {L.payments.en})
            </td>
            <td className="num" data-testid="facility-total">
              {formatINR(totalOfModes(data.totals))}
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="facility-close-cols">
        <div>
          <h3 className="facility-close-h">{bi(L.byDepartment)}</h3>
          <table className="print-table">
            <tbody>
              {data.byDepartment.map((r, i) => (
                <tr key={i}>
                  <td>{r.label}</td>
                  <td className="num">{formatINR(r.netPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="facility-close-h">{bi(L.byDoctor)}</h3>
          <table className="print-table">
            <tbody>
              {data.byDoctor.map((r, i) => (
                <tr key={i}>
                  <td>{r.label}</td>
                  <td className="num">{formatINR(r.netPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="receipt-row">
        <span>{bi(L.upiStatus)}</span>
        <strong>
          {bi(UPI_STATUS[data.upiStatus])}
          {data.upiDifferencePaise !== null && data.upiDifferencePaise !== 0n
            ? ` (${diffText(data.upiDifferencePaise)})`
            : ''}
        </strong>
      </p>
      {data.pendingAcknowledged && (
        <p className="receipt-status" data-testid="facility-pending-note">
          {bi(L.pendingCounters)}
          {data.note ? `: ${data.note}` : ''}
        </p>
      )}
      {!data.pendingAcknowledged && data.note && (
        <p>
          {bi(L.pendingNote)}: {data.note}
        </p>
      )}
    </div>
  );
}
