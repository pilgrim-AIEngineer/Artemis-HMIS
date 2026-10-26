import { readFileSync } from 'node:fs';
import { IMPORT_TARGETS } from '@hmis/shared';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** MIG-01: every problem code the importer can emit, and every column, has a plain-language text. */
describe('import messages', () => {
  it('has a text for every issue code in the validators and the importer', () => {
    const sources = [
      read('../../../packages/shared/src/import.ts'),
      read('../../../packages/db/src/import.ts'),
    ].join('\n');
    const codes = new Set<string>();
    const fields = new Set(Object.keys(en.import.fields));
    // err('field', 'code') / warn(...) / fail(...) / dup('code'): every quoted word in the call
    // that is not a column name is a problem code (covers `cond ? 'a' : 'b'` arguments too).
    for (const call of sources.matchAll(/\b(?:err|warn|fail|dup)\(([^;]*?)\)(?:;|,\n|\))/g)) {
      for (const q of call[1]!.matchAll(/'([a-zA-Z]+)'/g)) if (!fields.has(q[1]!)) codes.add(q[1]!);
    }
    for (const m of sources.matchAll(/field:\s*'[a-z_]+',\s*code:\s*'(\w+)'/g)) codes.add(m[1]!);
    for (const m of sources.matchAll(/OVERRIDABLE_DUPLICATE_CODES = \[([^\]]+)\]/g)) {
      for (const c of m[1]!.matchAll(/'(\w+)'/g)) codes.add(c[1]!);
    }
    expect(codes.size).toBeGreaterThan(30);
    const have = new Set(Object.keys(en.import.issues));
    expect([...codes].filter((c) => !have.has(c))).toEqual([]);
  });

  it('labels every mappable column', () => {
    const have = new Set(Object.keys(en.import.fields));
    const missing = Object.values(IMPORT_TARGETS)
      .flat()
      .filter((k) => !have.has(k));
    expect(missing).toEqual([]);
    expect(have.has('row')).toBe(true);
  });
});
