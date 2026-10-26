import { ancDate, formatDate, GRADE_SYMBOL, type RiskCode } from '@hmis/shared';
import { L } from '../labels';
import type { Bilingual, PrintMeta } from '../types';

/** Hindi / English wording of the antenatal card (OPD-05). Fixed words only; no patient data. */
export const ANC_L = {
  title: { hi: 'गर्भावस्था जाँच कार्ड', en: 'Antenatal care card' },
  booking: { hi: 'बुकिंग', en: 'Booking' },
  bookingDate: { hi: 'बुकिंग तिथि', en: 'Booked on' },
  lmp: { hi: 'अंतिम माहवारी', en: 'LMP' },
  lmpUnknown: { hi: 'पता नहीं', en: 'Not known' },
  edd: { hi: 'प्रसव की अनुमानित तिथि', en: 'EDD' },
  datedByLmp: { hi: 'माहवारी से', en: 'by LMP' },
  datedByScan: { hi: 'स्कैन से', en: 'by scan' },
  gaToday: { hi: 'आज गर्भ', en: 'GA today' },
  gpal: { hi: 'जी पी ए एल', en: 'G P A L' },
  bloodGroup: { hi: 'ब्लड ग्रुप', en: 'Blood group' },
  babies: { hi: 'गर्भ में', en: 'Pregnancy' },
  single: { hi: 'एक बच्चा', en: 'Single' },
  twins: { hi: 'जुड़वाँ', en: 'Twins' },
  higher: { hi: 'दो से अधिक', en: 'More than two' },
  risks: { hi: 'ध्यान देने योग्य बातें', en: 'Risk flags' },
  noRisks: { hi: 'कोई नहीं', en: 'None' },
  visits: { hi: 'जाँच का विवरण', en: 'Visits' },
  tests: { hi: 'जाँचें, स्कैन और टीके', en: 'Tests, scans and vaccines' },
  nextVisit: { hi: 'अगली जाँच', en: 'Next visit' },
  date: { hi: 'दिनांक', en: 'Date' },
  ga: { hi: 'सप्ताह', en: 'GA' },
  wt: { hi: 'वज़न', en: 'Wt' },
  bp: { hi: 'रक्तचाप', en: 'BP' },
  fh: { hi: 'फंडल', en: 'FH' },
  fhr: { hi: 'धड़कन', en: 'FHR' },
  pres: { hi: 'स्थिति', en: 'Pres.' },
  oed: { hi: 'सूजन', en: 'Oed.' },
  urine: { hi: 'मूत्र प/श', en: 'Urine P/S' },
  hb: { hi: 'Hb', en: 'Hb' },
  remarks: { hi: 'टिप्पणी', en: 'Remarks' },
  noVisits: { hi: 'अभी कोई जाँच दर्ज नहीं है।', en: 'No visits recorded yet.' },
  done: { hi: 'हो गया', en: 'Done' },
  due: { hi: 'अभी कराएँ', en: 'Due now' },
  overdue: { hi: 'देर हो गई', en: 'Overdue' },
  upcoming: { hi: 'आगे', en: 'Later' },
  skipped: { hi: 'छोड़ा गया', en: 'Skipped' },
  bring: {
    hi: 'हर जाँच पर यह कार्ड साथ लाएँ। तकलीफ़ होने पर तुरंत अस्पताल आएँ।',
    en: 'Bring this card to every visit. Come to the hospital at once if you are unwell.',
  },
} as const satisfies Record<string, Bilingual>;

