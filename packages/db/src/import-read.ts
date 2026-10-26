/**
 * Reads an uploaded `.xlsx` / `.csv` into a `StagedSheet` (MIG-01). Server side only: exceljs is
 * heavy and the upload is authenticated. Every cell becomes text; dates become `YYYY-MM-DD`.
 */
import {
  decodeCsvBytes,
  ImportFileError,
  MAX_IMPORT_BYTES,
  parseCsv,
  stageGrid,
  type ImportKind,
  type StagedSheet,
} from '@hmis/shared';
import ExcelJS from 'exceljs';

/** More rows than this in a sheet is not a rate list or a clinic register: refuse before reading. */
const MAX_SHEET_ROWS = 50_000;

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // Date cells carry no zone; exceljs gives UTC midnight for a date-only cell.
    return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  }
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return v.result === undefined ? '' : cellText(v.result);
    if ('text' in v) return String(v.text);
    return ''; // error cells (#N/A …)
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function sheetGrid(ws: ExcelJS.Worksheet): string[][] {
  if (ws.rowCount > MAX_SHEET_ROWS) throw new ImportFileError('tooManyRows');
  const grid: string[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value));
    grid.push(cells);
  }
  return grid;
}

/**
 * Picks the worksheet: the one called `Data` (the template) when it has a usable header, else the
 * first sheet that has one. Returns the staged rows with the auto-detected column mapping.
 */
export async function readSpreadsheet(
  kind: ImportKind,
  bytes: Uint8Array,
  fileName: string,
): Promise<StagedSheet> {
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ImportFileError('unreadable');
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (['csv', 'tsv', 'txt'].includes(ext)) {
    return stageGrid(kind, parseCsv(decodeCsvBytes(bytes)));
  }
  if (ext !== 'xlsx') throw new ImportFileError('unreadable');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  } catch {
    throw new ImportFileError('unreadable');
  }
  const sheets = [...wb.worksheets].sort(
    (a, b) => Number(b.name.toLowerCase() === 'data') - Number(a.name.toLowerCase() === 'data'),
  );
  let firstError: ImportFileError | null = null;
  for (const ws of sheets) {
    if (ws.state !== 'visible' || ws.name.toLowerCase() === 'instructions') continue;
    try {
      return stageGrid(kind, sheetGrid(ws));
    } catch (err) {
      if (!(err instanceof ImportFileError)) throw err;
      // A wrong sheet is skipped, but "too many rows" is about the file and wins.
      if (err.code === 'tooManyRows') throw err;
      firstError ??= err;
    }
  }
  throw firstError ?? new ImportFileError('empty');
}
