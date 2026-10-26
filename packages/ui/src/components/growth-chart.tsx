import type { GrowthIndicator } from '@hmis/shared';

export interface GrowthChartPoint {
  x: number;
  y: number;
  z: number | null;
  on: string;
}

export interface GrowthChartProps {
  indicator: GrowthIndicator;
  curve: { xs: number[]; lines: { z: number; ys: number[] }[] };
  points: GrowthChartPoint[];
  title: string;
  xLabel: string;
  yLabel: string;
  /** Pre-translated unit words for the age axis ticks. */
  units: { year: string; month: string };
  width?: number;
  height?: number;
  className?: string;
}

const MARGIN = { top: 22, right: 30, bottom: 34, left: 40 };
const DAYS_PER_MONTH = 30.4375;

/** "Nice" tick step (1, 2, 5 × 10ⁿ) giving roughly `target` ticks over `span`. */
function niceStep(span: number, target: number): number {
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

const dash = (z: number) => (z === 0 ? undefined : Math.abs(z) === 2 ? '5 3' : '1.5 3');
const width_ = (z: number) => (z === 0 ? 1.8 : Math.abs(z) === 2 ? 1.2 : 0.8);

/**
 * WHO growth chart (OPD-06, docs/11 §4.2): the reference lines at z = −3, −2, 0, +2, +3 and the
 * child's measurements joined in date order. Plain SVG with `currentColor` and no script, so it
 * works on screen, on paper (black on white) and in the worker's PDF. Age axes are in years and
 * months; weight-for-height uses centimetres. Presentational: every word comes in as a prop.
 */
export function GrowthChart({
  indicator,
  curve,
  points,
  title,
  xLabel,
  yLabel,
  units,
  width = 360,
  height = 250,
  className,
}: GrowthChartProps) {
  const byAge = indicator !== 'wfh';
  const xs = curve.xs;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  // Show the reference over the child's own window with some room, not the whole 0–5 y curve.
  const maxPointX = points.reduce((m, p) => Math.max(m, p.x), 0);
  const minPointX = points.reduce((m, p) => Math.min(m, p.x), Infinity);
  const xMinFull = xs[0]!;
  const xMaxFull = xs[xs.length - 1]!;
  let x0: number;
  let x1: number;
  if (byAge) {
    x0 = xMinFull;
    x1 = Math.min(xMaxFull, Math.max(points.length === 0 ? 365 : maxPointX + 183, 365));
  } else if (points.length === 0) {
    x0 = xMinFull;
    x1 = xMaxFull;
  } else {
    x0 = Math.max(xMinFull, minPointX - 8);
    x1 = Math.min(xMaxFull, Math.max(maxPointX + 8, x0 + 20));
  }
  const idx = xs.map((x, i) => [x, i] as const).filter(([x]) => x >= x0 && x <= x1);
  const visible = idx.map(([, i]) => i);
  const allY = [
    ...curve.lines.flatMap((l) => visible.map((i) => l.ys[i]!)),
    ...points.map((p) => p.y),
  ];
  const yStep = niceStep(Math.max(...allY) - Math.min(...allY), 6);
  const y0 = Math.floor(Math.min(...allY) / yStep) * yStep;
  const y1 = Math.ceil(Math.max(...allY) / yStep) * yStep;
  const sx = (x: number) => MARGIN.left + ((x - x0) / (x1 - x0 || 1)) * plotW;
  const sy = (y: number) => MARGIN.top + (1 - (y - y0) / (y1 - y0 || 1)) * plotH;

  const yTicks: number[] = [];
  for (let v = y0; v <= y1 + 1e-9; v += yStep) yTicks.push(Math.round(v * 100) / 100);
  const xTicks: { x: number; label: string }[] = [];
  if (byAge) {
    // One tick every 3 months up to a year, then every 6 months, then yearly.
    const monthsSpan = (x1 - x0) / DAYS_PER_MONTH;
    const stepM = monthsSpan <= 14 ? 3 : monthsSpan <= 40 ? 6 : 12;
    for (let m = 0; m * DAYS_PER_MONTH <= x1 + 1; m += stepM) {
      const day = m * DAYS_PER_MONTH;
      if (day < x0 - 1) continue;
      xTicks.push({
        x: day,
        label: m % 12 === 0 && m > 0 ? `${m / 12}${units.year}` : `${m}${units.month}`,
      });
    }
  } else {
    const step = niceStep(x1 - x0, 6);
    for (let v = Math.ceil(x0 / step) * step; v <= x1 + 1e-9; v += step) {
      xTicks.push({ x: v, label: String(Math.round(v * 10) / 10) });
    }
  }
  const path = (ys: number[]) =>
    visible
      .map((i, k) => `${k === 0 ? 'M' : 'L'}${sx(xs[i]!).toFixed(1)},${sy(ys[i]!).toFixed(1)}`)
      .join(' ');
  const sorted = [...points].sort((a, b) => a.x - b.x);

  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      style={{ maxWidth: '100%', height: 'auto', color: 'inherit' }}
      fontFamily="inherit"
      data-testid={`growth-chart-${indicator}`}
    >
      <text
        x={width / 2}
        y={13}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
        fill="currentColor"
      >
        {title}
      </text>
      <rect
        x={MARGIN.left}
        y={MARGIN.top}
        width={plotW}
        height={plotH}
        fill="none"
        stroke="currentColor"
        strokeWidth={0.8}
      />
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line
            x1={MARGIN.left}
            x2={MARGIN.left + plotW}
            y1={sy(v)}
            y2={sy(v)}
            stroke="currentColor"
            strokeOpacity={0.15}
            strokeWidth={0.6}
          />
          <text x={MARGIN.left - 4} y={sy(v) + 3} textAnchor="end" fontSize={8} fill="currentColor">
            {v}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t.x}`}>
          <line
            x1={sx(t.x)}
            x2={sx(t.x)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
            stroke="currentColor"
            strokeOpacity={0.15}
            strokeWidth={0.6}
          />
          <text
            x={sx(t.x)}
            y={MARGIN.top + plotH + 11}
            textAnchor="middle"
            fontSize={8}
            fill="currentColor"
          >
            {t.label}
          </text>
        </g>
      ))}
      <text
        x={MARGIN.left + plotW / 2}
        y={height - 4}
        textAnchor="middle"
        fontSize={9}
        fill="currentColor"
      >
        {xLabel}
      </text>
      <text
        transform={`translate(9 ${MARGIN.top + plotH / 2}) rotate(-90)`}
        textAnchor="middle"
        fontSize={9}
        fill="currentColor"
      >
        {yLabel}
      </text>
      {curve.lines.map((l) => (
        <g key={l.z} data-z={l.z}>
          <path
            d={path(l.ys)}
            fill="none"
            stroke="currentColor"
            strokeWidth={width_(l.z)}
            strokeDasharray={dash(l.z)}
          />
          <text
            x={MARGIN.left + plotW + 3}
            y={sy(l.ys[visible[visible.length - 1]!]!) + 3}
            fontSize={8}
            fill="currentColor"
          >
            {l.z > 0 ? `+${l.z}` : l.z}
          </text>
        </g>
      ))}
      {sorted.length > 1 && (
        <polyline
          points={sorted.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
        />
      )}
      {sorted.map((p) => (
        <circle
          key={`${p.on}-${p.x}`}
          cx={sx(p.x)}
          cy={sy(p.y)}
          r={3}
          fill="currentColor"
          data-testid="growth-point"
        >
          <title>{`${p.on}: ${p.y}${p.z === null ? '' : ` (z ${p.z})`}`}</title>
        </circle>
      ))}
    </svg>
  );
}
