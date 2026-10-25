/**
 * `pnpm --filter @hmis/db db:templates` rewrites the committed `.xlsx` files from `spec.ts`.
 * Output is deterministic (fixed creation date) so regenerating does not create diffs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { TEMPLATES, type TemplateSpec } from './spec';

const FIXED_DATE = new Date('2026-10-26T00:00:00Z');
export const TEMPLATE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function buildWorkbook(spec: TemplateSpec): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HMIS';
  wb.created = FIXED_DATE;
  wb.modified = FIXED_DATE;

  const data = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  data.columns = spec.columns.map((col) => ({
    header: col.key,
    key: col.key,
    width: Math.max(16, col.key.length + 4),
  }));
  const header = data.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F2' } };
  // Text format so leading zeros (pincode), codes and dates are not mangled by Excel.
  spec.columns.forEach((_, i) => {
    data.getColumn(i + 1).numFmt = '@';
  });

  const info = wb.addWorksheet('Instructions');
  info.columns = [
    { header: 'column', key: 'key', width: 28 },
    { header: 'required', key: 'required', width: 10 },
    { header: 'what to enter', key: 'help', width: 70 },
    { header: 'allowed values', key: 'allowed', width: 50 },
    { header: 'example (not imported)', key: 'example', width: 36 },
  ];
  info.getRow(1).font = { bold: true };
  for (const col of spec.columns) {
    info.addRow({
      key: col.key,
      required: col.required ? 'yes' : 'no',
      help: col.help,
      allowed: col.allowed?.join(', ') ?? '',
      example: col.example,
    });
  }
  info.addRow({});
  info.addRow({
    key: `${spec.title} — available from ${spec.phase}`,
    help: 'Fill the Data sheet from row 2. Do not rename or reorder columns. Amounts are in rupees. The import first runs as a dry run with an error report; nothing is saved until you confirm.',
  });
  return wb;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const spec of TEMPLATES) {
    const wb = buildWorkbook(spec);
    await wb.xlsx.writeFile(path.join(TEMPLATE_DIR, spec.file));
    console.log(`db:templates: wrote ${spec.file}`);
  }
}