/** Names of the risk flags (docs/11 §3.2) for the printed card. */
export const RISK_LABELS: Record<RiskCode, Bilingual> = {
  age_young: { hi: 'कम उम्र में गर्भ', en: 'Young maternal age' },
  age_elderly: { hi: 'अधिक उम्र में गर्भ', en: 'Advanced maternal age' },
  short_stature: { hi: 'कम कद', en: 'Short stature' },
  obese_at_booking: { hi: 'बुकिंग पर मोटापा', en: 'Obesity at booking' },
  raised_bp: { hi: 'उच्च रक्तचाप', en: 'Raised BP' },
  severe_raised_bp: { hi: 'बहुत अधिक रक्तचाप', en: 'Severely raised BP' },
  anaemia: { hi: 'खून की कमी', en: 'Anaemia' },
  severe_anaemia: { hi: 'खून की गंभीर कमी', en: 'Severe anaemia' },
  previous_lscs: { hi: 'पहले सिज़ेरियन', en: 'Previous caesarean' },
  previous_stillbirth_or_neonatal_death: {
    hi: 'पहले मृत जन्म या नवजात की मृत्यु',
    en: 'Previous stillbirth or neonatal death',
  },
  recurrent_abortions: { hi: 'बार-बार गर्भपात', en: 'Recurrent abortions' },
  grand_multipara: { hi: 'चार या अधिक प्रसव', en: 'Grand multipara' },
  rh_negative: { hi: 'आरएच नेगेटिव', en: 'Rh negative' },
  multiple_pregnancy: { hi: 'एक से अधिक बच्चे', en: 'Multiple pregnancy' },
  post_dates: { hi: '40 सप्ताह से अधिक', en: 'Post-dates' },
  gdm: { hi: 'गर्भावस्था में शुगर', en: 'Gestational diabetes' },
  thyroid_disorder: { hi: 'थायरॉइड की बीमारी', en: 'Thyroid disorder' },
  heart_disease: { hi: 'हृदय रोग', en: 'Heart disease' },
  placenta_praevia: { hi: 'प्लेसेंटा प्रीविया', en: 'Placenta praevia' },
  iugr: { hi: 'बच्चे की कम वृद्धि', en: 'Growth restriction (IUGR)' },
  other: { hi: 'अन्य', en: 'Other' },
};

const PRESENTATION: Record<string, string> = {
  cephalic: 'Ceph',
  breech: 'Breech',
  transverse: 'Trans',
  oblique: 'Obl',
  not_assessed: '—',
};

export interface AncCardData {
  patient: {
    name: string;
    nameHi: string | null;
    ageYears: number | null;
    uhid: string;
    guardian: string | null;
    mobileLast4: string | null;
  };
  bookingDate: string;
  lmp: string | null;
  edd: string;
  datedBy: 'lmp' | 'scan';
  gaLabel: string | null;
  gpal: string;
  bloodGroup: string | null;
  plurality: 'single' | 'twins' | 'higher';
  risks: { code: RiskCode; level: 'warn' | 'alert'; text: string | null; value: string | null }[];
  visits: {
    date: string;
    gaLabel: string;
    weightKg: number | null;
    bp: string | null;
    fundalHeightCm: number | null;
    fhr: number | null;
    presentation: string | null;
    oedema: string | null;
    urineProtein: string | null;
    urineSugar: string | null;
    hb: number | null;
    remarks: string | null;
  }[];
  schedule: {
    label: Bilingual;
    state: 'done' | 'due' | 'overdue' | 'upcoming' | 'skipped';
    date: string | null;
    windowFrom: string | null;
  }[];
  nextVisit: { date: string; gaLabel: string } | null;
}

const bi = (l: Bilingual) => `${l.hi} / ${l.en}`;
const dash = (v: string | number | null) => (v === null || v === '' ? '—' : String(v));
const grade = (g: string | null) => (g ? (GRADE_SYMBOL[g as keyof typeof GRADE_SYMBOL] ?? g) : '—');

