import { formatDateTime, MAX_QUICK_ORDERS_ON_SHEET } from '@hmis/shared';
import { code128Svg } from '../barcode';
import { L } from '../labels';
import type { Bilingual, PrintMeta } from '../types';

import type { VitalKey } from './format';

export type { VitalKey };

/** Everything the OPD sheet shows (docs/10 §7). The QR (in `PrintMeta`) encodes the visit id only. */
export interface OpdSheetData {
  doctor: {
    name: string;
    nameHi: string | null;
    qualifications: string | null;
    registration: string | null;
  };
  patient: {
    name: string;
    nameHi: string | null;
    /** `28y / F` */
    ageSex: string;
    uhid: string;
    guardian: string | null;
    locality: string | null;
    mobileLast4: string | null;
  };
  visit: {
    number: string;
    tokenNo: number | null;
    startedAt: Date;
    payer: string;
  };
  /** Printed when the vitals desk has entered them (OPD-01); null leaves the boxes blank. */
  vitals: Partial<Record<VitalKey, string>> | null;
  /** Out-of-range readings: `*` amber, `**` red, with a key line under the boxes. */
  vitalFlags?: Partial<Record<VitalKey, 'amber' | 'red'>>;
  /** Readings beyond the five boxes (height, sugar, pregnancy or child measures), label + value. */
  vitalsMore?: { label: Bilingual; value: string }[];
  /** Patient alerts for the doctor (docs/11 §1: Raised BP in pregnancy). */
  alerts?: 'raised_bp_pregnancy'[];
  lastVisit: { date: string; doctor: string } | null;
  quickOrders: string[];
}

const VITALS: { key: VitalKey; label: Bilingual; unit: string }[] = [
  { key: 'bp', label: L.bp, unit: 'mmHg' },
  { key: 'pulse', label: L.pulse, unit: '/min' },
  { key: 'weight', label: L.weight, unit: 'kg' },
  { key: 'temp', label: L.temp, unit: '°F' },
  { key: 'spo2', label: L.spo2, unit: '%' },
];

const bi = (l: Bilingual) => `${l.hi} / ${l.en}`;

/**
 * Pre-filled A5 OPD sheet (REG-06): the doctor writes on it, the assistant scans the QR and
 * transcribes. Sections follow docs/10 §7 top to bottom; the pregnancy, child and previous-drug
 * context blocks arrive with the ANC and paediatric modules.
 */
