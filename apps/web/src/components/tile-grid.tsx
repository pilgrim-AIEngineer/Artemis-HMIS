import type { LucideIcon } from 'lucide-react';
import {
  Building2,
  Database,
  ClipboardList,
  FlaskConical,
  HandCoins,
  HeartPulse,
  Monitor,
  Tv,
  Pill,
  Printer,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
  UserCog,
  UserRoundPlus,
  Users,
  ChartColumn,
} from 'lucide-react';
import Link from 'next/link';
import type { Permission, RouteGroup } from '@hmis/shared';

export interface Tile {
  href: string;
  title: string;
  hint: string;
  icon: LucideIcon;
}

export const GROUP_ICONS: Record<RouteGroup, LucideIcon> = {
  reception: UserRoundPlus,
  assistant: ClipboardList,
  billing: HandCoins,
  doctor: Stethoscope,
  nursing: HeartPulse,
  pharmacy: Pill,
  lab: FlaskConical,
  usg: ScanLine,
  reports: ChartColumn,
  admin: SlidersHorizontal,
};

export interface AdminTileDef {
  href: string;
  key:
    'users' | 'roles' | 'workstations' | 'facility' | 'settings' | 'print' | 'masters' | 'display';
  icon: LucideIcon;
  /** Visible to a user holding any of these. */
  permission: Permission | readonly Permission[];
}

/** Administration screens (docs/05 §1.1: big tiles, not menus). */
export const ADMIN_TILES: AdminTileDef[] = [
  { href: '/admin/users', key: 'users', icon: Users, permission: 'admin.users.manage' },
  { href: '/admin/roles', key: 'roles', icon: ShieldCheck, permission: 'admin.roles.manage' },
  {
    href: '/admin/facility',
    key: 'facility',
    icon: Building2,
    permission: 'admin.settings.manage',
  },
  {
    href: '/admin/settings',
    key: 'settings',
    icon: SlidersHorizontal,
    permission: 'admin.settings.manage',
  },
  { href: '/admin/print', key: 'print', icon: Printer, permission: 'admin.settings.manage' },
  {
    href: '/admin/masters',
    key: 'masters',
    icon: Database,
    permission: ['admin.masters.manage', 'admin.tariff.manage'],
  },
  { href: '/admin/display', key: 'display', icon: Tv, permission: 'queue.display.manage' },
  {
    href: '/admin/workstations',
    key: 'workstations',
    icon: Monitor,
    permission: 'admin.settings.manage',
  },
];

export const ACCOUNT_ICON = UserCog;

export function TileGrid({ tiles }: { tiles: Tile[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map(({ href, title, hint, icon: Icon }) => (
        <li key={href}>
          <Link
            href={href}
            className="flex h-full min-h-28 items-start gap-4 rounded-lg border-2 bg-card p-5 outline-none hover:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/60"
          >
            <Icon aria-hidden className="mt-1 size-8 shrink-0 text-primary" />
            <span className="space-y-1">
              <span className="block text-xl font-semibold">{title}</span>
              <span className="block text-muted-foreground">{hint}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
