import { formatDate, zBand, type GrowthIndicator } from '@hmis/shared';
import { GrowthChart, type GrowthChartPoint } from '@hmis/ui/components/growth-chart';
import { L } from '../labels';
import type { Bilingual, PrintMeta } from '../types';
import { ageSex } from './format';

/** Hindi / English wording of the growth chart print (OPD-06). Fixed words only. */
export const GROWTH_L = {
  title: { hi: 'वृद्धि चार्ट (डब्ल्यूएचओ)', en: 'Growth chart (WHO)' },
  wfa: { hi: 'उम्र के अनुसार वज़न (किग्रा)', en: 'Weight for age (kg)' },
  lhfa: { hi: 'उम्र के अनुसार लंबाई / ऊँचाई (सेमी)', en: 'Length / height for age (cm)' },
  hcfa: { hi: 'उम्र के अनुसार सिर की परिधि (सेमी)', en: 'Head circumference for age (cm)' },
  wfh: { hi: 'लंबाई के अनुसार वज़न (किग्रा)', en: 'Weight for length / height (kg)' },
  age: { hi: 'उम्र', en: 'Age' },
  length: { hi: 'लंबाई / ऊँचाई (सेमी)', en: 'Length / height (cm)' },
  year: { hi: 'व', en: 'y' },
  month: { hi: 'मा', en: 'm' },
  measurements: { hi: 'माप', en: 'Measurements' },
  date: { hi: 'दिनांक', en: 'Date' },
  weight: { hi: 'वज़न', en: 'Wt (kg)' },
  height: { hi: 'लंबाई', en: 'Ht (cm)' },
  head: { hi: 'सिर', en: 'HC (cm)' },
  z: { hi: 'z-स्कोर', en: 'z-score' },
  none: { hi: 'कोई माप दर्ज नहीं।', en: 'No measurement recorded.' },
  valuesOnly: {
    hi: 'इस उम्र के लिए केवल माप दिखाए गए हैं (डब्ल्यूएचओ चार्ट 0–5 वर्ष के लिए हैं)।',
    en: 'Values only: the WHO charts cover 0 to 5 years.',
  },
  lines: {
    hi: 'रेखाएँ: 0 = औसत, ±2 और ±3 मानक विचलन।',
    en: 'Lines: 0 = median, ±2 and ±3 standard deviations.',
  },
  below3: { hi: '−3 से नीचे', en: 'below −3' },
  below2: { hi: '−2 से नीचे', en: 'below −2' },
  above2: { hi: '+2 से ऊपर', en: 'above +2' },
  above3: { hi: '+3 से ऊपर', en: 'above +3' },
} as const satisfies Record<string, Bilingual>;

export interface GrowthChartData {
  patient: { name: string; nameHi: string | null; dob: string; sex: string; uhid: string };
  /** Null when the child is 5 or older, or the sex has no WHO standard (values only). */
  charts:
    | {
        indicator: GrowthIndicator;
        curve: { xs: number[]; lines: { z: number; ys: number[] }[] };
        points: GrowthChartPoint[];
      }[]
    | null;
  rows: {
    date: string;
    weightKg: number | null;
    lengthHeightCm: number | null;
    headCircCm: number | null;
    zWfa: number | null;
    zLhfa: number | null;
    zHcfa: number | null;
    zWfh: number | null;
  }[];
}

const bi = (l: Bilingual) => `${l.hi} / ${l.en}`;
const dash = (v: number | null) => (v === null ? '—' : String(v));
const zText = (z: number | null) => {
  if (z === null) return '—';
  const b = zBand(z);
  const mark =
    b === 'lt_neg3'
      ? '▼▼'
      : b === 'lt_neg2'
        ? '▼'
        : b === 'gt_pos2'
          ? '▲'
          : b === 'gt_pos3'
            ? '▲▲'
            : '';
  return `${z > 0 ? '+' : ''}${z.toFixed(1)}${mark ? ` ${mark}` : ''}`;
};

/** A4 growth chart: the four WHO charts with the child's points, then the measurements and z-scores. */
export function GrowthChartSheet({ data, meta }: { data: GrowthChartData; meta: PrintMeta }) {
  const p = data.patient;
  return (
    <div className="growth-sheet">
      <p className="growth-title">{bi(GROWTH_L.title)}</p>
      <p className="growth-name">
        <strong>{p.name}</strong>
        {p.nameHi && <span> / {p.nameHi}</span>}
        <span>
          {' '}
          · {L.uhid.en} {p.uhid} · {formatDate(p.dob)} · {ageSex(p.dob, p.sex, meta.printedAt)}
        </span>
      </p>
      {data.charts ? (
        <>
          <div className="growth-grid">
            {data.charts.map((c) => (
              <GrowthChart
                key={c.indicator}
                indicator={c.indicator}
                curve={c.curve}
                points={c.points}
                title={bi(GROWTH_L[c.indicator])}
                xLabel={bi(c.indicator === 'wfh' ? GROWTH_L.length : GROWTH_L.age)}
                yLabel=""
                units={{ year: GROWTH_L.year.en, month: GROWTH_L.month.en }}
                width={330}
                height={230}
              />
            ))}
          </div>
          <p className="growth-note">{bi(GROWTH_L.lines)}</p>
        </>
      ) : (
        <p className="growth-note">{bi(GROWTH_L.valuesOnly)}</p>
      )}
      <span className="growth-h">{bi(GROWTH_L.measurements)}</span>
      {data.rows.length === 0 ? (
        <p>{bi(GROWTH_L.none)}</p>
      ) : (
        <table className="growth-table" data-testid="growth-table">
          <thead>
            <tr>
              {[GROWTH_L.date, GROWTH_L.weight, GROWTH_L.height, GROWTH_L.head].map((h) => (
                <th key={h.en}>
                  {h.hi}
                  <br />
                  {h.en}
                </th>
              ))}
              {(['wfa', 'lhfa', 'hcfa', 'wfh'] as const).map((k) => (
                <th key={k}>
                  {GROWTH_L.z.en}
                  <br />
                  {k.toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.date}>
                <td>{formatDate(r.date)}</td>
                <td>{dash(r.weightKg)}</td>
                <td>{dash(r.lengthHeightCm)}</td>
                <td>{dash(r.headCircCm)}</td>
                <td>{zText(r.zWfa)}</td>
                <td>{zText(r.zLhfa)}</td>
                <td>{zText(r.zHcfa)}</td>
                <td>{zText(r.zWfh)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
