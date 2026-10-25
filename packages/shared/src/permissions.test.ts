import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TERMS } from './compliance/forbidden-terms';
import { isPermission, PERMISSIONS, RESTRICTED_PERMISSIONS, ROLE_KEYS } from './permissions';

const doc = readFileSync(new URL('../../../docs/03-roles-permissions.md', import.meta.url), 'utf8');

describe('permission keys', () => {
  it('are unique and follow module.action', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const k of PERMISSIONS) expect(k).toMatch(/^[a-z]+(\.[a-z0-9_]+)+$/);
  });

  it('cover every key listed in docs/03 §2 (the only extra is mtp.audit.view from D-2)', () => {
    const block = doc.split('## 2. Permission keys')[1]?.split('```')[1] ?? '';
    const documented: string[] = block.match(/[a-z0-9_]+(?:\.[a-z0-9_]+)+/g) ?? [];
    expect(documented.length).toBeGreaterThan(70);
    expect(PERMISSIONS.filter((p) => !documented.includes(p))).toEqual(['mtp.audit.view']);
    expect(documented.filter((k) => !isPermission(k))).toEqual([]);
  });

  it('role keys match docs/03 §1', () => {
    const section = doc.split('## 1. Default roles')[1]?.split('## 2.')[0] ?? '';
    const documented = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect([...ROLE_KEYS]).toEqual(documented);
  });

  it('type guard and restricted subset', () => {
    expect(isPermission('billing.discount.approve')).toBe(true);
    expect(isPermission('billing.nothing')).toBe(false);
    expect(isPermission(42)).toBe(false);
    for (const k of RESTRICTED_PERMISSIONS) expect(isPermission(k)).toBe(true);
  });

  it('carry no forbidden term (rule 7)', () => {
    for (const k of PERMISSIONS) {
      for (const t of FORBIDDEN_TERMS) expect(t.pattern.test(k)).toBe(false);
    }
  });
});
