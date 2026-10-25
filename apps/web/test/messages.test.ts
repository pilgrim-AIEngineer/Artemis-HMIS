import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import hi from '../messages/hi.json';

const keys = (o: object, prefix = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe('i18n messages', () => {
  it('hi has exactly the same keys as en', () => {
    expect(keys(hi).sort()).toEqual(keys(en).sort());
  });

  it('has no empty strings', () => {
    for (const [name, m] of Object.entries({ en, hi })) {
      const empty = keys(m).filter((k) => {
        const v = k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], m);
        return typeof v !== 'string' || v.trim() === '';
      });
      expect(empty, name).toEqual([]);
    }
  });
});

describe('message keys used in code', () => {
  /** Every `errors.*` / `validation.*` key thrown by the server or zod schemas has a text. */
  it('exist in en (and so in hi)', () => {
    const roots = [
      new URL('../src/server', import.meta.url).pathname,
      new URL('../src/lib', import.meta.url).pathname,
      new URL('../../../packages/shared/src', import.meta.url).pathname,
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) files.push(p);
      }
    };
    roots.forEach(walk);
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/'((?:errors|validation)\.[a-zA-Z.]+)'/g)) {
        used.add(m[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(20);
    const all = new Set(keys(en));
    expect([...used].filter((k) => !all.has(k))).toEqual([]);
  });
});
