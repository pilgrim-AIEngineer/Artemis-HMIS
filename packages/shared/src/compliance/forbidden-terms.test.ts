import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_TERMS,
  findForbiddenTerms,
  isAllowedKeyPath,
  matchVariants,
} from './forbidden-terms';
import { scanRepo, scopeFor } from './scan';

// Terms are never written literally here: they come from the term list's own examples.
const example = (id: string) => {
  const t = FORBIDDEN_TERMS.find((x) => x.id === id);
  if (!t?.examples[0]) throw new Error(`no example for ${id}`);
  return t.examples[0];
};
const alwaysExample = example('pn01');
const strictExample = example('pn15');

describe('FORBIDDEN_TERMS', () => {
  it('covers every pattern listed in docs/30 §1 with unique ids', () => {
    expect(FORBIDDEN_TERMS).toHaveLength(15);
    expect(new Set(FORBIDDEN_TERMS.map((t) => t.id)).size).toBe(15);
    expect(FORBIDDEN_TERMS.filter((t) => t.tier === 'always')).toHaveLength(8);
  });

  it.each(FORBIDDEN_TERMS.flatMap((t) => t.examples.map((e) => [t.id, e] as const)))(
    '%s matches example %j',
    (id, text) => {
      expect(findForbiddenTerms(`prefix ${text} suffix`).map((h) => h.termId)).toContain(id);
    },
  );

  it('is case-insensitive', () => {
    expect(findForbiddenTerms(alwaysExample.toUpperCase())).not.toHaveLength(0);
  });

  it('catches identifiers in camelCase, snake_case and kebab-case', () => {
    const [a, b] = alwaysExample.split(' ') as [string, string];
    const camel = `${a}${b[0]!.toUpperCase()}${b.slice(1)}`;
    for (const id of [camel, `${a}_${b}`, `${a.toUpperCase()}_${b.toUpperCase()}`, `${a}-${b}`]) {
      expect(findForbiddenTerms(`column: ${id}`), id).not.toHaveLength(0);
    }
  });

  it('does not flag ordinary clinical words', () => {
    for (const ok of [
      'patient sex',
      'sex of the living child',
      'fetal heart rate',
      'fetal presentation',
      'gestational age',
      'baby weight',
      'ladder',
    ]) {
      expect(findForbiddenTerms(ok), ok).toEqual([]);
    }
  });

  it('respects tiers: strict terms are not applied in always tier', () => {
    expect(findForbiddenTerms(strictExample, { tier: 'always' })).toEqual([]);
    expect(findForbiddenTerms(strictExample, { tier: 'strict' })).not.toHaveLength(0);
    expect(findForbiddenTerms(alwaysExample, { tier: 'always' })).not.toHaveLength(0);
  });

  it('normalises Devanagari nukta forms', () => {
    const decomposed = example('pn13').normalize('NFD');
    expect(findForbiddenTerms(decomposed).map((h) => h.termId)).toContain('pn13');
    expect(matchVariants(decomposed)[0]).toBe(decomposed.normalize('NFC'));
  });

  it('allows only the exact Form F living-children key', () => {
    expect(isAllowedKeyPath('living_children[].sex')).toBe(true);
    expect(isAllowedKeyPath('formF.living_children[].sex')).toBe(true);
    expect(isAllowedKeyPath('formF.living_children.sex')).toBe(true);
    expect(isAllowedKeyPath('formF.sex')).toBe(false);
    expect(isAllowedKeyPath('formF.living_children[].sexNote')).toBe(false);
  });
});

describe('scope', () => {
  it.each([
    ['packages/db/schema/usg.ts', 'strict'],
    ['packages/db/schema/usg-report.ts', 'strict'],
    ['packages/print/src/templates/usg-obstetric.tsx', 'strict'],
    ['packages/print/src/usg/report.tsx', 'strict'],
    ['packages/shared/src/usg/templates.ts', 'strict'],
    ['packages/db/seed/masters/usg-procedures.json', 'strict'],
    ['packages/shared/forms/form-f.ts', 'strict'],
    ['packages/shared/src/forms/form-f.schema.json', 'strict'],
    ['apps/worker/src/prompts/summary.md', 'strict'],
    ['apps/web/src/ai/discharge.prompt.txt', 'strict'],
    ['packages/db/schema/newborn.ts', 'always'],
    ['packages/db/schema/patient.ts', 'always'],
    ['apps/web/messages/hi.json', 'always'],
  ])('%s → %s', (file, scope) => {
    expect(scopeFor(file)).toBe(scope);
  });
});

describe('scanRepo', () => {
  let root: string;
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'hmis-forbidden-'));
    // strict scope: any term fails
    write('packages/db/schema/usg.ts', `export const label = '${strictExample}';\n`);
    // always scope: unambiguous term fails, strict-only term passes
    write('packages/db/schema/patient.ts', `// ok: ${strictExample}\n// bad: ${alwaysExample}\n`);
    // newborn: strict-only term is normal data
    write('packages/db/schema/newborn.ts', `export const sexLabel = '${strictExample}';\n`);
    // i18n: general keys allow strict-only words, usg/formF namespaces do not,
    // except the Form F living-children key.
    write(
      'apps/web/messages/hi.json',
      JSON.stringify({
        patient: { sex: strictExample },
        usg: { field: strictExample },
        formF: { living_children: { sex: strictExample } },
        common: { bad: alwaysExample },
      }),
    );
    // path itself
    write(`packages/print/src/${alwaysExample.replace(' ', '-')}.tsx`, 'export {};\n');
    // skipped directories
    write('apps/web/node_modules/x/usg.js', alwaysExample);
    // allowlisted files
    write('packages/shared/src/compliance/forbidden-terms.ts', alwaysExample);
    write('docs/30-compliance.md', alwaysExample);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports exactly the expected findings', () => {
    const got = scanRepo(root, ['apps', 'packages', 'docs'])
      .map((f) => `${f.file}#${f.location}#${f.termId}`)
      .sort();
    expect(got).toEqual(
      [
        'apps/web/messages/hi.json#common.bad#pn01',
        'apps/web/messages/hi.json#usg.field#pn15',
        'packages/db/schema/patient.ts#2#pn01',
        'packages/db/schema/usg.ts#1#pn15',
        `packages/print/src/${alwaysExample.replace(' ', '-')}.tsx#path#pn01`,
      ].sort(),
    );
  });
});

describe('this repository', () => {
  it('contains no forbidden terms (same check as pnpm check:forbidden)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    expect(scanRepo(repoRoot)).toEqual([]);
  });
});
