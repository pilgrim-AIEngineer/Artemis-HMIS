import { formatDate } from '@hmis/shared';
import { L } from '../labels';
import { ageSex } from './format';
import type { Bilingual, PrintMeta } from '../types';

/** Hindi / English wording of the vaccination card and certificate (OPD-06). Fixed words only. */
export const VAX_L = {
  cardTitle: { hi: 'टीकाकरण कार्ड', en: 'Vaccination card' },
  certTitle: { hi: 'टीकाकरण प्रमाण-पत्र', en: 'Vaccination certificate' },
  dob: { hi: 'जन्म तिथि', en: 'Date of birth' },
  schedule: { hi: 'टीकाकरण तालिका', en: 'Schedule' },
  given: { hi: 'लगाए गए टीके', en: 'Vaccines given' },
  pending: { hi: 'आगे लगने वाले टीके', en: 'Vaccines still to be given' },
  vaccine: { hi: 'टीका', en: 'Vaccine' },
  date: { hi: 'दिनांक', en: 'Date' },
  batch: { hi: 'बैच', en: 'Batch' },
  expiry: { hi: 'एक्सपायरी', en: 'Expiry' },
  site: { hi: 'स्थान', en: 'Site' },
  brand: { hi: 'ब्रांड', en: 'Brand' },
  due: { hi: 'देय तिथि', en: 'Due on' },
  nextDue: { hi: 'अगला टीकाकरण', en: 'Next vaccination' },
  nothingGiven: { hi: 'अभी कोई टीका दर्ज नहीं है।', en: 'No vaccine recorded yet.' },
  nothingPending: { hi: 'कोई टीका बाकी नहीं।', en: 'Nothing left to give.' },
  overdue: { hi: 'देर हो गई', en: 'Overdue' },
  optional: { hi: 'वैकल्पिक', en: 'optional' },
  bring: {
    hi: 'हर बार यह कार्ड साथ लाएँ। तारीख़ पर टीका लगवाएँ।',
    en: 'Bring this card every time. Come on the due date.',
  },
  certText: {
    hi: 'प्रमाणित किया जाता है कि नीचे लिखे बच्चे को यहाँ निम्नलिखित टीके लगाए गए हैं।',
    en: 'This is to certify that the child named below received the following vaccines at this hospital.',
  },
  signature: { hi: 'चिकित्सक / नर्स के हस्ताक्षर', en: 'Doctor / nurse signature' },
  stamp: { hi: 'अस्पताल की मुहर', en: 'Hospital stamp' },
  iap: { hi: 'आईएपी तालिका', en: 'IAP schedule' },
  uip: { hi: 'यूआईपी तालिका', en: 'UIP schedule' },
} as const satisfies Record<string, Bilingual>;

export const SITE_L: Record<string, Bilingual> = {
  left_thigh: { hi: 'बायीं जाँघ', en: 'Left thigh' },
  right_thigh: { hi: 'दायीं जाँघ', en: 'Right thigh' },
  left_arm: { hi: 'बायीं बाँह', en: 'Left arm' },
  right_arm: { hi: 'दायीं बाँह', en: 'Right arm' },
  oral: { hi: 'मुँह से', en: 'Oral' },
  intradermal_left_arm: { hi: 'बायीं बाँह (त्वचा में)', en: 'Left arm (intradermal)' },
  other: { hi: 'अन्य', en: 'Other' },
};

export interface VaccinationData {
  patient: {
    name: string;
    nameHi: string | null;
    dob: string;
    sex: string;
    uhid: string;
    guardian: string | null;
    mobileLast4: string | null;
  };
  scheduleName: 'IAP' | 'UIP';
  given: {
    label: Bilingual;
    date: string;
    brand: string | null;
    batchNo: string;
    expiry: string;
    site: string;
  }[];
  pending: {
    label: Bilingual;
    dueDate: string;
    overdue: boolean;
    optional: boolean;
  }[];
  nextDue: string | null;
}

const bi = (l: Bilingual) => `${l.hi} / ${l.en}`;