export function OpdSheet({ data, meta }: { data: OpdSheetData; meta: PrintMeta }) {
  const { doctor, patient, visit, vitals, lastVisit } = data;
  const flags = data.vitalFlags ?? {};
  const more = data.vitalsMore ?? [];
  const flagged = Object.keys(flags).length > 0 || more.some((m) => m.value.endsWith('*'));
  const orders = data.quickOrders.slice(0, MAX_QUICK_ORDERS_ON_SHEET);
  return (
    <div className="sheet">
      <p className="sheet-doctor">
        <strong>{doctor.nameHi ?? doctor.name}</strong>
        {doctor.nameHi && <span> / {doctor.name}</span>}
        {doctor.qualifications && <span> · {doctor.qualifications}</span>}
        {doctor.registration && (
          <span>
            {' '}
            · {bi(L.regNo)} {doctor.registration}
          </span>
        )}
      </p>

      <div className="sheet-top">
        <div className="sheet-strip">
          <p className="sheet-name">
            <span className="sheet-k">{bi(L.name)}</span>
            <strong>{patient.name}</strong>
            {patient.nameHi && <span> / {patient.nameHi}</span>}
          </p>
          <div className="sheet-grid">
            <Field label={L.ageSex} value={patient.ageSex} />
            <Field label={L.uhid} value={patient.uhid} strong />
            <Field
              label={L.token}
              value={visit.tokenNo === null ? '—' : String(visit.tokenNo)}
              strong
            />
            <Field label={L.dateTime} value={formatDateTime(visit.startedAt)} />
            <Field label={L.guardian} value={patient.guardian ?? '—'} />
            <Field label={L.locality} value={patient.locality ?? '—'} />
            <Field
              label={L.mobile}
              value={patient.mobileLast4 ? `XXXXXX${patient.mobileLast4}` : '—'}
            />
            <Field label={L.payer} value={visit.payer} />
          </div>
        </div>
        <div className="sheet-codes">
          <div
            className="sheet-qr"
            role="img"
            aria-label="QR"
            dangerouslySetInnerHTML={{ __html: meta.qrSvg }}
          />
          <div
            className="sheet-barcode"
            dangerouslySetInnerHTML={{ __html: code128Svg(visit.number) }}
          />
          <p className="sheet-visit-no">{visit.number}</p>
        </div>
      </div>

      <div className="sheet-vitals" data-testid="sheet-vitals">
        <span className="sheet-k">{bi(L.vitals)}</span>
        {VITALS.map((v) => (
          <span key={v.key} className="sheet-vital">
            <span className="sheet-vital-label">{v.label.en}</span>
            <span className="sheet-vital-box" data-flag={flags[v.key]}>
              {vitals?.[v.key] ?? ''}
              {flags[v.key] === 'red' ? '**' : flags[v.key] ? '*' : ''}
            </span>
            <span className="sheet-vital-unit">{v.unit}</span>
          </span>
        ))}
        {more.map((m) => (
          <span key={m.label.en} className="sheet-vital sheet-vital-more">
            <span className="sheet-vital-label">{m.label.en}</span>
            <span className="sheet-vital-box">{m.value}</span>
          </span>
        ))}
        {flagged && <span className="sheet-vital-key">* {bi(L.outOfRange)}</span>}
      </div>

      {(data.alerts ?? []).length > 0 && (
        <p className="sheet-alert" data-testid="sheet-alert">
          <strong>{bi(L.alert)}:</strong> {bi(L.raisedBpPregnancy)}
        </p>
      )}

      <div className="sheet-context">
        <p>
          <strong>{bi(L.allergies)}:</strong> <span className="sheet-blank-line" />
        </p>
        <p>
          <strong>{bi(L.lastVisit)}:</strong>{' '}
          {lastVisit ? `${lastVisit.date} · ${lastVisit.doctor}` : bi(L.firstVisit)}
        </p>
      </div>

      <div className="sheet-write">
        <div className="sheet-write-left">
          <span className="sheet-k">{bi(L.complaints)}</span>
        </div>
        <div className="sheet-write-right">
          <span className="sheet-k">{L.rx.en}</span>
        </div>
      </div>

      <div className="sheet-orders">
        <span className="sheet-k">{bi(L.tests)}</span>
        <ul>
          {orders.map((o) => (
            <li key={o}>
              <span className="sheet-tick" /> {o}
            </li>
          ))}
          <li className="sheet-other">
            <span className="sheet-tick" /> {L.otherTests.en}: <span className="sheet-blank-line" />
          </li>
        </ul>
      </div>

      <div className="sheet-follow">
        <span>
          {bi(L.followUp)}: <span className="sheet-blank-line short" /> {L.afterDays.en}{' '}
          {bi(L.orOnDate)} <span className="sheet-blank-line short" />
        </span>
        <span>
          {bi(L.admit)}: <span className="sheet-tick" /> {L.yes.en} <span className="sheet-tick" />{' '}
          {L.no.en}
        </span>
      </div>

      <div className="sheet-sign">
        <span>{bi(L.signature)}</span>
      </div>
    </div>
  );
}

function Field({ label, value, strong }: { label: Bilingual; value: string; strong?: boolean }) {
  return (
    <p className="sheet-field">
      <span className="sheet-k">{label.en}</span>
      {strong ? <strong>{value}</strong> : value}
    </p>
  );
}
