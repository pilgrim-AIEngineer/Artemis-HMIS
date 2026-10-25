import { describe, expect, it } from 'vitest';
import {
  canSeeGroup,
  homeGroupFor,
  isRouteGroup,
  ROLE_HOME,
  ROUTE_GROUP_DEFS,
  ROUTE_GROUPS,
  visibleGroups,
} from './navigation';
import { PERMISSIONS, ROLE_KEYS } from './permissions';

describe('route groups', () => {
  it('match the ten groups of docs/01 §2', () => {
    expect([...ROUTE_GROUPS].sort()).toEqual([
      'admin',
      'assistant',
      'billing',
      'doctor',
      'lab',
      'nursing',
      'pharmacy',
      'reception',
      'reports',
      'usg',
    ]);
    for (const g of ROUTE_GROUPS) expect(ROUTE_GROUP_DEFS[g].href).toBe(`/${g}`);
    expect(isRouteGroup('admin')).toBe(true);
    expect(isRouteGroup('toString')).toBe(false);
  });

  it('only reference real permission keys', () => {
    for (const def of Object.values(ROUTE_GROUP_DEFS)) {
      for (const p of def.anyOf) expect(PERMISSIONS).toContain(p);
    }
  });

  it('has a home for every default role', () => {
    expect(Object.keys(ROLE_HOME).sort()).toEqual([...ROLE_KEYS].sort());
  });
});

describe('navigation by permission', () => {
  it('shows nothing without permissions', () => {
    expect(visibleGroups([])).toEqual([]);
    expect(homeGroupFor(['reception'], new Set())).toBeNull();
  });

  it('shows a group when any one of its permissions is held', () => {
    expect(visibleGroups(['billing.payment.collect'])).toEqual(['billing']);
    expect(canSeeGroup('admin', new Set(['admin.audit.view']))).toBe(true);
    expect(canSeeGroup('admin', new Set(['billing.payment.collect']))).toBe(false);
  });

  it('keeps the navigation order of ROUTE_GROUPS', () => {
    expect(visibleGroups(['admin.users.manage', 'rx.transcribe', 'patient.create'])).toEqual([
      'reception',
      'assistant',
      'admin',
    ]);
  });

  it('lands on the role home when visible, else the first visible group', () => {
    const perms = new Set(['patient.create', 'billing.payment.collect']);
    expect(homeGroupFor(['cashier'], perms)).toBe('billing');
    expect(homeGroupFor(['custom_role'], perms)).toBe('reception');
    expect(homeGroupFor(['pathologist', 'cashier'], perms)).toBe('billing');
  });
});
