import { PAPER_SIZES, pageCss, type PaperSize } from './paper';
import { PRINT_FONT_STACK } from './fonts';

/**
 * Stylesheet for one printed document. Scoped to `.print-root` so it can sit inside the web app
 * (next to Tailwind) and inside the worker's standalone HTML alike. On screen the sheet imitates
 * the paper (width, margins) for preview; when printing, `@page` takes over (docs/01 §4).
 */
export function printCss(paper: PaperSize): string {
  const p = PAPER_SIZES[paper];
  const compact = paper === 'thermal80' || paper === 'label50x25';
  const base = paper === 'a4' ? 11 : paper === 'a5' ? 10 : paper === 'thermal80' ? 9 : 6.5;
  const sheetHeight = p.heightMm === null ? 'auto' : `${p.heightMm}mm`;
  return `
${pageCss(paper)}
.print-root, .print-root * { box-sizing: border-box; }
.print-root {
  --print-accent: #000;
  font-family: ${PRINT_FONT_STACK};
  font-size: ${base}pt;
  line-height: 1.35;
  color: #000;
  background: #fff;
  font-variant-numeric: tabular-nums;
}
.print-root .print-sheet {
  position: relative;
  width: ${p.widthMm}mm;
  min-height: ${sheetHeight};
  padding: ${p.marginMm}mm;
  margin: 0 auto;
  background: #fff;
  overflow: hidden;
}
.print-root h1, .print-root h2, .print-root p { margin: 0; }
.print-header { text-align: ${compact ? 'center' : 'left'}; border-bottom: 1.5pt solid var(--print-accent); padding-bottom: 1.5mm; margin-bottom: 2mm; }
.print-header .print-name { font-size: ${compact ? '1.15em' : '1.6em'}; font-weight: 700; line-height: 1.2; }
.print-header .print-name-hi { font-size: ${compact ? '1.15em' : '1.6em'}; font-weight: 700; line-height: 1.3; }
.print-header .print-tagline, .print-header .print-line { font-size: 0.85em; }
.print-title { font-size: 1.2em; font-weight: 700; margin: 1mm 0 2mm; }
.print-title span { display: block; }
.print-title .print-title-en { font-size: 0.8em; font-weight: 400; }
.print-table { width: 100%; border-collapse: collapse; }
.print-table th, .print-table td { padding: 0.8mm 1mm; text-align: left; vertical-align: top; border-bottom: 0.5pt solid #777; }
.print-table th { font-weight: 700; border-bottom: 1pt solid #000; }
.print-table .num { text-align: right; white-space: nowrap; }
.print-table tfoot td { font-weight: 700; border-top: 1pt solid #000; border-bottom: 0; }
.print-note { font-size: 0.85em; margin-top: 2mm; }
.print-footer { display: flex; align-items: center; gap: 2mm; margin-top: 3mm; padding-top: 1.5mm; border-top: 0.5pt solid #000; font-size: 0.75em; }
.print-footer .print-qr { width: ${paper === 'a4' ? 18 : paper === 'a5' ? 15 : 13}mm; height: ${paper === 'a4' ? 18 : paper === 'a5' ? 15 : 13}mm; flex: none; }
.print-footer .print-qr svg { display: block; width: 100%; height: 100%; }
.print-footer .print-footer-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.print-watermark {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  pointer-events: none; z-index: 5;
}
.print-watermark span {
  transform: rotate(-32deg); font-weight: 700; letter-spacing: 0.08em; text-align: center;
  font-size: ${paper === 'a4' ? 64 : paper === 'a5' ? 46 : paper === 'thermal80' ? 26 : 14}pt;
  color: rgba(0, 0, 0, 0.14); border: 0.12em solid rgba(0, 0, 0, 0.14); padding: 0 0.2em; line-height: 1.25;
}
.print-watermark small { display: block; font-size: 0.4em; letter-spacing: 0; }
.print-duplicate-line { font-weight: 700; text-align: center; border: 1pt solid #000; padding: 0.5mm; margin-bottom: 1.5mm; }
.print-label { display: flex; gap: 1mm; align-items: center; height: 100%; }
.print-label .print-label-text { flex: 1; min-width: 0; line-height: 1.15; }
.print-label .print-qr { width: 15mm; height: 15mm; flex: none; }
.print-label .print-qr svg { display: block; width: 100%; height: 100%; }
${paper === 'label50x25' ? `.print-root .print-sheet { height: ${p.heightMm}mm; }` : ''}
@media screen {
  .print-root { background: #e5e7eb; padding: 8mm 0; min-height: 100%; }
  .print-root .print-sheet { box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35); }
}
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  .print-root { background: #fff; padding: 0; }
  .print-root .print-sheet { width: auto; min-height: 0; padding: 0; margin: 0; overflow: visible; box-shadow: none; ${
    paper === 'label50x25' ? `height: ${p.heightMm! - 2 * p.marginMm}mm; overflow: hidden;` : ''
  } }
  .print-watermark { position: fixed; }
  .no-print { display: none !important; }
}
`.trim();
}
