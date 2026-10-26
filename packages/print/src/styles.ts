import { PAPER_SIZES, pageCss, type PaperSize } from './paper';
import { PRINT_FONT_STACK } from './fonts';

/**
 * Layout of the real templates (OPD sheet, sticker, UHID card, receipt). Millimetre sizes assume the
 * template's own paper (A5 sheet, 50 × 25 mm label); the rules are inert on other templates.
 */
const TEMPLATE_CSS = `
.print-header-compact { padding-bottom: 1mm; margin-bottom: 1.5mm; }
.print-header-compact .print-name { font-size: 1.25em; }
.sheet { display: flex; flex-direction: column; gap: 1.2mm; height: 164mm; }
.sheet-k { display: block; font-size: 0.7em; color: #333; line-height: 1.1; }
.sheet-doctor { font-size: 0.95em; }
.sheet-top { display: flex; gap: 2mm; align-items: stretch; }
.sheet-strip { flex: 1; min-width: 0; border: 0.75pt solid #000; padding: 1mm 1.5mm; }
.sheet-name { font-size: 1.1em; margin-bottom: 0.8mm; }
.sheet-name .sheet-k { display: inline; margin-right: 1.5mm; }
.sheet-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.6mm 1.5mm; }
.sheet-field { min-width: 0; overflow-wrap: anywhere; }
.sheet-codes { width: 26mm; flex: none; text-align: center; }
.sheet-qr { width: 21mm; height: 21mm; margin: 0 auto; }
.sheet-qr svg { display: block; width: 100%; height: 100%; }
.sheet-barcode { height: 6mm; margin-top: 0.8mm; }
.sheet-barcode svg { display: block; width: 100%; height: 100%; }
.sheet-visit-no { font-size: 0.65em; line-height: 1.1; }
.sheet-vitals { display: flex; flex-wrap: wrap; gap: 1mm 2mm; align-items: flex-end; border: 0.75pt solid #000; padding: 1mm 1.5mm; }
.sheet-vital { display: inline-flex; align-items: flex-end; gap: 1mm; }
.sheet-vital-label { font-weight: 700; }
.sheet-vital-box { display: inline-block; min-width: 9mm; height: 5mm; border-bottom: 0.75pt solid #000; padding: 0 0.5mm; text-align: center; }
.sheet-vital-unit { font-size: 0.7em; }
.sheet-vital-more .sheet-vital-box { min-width: 7mm; }
.sheet-vital-key { font-size: 0.7em; margin-left: auto; }
.sheet-alert { border: 1.25pt solid #000; padding: 1mm 1.5mm; margin: 0; }
.sheet-preg { border: 0.75pt solid #000; padding: 1mm 1.5mm; font-size: 0.82em; display: grid; gap: 0.4mm; }
.sheet-preg-risks { font-weight: 700; }
.sheet-context { border: 0.75pt solid #000; padding: 1mm 1.5mm; display: grid; gap: 1mm; }
.sheet-blank-line { display: inline-block; min-width: 40mm; border-bottom: 0.5pt solid #000; height: 3.5mm; vertical-align: bottom; }
.sheet-blank-line.short { min-width: 12mm; }
.sheet-write { flex: 1; display: grid; grid-template-columns: 2fr 3fr; min-height: 30mm; border: 0.75pt solid #000; }
.sheet-write-left { border-right: 0.75pt solid #000; padding: 1mm 1.5mm; }
.sheet-write-right { padding: 1mm 1.5mm; }
.sheet-write .sheet-k { font-size: 0.8em; font-weight: 700; color: #000; }
.sheet-orders { border: 0.75pt solid #000; padding: 1mm 1.5mm; }
.sheet-orders ul { list-style: none; margin: 0.5mm 0 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.7mm 2mm; }
.sheet-orders li { display: flex; align-items: center; gap: 1mm; font-size: 0.9em; }
.sheet-orders .sheet-other { grid-column: span 3; }
.sheet-orders .sheet-other .sheet-blank-line { flex: 1; min-width: 0; }
.sheet-tick { display: inline-block; width: 3mm; height: 3mm; border: 0.75pt solid #000; flex: none; }
.sheet-follow { display: flex; justify-content: space-between; gap: 3mm; flex-wrap: wrap; }
.sheet-sign { text-align: right; padding-top: 4mm; font-size: 0.8em; }
.sheet-sign span { display: inline-block; border-top: 0.5pt solid #000; padding: 0.5mm 4mm 0; }
.sticker-name { font-weight: 700; font-size: 1.2em; line-height: 1.1; }
.sticker-name-hi { line-height: 1.1; }
.sticker-uhid { font-weight: 700; font-size: 1.2em; }
.cards { display: flex; flex-direction: column; align-items: center; gap: 8mm; padding-top: 6mm; }
.card { position: relative; width: 85.6mm; height: 54mm; border: 0.5pt dashed #000; border-radius: 3mm; padding: 2.5mm 3.5mm; display: flex; flex-direction: column; gap: 1.2mm; overflow: hidden; break-inside: avoid; }
.card-tag { position: absolute; top: 0.8mm; right: 3mm; font-size: 0.55em; color: #555; }
.card-head { text-align: center; border-bottom: 1.5pt solid var(--print-accent); padding-bottom: 1mm; }
.card-hospital-hi, .card-hospital { font-weight: 700; font-size: 1.15em; line-height: 1.2; }
.card-sub { font-size: 0.75em; }
.card-main { flex: 1; display: flex; gap: 2mm; align-items: center; }
.card-text { flex: 1; min-width: 0; line-height: 1.25; }
.card-name { font-weight: 700; font-size: 1.3em; line-height: 1.15; }
.card-uhid { font-weight: 700; font-size: 1.15em; margin-top: 0.8mm; }
.card-qr { width: 19mm; height: 19mm; flex: none; }
.card-qr svg { display: block; width: 100%; height: 100%; }
.card-barcode { height: 7mm; }
.card-barcode svg { display: block; width: 100%; height: 100%; }
.card-back { justify-content: center; text-align: center; gap: 1.5mm; }
.card-note { font-size: 0.95em; }
.card-contact { margin-top: 2mm; font-size: 0.8em; border-top: 0.5pt solid #000; padding-top: 1mm; }
.receipt { display: flex; flex-direction: column; gap: 1.5mm; }
.receipt-row { display: flex; justify-content: space-between; gap: 2mm; }
.receipt-row > :last-child { text-align: right; overflow-wrap: anywhere; }
.receipt-k { color: #333; }
.receipt-patient { border-top: 0.5pt dashed #000; border-bottom: 0.5pt dashed #000; padding: 1mm 0; }
.receipt-name { font-weight: 700; font-size: 1.1em; }
.receipt-paid { font-size: 1.35em; font-weight: 700; align-items: baseline; }
.receipt-paid > :last-child, .receipt-amount { white-space: nowrap; }
.receipt-words { font-size: 0.85em; }
.receipt-status { text-align: center; font-weight: 700; border: 1pt solid #000; padding: 0.5mm; }
.receipt-a5 { gap: 2.2mm; font-size: 1.05em; }
.receipt-a5-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2mm 4mm; border-top: 0.5pt dashed #000; border-bottom: 0.5pt dashed #000; padding: 1.5mm 0; }
.receipt-a5-grid > div { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
.receipt-a5-balance { border-top: 0.5pt dashed #000; padding-top: 1mm; }
.receipt-a5-sign { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 8mm; gap: 6mm; }
.receipt-a5-sign > div { flex: 1; }
.receipt-a5-sign-box { margin-top: 9mm; border-top: 0.75pt solid #000; text-align: center; padding-top: 0.5mm; font-size: 0.8em; }
.receipt-a5-sign .receipt-a5-sign-box { margin-top: 0; }
.anc-card { display: flex; flex-direction: column; gap: 1.2mm; font-size: 0.88em; }
.anc-title { text-align: center; font-weight: 700; font-size: 1.15em; }
.anc-patient, .anc-box, .anc-visits { border: 0.75pt solid #000; padding: 0.8mm 1.5mm; break-inside: avoid; }
.anc-table thead { display: table-header-group; }
.anc-table tr { break-inside: avoid; }
.anc-name { font-size: 1.1em; margin-bottom: 0.8mm; }
.anc-h { display: block; font-size: 0.75em; font-weight: 700; margin-bottom: 0.6mm; }
.anc-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.6mm 1.5mm; }
.anc-cell { min-width: 0; overflow-wrap: anywhere; }
.anc-k { display: block; font-size: 0.65em; color: #333; line-height: 1.1; }
.anc-risks ul, .anc-schedule { list-style: none; margin: 0; padding: 0; }
.anc-risks li { font-size: 0.95em; }
.anc-risks li[data-level='alert'] { text-decoration: underline; }
.anc-table { width: 100%; border-collapse: collapse; font-size: 0.78em; }
.anc-table th, .anc-table td { border: 0.5pt solid #555; padding: 0.4mm 0.6mm; text-align: center; vertical-align: top; }
.anc-table th { font-size: 0.85em; line-height: 1.1; }
.anc-table td:last-child { text-align: left; }
.anc-schedule { display: grid; grid-template-columns: 1fr 1fr; gap: 0.3mm 3mm; font-size: 0.74em; line-height: 1.15; }
.anc-schedule li { display: flex; justify-content: space-between; gap: 1.5mm; border-bottom: 0.4pt dotted #777; }
.anc-schedule li[data-state='overdue'] .anc-state { font-weight: 700; }
.anc-state { white-space: nowrap; text-align: right; }
.anc-next { border: 1.25pt solid #000; padding: 1mm 1.5mm; }
.anc-bring { font-size: 0.8em; }
.facility-close { display: flex; flex-direction: column; gap: 3mm; }
.facility-close-h { margin: 2mm 0 0; font-size: 1.05em; }
.facility-close-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
`;

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
.print-watermark.print-stamp span { font-size: ${paper === 'a4' ? 44 : paper === 'a5' ? 32 : paper === 'thermal80' ? 17 : 10}pt; }
.print-watermark.print-stamp.with-duplicate span { transform: rotate(-32deg) translateY(-70%); }
.print-watermark.print-duplicate-mark.with-stamp span { transform: rotate(-32deg) translateY(70%); }
.print-duplicate-line { font-weight: 700; text-align: center; border: 1pt solid #000; padding: 0.5mm; margin-bottom: 1.5mm; }
.print-label { display: flex; gap: 1mm; align-items: center; height: 100%; }
.print-label .print-label-text { flex: 1; min-width: 0; line-height: 1.15; }
.print-label .print-qr { width: 15mm; height: 15mm; flex: none; }
.print-label .print-qr svg { display: block; width: 100%; height: 100%; }
${paper === 'label50x25' ? `.print-root .print-sheet { height: ${p.heightMm}mm; }` : ''}
${TEMPLATE_CSS}
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
