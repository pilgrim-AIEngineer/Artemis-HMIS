import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MASTER_KINDS } from '@hmis/shared';
import { describe, expect, it } from 'vitest';
import { MASTER_PROCS } from '@/components/masters/api';
import { ENUMS, MASTER_DEFS } from '@/components/masters/definitions';
import { appRouter } from '@/server/trpc/root';
import en from '../messages/en.json';
import hi from '../messages/hi.json';

/**
 * The masters screens build many i18n keys from data (docs/05 §1.8, AGENTS.md rule 12), which
 * TypeScript cannot check. This proves every key they can ask for exists in en and hi.
 */
const at = (root: object, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], root);

const present = (path: string) => [
  ['en', typeof at(en.admin.masters, path) === 'string'],
  ['hi', typeof at(hi.admin.masters, path) === 'string'],
];

const missing = (paths: Iterable<string>) =>
  [...paths].flatMap((p) =>
    present(p)
      .filter(([, ok]) => !ok)
      .map(([l]) => `${l}:${p}`),
  );

describe('master screens: i18n keys', () => {
  it('has labels for every enum value', () => {
    const keys = Object.entries(ENUMS).flatMap(([group, values]) =>
      values.map((v) => `enums.${group}.${v}`),
    );
    expect(keys.length).toBeGreaterThan(60);
    expect(missing(keys)).toEqual([]);
  });

  it('has title, hint, help, new and empty text for every master kind', () => {
    const keys = MASTER_KINDS.flatMap((k) =>
      ['title', 'hint', 'help', 'new', 'empty'].map((x) => `kinds.${k}.${x}`),
    );
    expect(missing(keys)).toEqual([]);
  });

  it('has a label for every form field and column, and every help text', () => {
    const keys = new Set<string>();
    for (const def of Object.values(MASTER_DEFS)) {
      for (const f of def.fields) {
        keys.add(`fields.${f.name}`);
        if (f.help) keys.add(`help.${f.help}`);
      }
      for (const c of def.columns) keys.add(`fields.${c.key}`);
      for (const f of def.filters ?? []) keys.add(`fields.${f.name}`);
    }
    expect(missing(keys)).toEqual([]);
  });

  it('has every static key used in the masters components', () => {
    const dir = new URL('../src/components/masters', import.meta.url).pathname;
    const used = new Set<string>();
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
      const src = readFileSync(join(dir, name), 'utf8');
      for (const m of src.matchAll(/\bt\('([A-Za-z][A-Za-z0-9_.]*)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(40);
    expect(missing(used)).toEqual([]);
  });

  it('has the error and validation texts the masters procedures and schemas raise', () => {
    const errs = Object.keys(en.errors.masters);
    expect(errs.length).toBeGreaterThan(10);
    expect(Object.keys(hi.errors.masters).sort()).toEqual(errs.sort());
    for (const k of ['tooLong', 'code', 'dateOrder', 'exemptNoGst']) {
      expect(en.validation).toHaveProperty(k);
      expect(hi.validation).toHaveProperty(k);
    }
  });
});

describe('master screens: procedures', () => {
  const procedures = new Set(Object.keys(appRouter._def.procedures));

  it('MASTER_PROCS names exist on the router', () => {
    for (const procs of Object.values(MASTER_PROCS)) {
      for (const name of Object.values(procs))
        expect(procedures.has(`masters.${name}`), name).toBe(true);
    }
  });

  it('every procedure the components call exists', () => {
    const dir = new URL('../src/components/masters', import.meta.url).pathname;
    const names = new Set<string>();
    for (const name of readdirSync(dir)) {
      if (!/\.tsx?$/.test(name)) continue;
      const src = readFileSync(join(dir, name), 'utf8');
      for (const m of src.matchAll(/call\(\s*'([A-Za-z]+)'/g)) names.add(m[1]!);
    }
    expect(names.size).toBeGreaterThan(4);
    for (const n of names) expect(procedures.has(`masters.${n}`), n).toBe(true);
  });

  it('every kind’s fields name real schema keys', () => {
    for (const def of Object.values(MASTER_DEFS)) {
      const shape = Object.keys(
        (def.schema as unknown as { _zod: { def: { shape?: object } } })._zod.def.shape ?? {},
      );
      if (shape.length === 0) continue; // refined schemas expose no shape here
      for (const f of def.fields) expect(shape, `${def.kind}.${f.name}`).toContain(f.name);
    }
  });
});