function Identity({
  data,
  withSchedule,
  at,
}: {
  data: VaccinationData;
  withSchedule: boolean;
  at: Date;
}) {
  const p = data.patient;
  return (
    <div className="vax-patient">
      <p className="vax-name">
        <strong>{p.name}</strong>
        {p.nameHi && <span> / {p.nameHi}</span>}
      </p>
      <div className="vax-grid">
        <Cell label={L.uhid} value={p.uhid} strong />
        <Cell label={VAX_L.dob} value={formatDate(p.dob)} />
        <Cell label={L.ageSex} value={ageSex(p.dob, p.sex, at)} />
        <Cell label={L.guardian} value={p.guardian ?? '—'} />
        <Cell label={L.mobile} value={p.mobileLast4 ? `XXXXXX${p.mobileLast4}` : '—'} />
        {withSchedule && (
          <Cell
            label={VAX_L.schedule}
            value={bi(data.scheduleName === 'IAP' ? VAX_L.iap : VAX_L.uip)}
          />
        )}
      </div>
    </div>
  );
}

function Cell({ label, value, strong }: { label: Bilingual; value: string; strong?: boolean }) {
  return (
    <div className="vax-cell">
      <span className="vax-k">{bi(label)}</span>
      {strong ? <strong>{value}</strong> : <span>{value}</span>}
    </div>
  );
}

function GivenTable({ data }: { data: VaccinationData }) {
  return data.given.length === 0 ? (
    <p>{bi(VAX_L.nothingGiven)}</p>
  ) : (
    <table className="vax-table" data-testid="vax-given">
      <thead>
        <tr>
          {[VAX_L.vaccine, VAX_L.date, VAX_L.brand, VAX_L.batch, VAX_L.expiry, VAX_L.site].map(
            (h) => (
              <th key={h.en}>
                {h.hi}
                <br />
                {h.en}
              </th>
            ),
          )}
        </tr>
      </thead>
      <tbody>
        {data.given.map((g, i) => (
          <tr key={`${g.label.en}-${i}`}>
            <td className="vax-left">
              {g.label.hi} / {g.label.en}
            </td>
            <td>{formatDate(g.date)}</td>
            <td>{g.brand ?? '—'}</td>
            <td>{g.batchNo}</td>
            <td>{formatDate(g.expiry)}</td>
            <td>{SITE_L[g.site] ? SITE_L[g.site]!.en : g.site}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A5 vaccination card, Hindi and English: what was given (with batch) and what is still to come. */
export function VaccinationCard({ data, meta }: { data: VaccinationData; meta: PrintMeta }) {
  return (
    <div className="vax-card">
      <p className="vax-title">{bi(VAX_L.cardTitle)}</p>
      <Identity data={data} withSchedule at={meta.printedAt} />
      <div className="vax-box">
        <span className="vax-h">{bi(VAX_L.given)}</span>
        <GivenTable data={data} />
      </div>
      <div className="vax-box" data-testid="vax-pending">
        <span className="vax-h">{bi(VAX_L.pending)}</span>
        {data.pending.length === 0 ? (
          <p>{bi(VAX_L.nothingPending)}</p>
        ) : (
          <ul className="vax-pending">
            {data.pending.map((d, i) => (
              <li key={`${d.label.en}-${i}`} data-overdue={d.overdue}>
                <span>
                  {d.label.hi} / {d.label.en}
                  {d.optional ? ` (${VAX_L.optional.en})` : ''}
                </span>
                <span className="vax-date">
                  {formatDate(d.dueDate)}
                  {d.overdue ? ` ${VAX_L.overdue.en}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="vax-next" data-testid="vax-next">
        <strong>{bi(VAX_L.nextDue)}:</strong> {data.nextDue ? formatDate(data.nextDue) : '—'}
      </p>
      <p className="vax-bring">{bi(VAX_L.bring)}</p>
    </div>
  );
}

/** A4 certificate of the vaccines given, with room for the signature and stamp. */
export function VaccinationCertificate({ data, meta }: { data: VaccinationData; meta: PrintMeta }) {
  return (
    <div className="vax-cert">
      <p className="vax-title">{bi(VAX_L.certTitle)}</p>
      <p className="vax-cert-text">
        {VAX_L.certText.hi}
        <br />
        {VAX_L.certText.en}
      </p>
      <Identity data={data} withSchedule={false} at={meta.printedAt} />
      <div className="vax-box">
        <GivenTable data={data} />
      </div>
      <div className="vax-sign">
        <div>
          <div className="vax-sign-box">{bi(VAX_L.signature)}</div>
        </div>
        <div>
          <div className="vax-sign-box">{bi(VAX_L.stamp)}</div>
        </div>
      </div>
    </div>
  );
}
