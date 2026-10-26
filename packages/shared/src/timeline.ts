/**
 * Patient timeline (OPD-07, docs/11 §2.8): which kinds of item it lists, which permission shows
 * each kind, and the cursor that pages through them. Restricted (MTP) records are never a kind
 * here: the timeline leaves them out for everybody (AGENTS.md rule 8, docs/03 §5).
 */
import { z } from 'zod';
import type { Permission } from './permissions';
import { uuidSchema } from './primitives';

export const TIMELINE_ITEM_TYPES = [
  'visit',
  'rx',
  'order',
  'bill',
  'anc',
  'vaccine',
  'document',
] as const;
export type TimelineItemType = (typeof TIMELINE_ITEM_TYPES)[number];

/** `patient.view` opens the timeline; each kind of item also needs one of these (any of). */
export const TIMELINE_TYPE_PERMISSIONS = {
  visit: [],
  rx: ['rx.view', 'rx.transcribe', 'rx.verify'],
  order: ['order.create', 'order.cancel'],
  bill: ['billing.bill.create', 'billing.bill.finalize', 'billing.payment.collect'],
  anc: ['clinical.anc.edit'],
  vaccine: ['clinical.paeds.edit'],
  document: ['rx.view', 'rx.transcribe', 'rx.verify'],
} as const satisfies Record<TimelineItemType, readonly Permission[]>;

/** The kinds of item a holder of `permissions` may see. */
export function visibleTimelineTypes(permissions: ReadonlySet<string>): TimelineItemType[] {
  return TIMELINE_ITEM_TYPES.filter((t) => {
    const needs: readonly string[] = TIMELINE_TYPE_PERMISSIONS[t];
    return needs.length === 0 || needs.some((p) => permissions.has(p));
  });
}

export const TIMELINE_DEFAULT_PAGE = 20;
export const TIMELINE_MAX_PAGE = 50;

/** Fixed-width UTC text (microseconds), so plain string comparison orders instants. */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TimelineCursor {
  at: string;
  id: string;
}

export const encodeTimelineCursor = (c: TimelineCursor): string =>
  btoa(`${c.at}|${c.id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Null for anything that is not a cursor this module made. */
export function decodeTimelineCursor(raw: string): TimelineCursor | null {
  try {
    const [at, id, ...rest] = atob(raw.replace(/-/g, '+').replace(/_/g, '/')).split('|');
    if (rest.length > 0 || !at || !id || !AT_RE.test(at) || !ID_RE.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export const timelineInputSchema = z.object({
  patientId: uuidSchema,
  cursor: z.string().max(120).nullish(),
  limit: z.number().int().min(1).max(TIMELINE_MAX_PAGE).default(TIMELINE_DEFAULT_PAGE),
  types: z.array(z.enum(TIMELINE_ITEM_TYPES)).max(TIMELINE_ITEM_TYPES.length).optional(),
});
export type TimelineInput = z.infer<typeof timelineInputSchema>;
