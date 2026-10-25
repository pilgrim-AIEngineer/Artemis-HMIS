import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { TEMPLATE_DIR } from '../seed/templates/generate';
import { TEMPLATES } from '../seed/templates/spec';

/** docs/33 §9. */
const LISTED = [
  'patients.xlsx',
  'services_rates.xlsx',
  'doctors.xlsx',
  'drugs.xlsx',
  'lab_tests.xlsx',
  'packages.xlsx',
  'stock_opening.xlsx',
  'pmjay_hbp_rates.xlsx',
];

describe('Excel import templates (docs/33 §9)', () => {
  it('has exactly the templates listed in the spec, committed next to the generator', () => {
    expect(TEMPLATES.map((t) => t.file).sort()).toEqual([...LISTED].sort());
    const onDisk = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.xlsx'));
    expect(onDisk.sort()).toEqual([...LISTED].sort());
  });

  it.each(TEMPLATES)('$file: Data header row equals the spec, no data rows', async (spec) => {
    const file = path.join(TEMPLATE_DIR, spec.file);
    expect(existsSync(file)).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const data = wb.getWorksheet('Data')!;
    const header = (data.getRow(1).values as (string | undefined)[]).slice(1);
    expect(header).toEqual(spec.columns.map((c) => c.key));
    expect(data.rowCount).toBe(1);
    const info = wb.getWorksheet('Instructions')!;
    expect(info.getColumn(1).values.slice(2, 2 + spec.columns.length)).toEqual(
      spec.columns.map((c) => c.key),
    );
  });

  it('uses unique snake_case column keys and money columns in rupees', () => {
    for (const spec of TEMPLATES) {
      const keys = spec.columns.map((c) => c.key);
      expect(new Set(keys).size, spec.file).toBe(keys.length);
      for (const k of keys) expect(k, `${spec.file}:${k}`).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const k of keys.filter((x) => /rate|mrp|price|amount/.test(x))) {
        expect(k, `${spec.file}:${k}`).toMatch(/_inr$|_percent$|^reserved|^rate_/);
      }
    }
  });

  it('puts only synthetic examples in the files (no real-looking patient data)', () => {
    for (const spec of TEMPLATES) {
      for (const col of spec.columns) {
        if (/^(alt_)?mobile$/.test(col.key)) expect(col.example).toMatch(/^90000\d{5}$/);
      }
    }
  });
});
