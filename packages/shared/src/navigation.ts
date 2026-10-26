import type { Permission, RoleKey } from './permissions';

/**
 * Role home route groups (docs/01 §2, docs/03 §1) and the navigation derived from them. Which
 * groups a user sees is decided from their permissions; the server still enforces every
 * procedure (AGENTS.md rule 6), so this is cosmetic. Keep `anyOf` aligned with the default role
 * bundles in `packages/db/src/rbac.ts` (a unit test checks every default role has a home).
 */

export const ROUTE_GROUPS = [
  'reception',
  'assistant',
  'billing',
  'doctor',
  'nursing',
  'pharmacy',
  'lab',
  'usg',
  'reports',
  'admin',
] as const;
export type RouteGroup = (typeof ROUTE_GROUPS)[number];

export interface RouteGroupDef {
  group: RouteGroup;
  href: `/${RouteGroup}`;
  /** Visible to a user holding at least one of these. */
  anyOf: readonly Permission[];
}

export const ROUTE_GROUP_DEFS: Record<RouteGroup, RouteGroupDef> = {
  reception: {
    group: 'reception',
    href: '/reception',
    anyOf: ['patient.create', 'visit.create', 'queue.manage'],
  },
  assistant: {
    group: 'assistant',
    href: '/assistant',
    anyOf: ['rx.transcribe', 'clinical.note.edit'],
  },
  billing: {
    group: 'billing',
    href: '/billing',
    anyOf: [
      'billing.bill.create',
      'billing.payment.collect',
      'billing.ipd.final',
      'billing.dayclose.own',
      'billing.dayclose.facility',
    ],
  },
  doctor: {
    group: 'doctor',
    href: '/doctor',
    anyOf: ['rx.verify', 'discharge.write', 'ipd.note.write'],
  },
  nursing: {
    group: 'nursing',
    href: '/nursing',
    anyOf: ['vitals.record', 'nursing.chart', 'nursing.mar', 'ipd.transfer', 'newborn.register'],
  },
  pharmacy: {
    group: 'pharmacy',
    href: '/pharmacy',
    anyOf: ['pharmacy.sale', 'pharmacy.purchase', 'pharmacy.return'],
  },
  lab: {
    group: 'lab',
    href: '/lab',
    anyOf: ['lab.sample.collect', 'lab.result.enter', 'lab.result.verify'],
  },
  usg: {
    group: 'usg',
    href: '/usg',
    anyOf: ['usg.report.edit', 'usg.report.sign', 'pcpndt.formf.edit'],
  },
  reports: {
    group: 'reports',
    href: '/reports',
    anyOf: [
      'reports.collection',
      'reports.clinical',
      'reports.financial',
      'reports.owner_dashboard',
    ],
  },
  admin: {
    group: 'admin',
    href: '/admin',
    anyOf: [
      'admin.users.manage',
      'admin.roles.manage',
      'admin.settings.manage',
      'admin.masters.manage',
      'admin.tariff.manage',
      'admin.import.run',
      'admin.audit.view',
    ],
  },
};

export const isRouteGroup = (v: string): v is RouteGroup => Object.hasOwn(ROUTE_GROUP_DEFS, v);

/** True when the permission set grants access to the group's pages. */
export function canSeeGroup(group: RouteGroup, permissions: ReadonlySet<string>): boolean {
  return ROUTE_GROUP_DEFS[group].anyOf.some((p) => permissions.has(p));
}

/** Groups the user may open, in navigation order. */
export function visibleGroups(permissions: ReadonlySet<string> | readonly string[]): RouteGroup[] {
  const set = permissions instanceof Set ? permissions : new Set<string>(permissions);
  return ROUTE_GROUPS.filter((g) => canSeeGroup(g, set));
}

/** docs/03 §1 "Home screen" column. Owner lands on the dashboard (reports). */
export const ROLE_HOME: Record<RoleKey, RouteGroup> = {
  owner: 'reports',
  admin: 'admin',
  doctor: 'doctor',
  doctor_assistant: 'assistant',
  reception: 'reception',
  cashier: 'billing',
  nurse: 'nursing',
  pharmacist: 'pharmacy',
  lab_tech: 'lab',
  pathologist: 'lab',
  usg_doctor: 'usg',
  usg_assistant: 'usg',
  mtp_doctor: 'reports',
  store_keeper: 'pharmacy',
  pmjay_desk: 'billing',
  auditor: 'reports',
};

/**
 * Home group for a user: the first role (in the order given) whose home they can open; otherwise
 * the first visible group; null when they can open none (the launcher still shows "My account").
 * Custom roles have no home of their own.
 */
export function homeGroupFor(
  roles: readonly string[],
  permissions: ReadonlySet<string> | readonly string[],
): RouteGroup | null {
  const set = permissions instanceof Set ? permissions : new Set<string>(permissions);
  for (const r of roles) {
    const home = (ROLE_HOME as Record<string, RouteGroup | undefined>)[r];
    if (home && canSeeGroup(home, set)) return home;
  }
  return visibleGroups(set)[0] ?? null;
}