/** A5 antenatal card, Hindi and English (docs/11 §3.5). */
export function AncCard({ data }: { data: AncCardData; meta: PrintMeta }) {
  const { patient: p } = data;
  const plural = ANC_L[data.plurality];
  return (
    <div className="anc-card">
      <p className="anc-title">{bi(ANC_L.title)}</p>
      <div className="anc-patient">
        <p className="anc-name">
          <strong>{p.name}</strong>
          {p.nameHi && <span> / {p.nameHi}</span>}
        </p>
        <div className="anc-grid">
          <Cell label={L.uhid} value={p.uhid} strong />
          <Cell label={L.ageSex} value={p.ageYears === null ? '—' : `${p.ageYears}y`} />
          <Cell label={L.guardian} value={dash(p.guardian)} />
          <Cell label={L.mobile} value={p.mobileLast4 ? `XXXXXX${p.mobileLast4}` : '—'} />
        </div>
      </div>

      <div className="anc-box" data-testid="anc-booking">
        <span className="anc-h">{bi(ANC_L.booking)}</span>
        <div className="anc-grid">
          <Cell label={ANC_L.bookingDate} value={ancDate(data.bookingDate)} />
          <Cell label={ANC_L.lmp} value={data.lmp ? formatDate(data.lmp) : bi(ANC_L.lmpUnknown)} />
          <Cell
            label={ANC_L.edd}
            value={`${formatDate(data.edd)} (${data.datedBy === 'lmp' ? ANC_L.datedByLmp.en : ANC_L.datedByScan.en})`}
            strong
          />
          <Cell label={ANC_L.gaToday} value={dash(data.gaLabel)} strong />
          <Cell label={ANC_L.gpal} value={data.gpal} strong />
          <Cell label={ANC_L.bloodGroup} value={dash(data.bloodGroup)} strong />
          <Cell label={ANC_L.babies} value={`${plural.hi} / ${plural.en}`} />
        </div>
      </div>

      <div className="anc-box anc-risks" data-testid="anc-risks">
        <span className="anc-h">{bi(ANC_L.risks)}</span>
        {data.risks.length === 0 ? (
          <span>{bi(ANC_L.noRisks)}</span>
        ) : (
          <ul>
            {data.risks.map((r, i) => (
              <li key={`${r.code}-${i}`} data-level={r.level}>
                <strong>
                  {RISK_LABELS[r.code].hi} / {RISK_LABELS[r.code].en}
                </strong>
                {r.value && <span> ({r.value})</span>}
                {r.text && <span>: {r.text}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="anc-visits">
        <span className="anc-h">{bi(ANC_L.visits)}</span>
        {data.visits.length === 0 ? (
          <p>{bi(ANC_L.noVisits)}</p>
        ) : (
          <table className="anc-table" data-testid="anc-visit-table">
            <thead>
              <tr>
                {[
                  ANC_L.date,
                  ANC_L.ga,
                  ANC_L.wt,
                  ANC_L.bp,
                  ANC_L.fh,
                  ANC_L.fhr,
                  ANC_L.pres,
                  ANC_L.oed,
                  ANC_L.urine,
                  ANC_L.hb,
                  ANC_L.remarks,
                ].map((h) => (
                  <th key={h.en}>
                    {h.hi}
                    <br />
                    {h.en}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.visits.map((v) => (
                <tr key={v.date}>
                  <td>{formatDate(v.date)}</td>
                  <td>{v.gaLabel}</td>
                  <td>{dash(v.weightKg)}</td>
                  <td>{dash(v.bp)}</td>
                  <td>{dash(v.fundalHeightCm)}</td>
                  <td>{dash(v.fhr)}</td>
                  <td>{v.presentation ? (PRESENTATION[v.presentation] ?? v.presentation) : '—'}</td>
                  <td>{grade(v.oedema)}</td>
                  <td>
                    {grade(v.urineProtein)} / {grade(v.urineSugar)}
                  </td>
                  <td>{dash(v.hb)}</td>
                  <td>{v.remarks ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="anc-box" data-testid="anc-schedule">
        <span className="anc-h">{bi(ANC_L.tests)}</span>
        <ul className="anc-schedule">
          {data.schedule.map((s) => (
            <li key={s.label.en} data-state={s.state}>
              <span>
                {s.label.hi} / {s.label.en}
              </span>
              <span className="anc-state">
                {ANC_L[s.state].en}
                {s.state === 'done' && s.date ? ` ${formatDate(s.date)}` : ''}
                {s.state === 'upcoming' && s.windowFrom ? ` ${formatDate(s.windowFrom)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="anc-next" data-testid="anc-next">
        <strong>{bi(ANC_L.nextVisit)}:</strong>{' '}
        {data.nextVisit ? `${formatDate(data.nextVisit.date)} (${data.nextVisit.gaLabel})` : '—'}
      </p>
      <p className="anc-bring">{bi(ANC_L.bring)}</p>
    </div>
  );
}

function Cell({ label, value, strong }: { label: Bilingual; value: string; strong?: boolean }) {
  return (
    <div className="anc-cell">
      <span className="anc-k">{bi(label)}</span>
      {strong ? <strong>{value}</strong> : <span>{value}</span>}
    </div>
  );
}
