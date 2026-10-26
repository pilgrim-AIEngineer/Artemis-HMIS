/**
 * OPD visit and token queue domain (REG-03, REG-04, docs/10 §4–§5). Pure functions: the follow-up
 * rule, the queue state machine and the queue ordering. The db package applies them inside
 * transactions; keeping them here makes the edge cases cheap to test.
 */
import { z } from 'zod';
import { addDays, compareDates, daysBetween, parseIsoDate } from './dates';
import { VISIT_TYPES, type VisitType } from './masters';
import { idempotencyKeySchema, uuidSchema } from './primitives';

export const ENCOUNTER_TYPES = ['opd', 'ipd', 'daycare', 'emergency'] as const;
export type EncounterType = (typeof ENCOUNTER_TYPES)[number];

export const ENCOUNTER_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

export const QUEUE_PRIORITIES = [
  'normal',
  'emergency',
  'labour',
  'elderly',
  'staff',
  'vip',
] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

/** Priorities that can be put ahead of normal tokens, in the default order (docs/10 §5). */
export const PRIORITY_CLASSES = ['emergency', 'labour', 'elderly', 'staff', 'vip'] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

/** Red cards that jump to the top (docs/10 §5). */
export const URGENT_PRIORITIES: readonly QueuePriority[] = ['emergency', 'labour'];

/** Forward order of the OPD journey (docs/10 §5). */
export const QUEUE_FLOW = [
  'waiting',
  'vitals_done',
  'with_doctor',
  'seen',
  'rx_entered',
  'billed_orders',
  'done',
] as const;
export const QUEUE_STATES = [...QUEUE_FLOW, 'no_show', 'cancelled'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** Why a token exists: how its issue was authorised (money-relevant, kept for audit). */
export const TOKEN_ISSUE_BASES = [
  'free',
  'before_payment_setting',
  'payment',
  'manual_fee_pending',
] as const;
export type TokenIssueBasis = (typeof TOKEN_ISSUE_BASES)[number];

/** How the consultation fee was decided. */
export const FEE_BASES = ['tariff', 'free_follow_up', 'no_rule', 'no_rate'] as const;
export type FeeBasis = (typeof FEE_BASES)[number];

/** States in which the patient has not been seen yet (queue still moves them). */
export const PENDING_STATES: readonly QueueState[] = ['waiting', 'vitals_done'];
/** States that count as "in the queue" on the board (everything not finished or dropped). */
export const ACTIVE_STATES: readonly QueueState[] = [
  'waiting',
  'vitals_done',
  'with_doctor',
  'seen',
  'rx_entered',
  'billed_orders',
];

const flowIndex = (s: QueueState) => (QUEUE_FLOW as readonly string[]).indexOf(s);

/**
 * Whether a token may move `from` → `to`. Forward moves along the flow may skip steps (staff skip
 * the vitals desk or the "call" press on a busy morning); backward moves are only the ones the
 * queue screen offers: `with_doctor` back to the pending states (skip / recall without the
 * patient) and `no_show` back to `waiting` (late arrival). `done` and `cancelled` are final.
 */
export function canTransition(from: QueueState, to: QueueState): boolean {
  if (from === to) return false;
  if (from === 'done' || from === 'cancelled') return false;
  if (from === 'no_show') return to === 'waiting';
  if (to === 'no_show' || to === 'cancelled')
    return PENDING_STATES.includes(from) || from === 'with_doctor';
  if (from === 'with_doctor' && PENDING_STATES.includes(to)) return true;
  return flowIndex(to) > flowIndex(from);
}

// ---------------------------------------------------------------- follow-up rule (docs/10 §4)

export interface FollowUpPolicy {
  /** A follow-up is possible up to and including this many days after the consultation. */
  validityDays: number;
  /** Follow-ups within the window that carry the follow-up fee; 0 = every visit is a new one. */
  freeFollowUps: number;
}

/** A past, non-cancelled OPD visit of this patient with the same doctor. */
export interface PriorVisit {
  /** IST calendar date of the visit, `YYYY-MM-DD`. */
  date: string;
  visitType: VisitType;
}

export interface FollowUpEvaluation {
  eligible: boolean;
  /** The consultation the window runs from (the latest non-follow-up visit). */
  indexDate: string | null;
  /** Last day on which a follow-up still counts. */
  validUntil: string | null;
  usedFollowUps: number;
  remainingFollowUps: number;
  reason: 'eligible' | 'no_prior_visit' | 'expired' | 'exhausted' | 'disabled';
}

/**
 * Follow-up validity (Q6, docs/40): the window runs from the patient's latest consultation with
 * the same doctor that was not itself a follow-up (a follow-up does not extend it), the last
 * valid day is `index + validityDays` (so 7 days = the same weekday next week), and the free
 * follow-ups used are those taken since that consultation. Dates are IST calendar days, so a
 * 23:50 visit does not drift to the next day. Pure; `today` is the IST date of the new visit.
 */
export function evaluateFollowUp(
  priors: readonly PriorVisit[],
  policy: FollowUpPolicy,
  today: string,
): FollowUpEvaluation {
  const none = (reason: FollowUpEvaluation['reason']): FollowUpEvaluation => ({
    eligible: false,
    indexDate: null,
    validUntil: null,
    usedFollowUps: 0,
    remainingFollowUps: 0,
    reason,
  });
  const todayD = parseIsoDate(today);
  const past = priors.filter((p) => compareDates(parseIsoDate(p.date), todayD) <= 0);
  const index = past
    .filter((p) => p.visitType !== 'follow_up')
    .map((p) => p.date)
    .sort()
    .at(-1);
  if (!index) return none('no_prior_visit');
  const validUntilD = addDays(parseIsoDate(index), policy.validityDays);
  const validUntil = `${validUntilD.year}-${String(validUntilD.month).padStart(2, '0')}-${String(validUntilD.day).padStart(2, '0')}`;
  const used = past.filter((p) => p.visitType === 'follow_up' && p.date >= index).length;
  const base = {
    indexDate: index,
    validUntil,
    usedFollowUps: used,
    remainingFollowUps: Math.max(0, policy.freeFollowUps - used),
  };
  if (policy.freeFollowUps <= 0) return { ...base, eligible: false, reason: 'disabled' };
  if (daysBetween(parseIsoDate(index), todayD) > policy.validityDays) {
    return { ...base, eligible: false, reason: 'expired' };
  }
  if (used >= policy.freeFollowUps) return { ...base, eligible: false, reason: 'exhausted' };
  return { ...base, eligible: true, reason: 'eligible' };
}

export interface VisitTypeContext {
  followUp: FollowUpEvaluation;
  /** The patient has an active pregnancy and the doctor is a gynaecologist (set once ANC lands). */
  ancActive?: boolean;
  /** A child with a vaccine due (set once the immunisation schedule lands). */
  vaccineDue?: boolean;
  emergency?: boolean;
}

/** Suggested visit type in the order of docs/10 §4; reception can still change it. */
export function suggestVisitType(ctx: VisitTypeContext): VisitType {
  if (ctx.emergency) return 'emergency';
  if (ctx.followUp.eligible) return 'follow_up';
  if (ctx.ancActive) return 'anc';
  if (ctx.vaccineDue) return 'paeds_vaccination';
  return 'new';
}

// ---------------------------------------------------------------- queue order (docs/10 §5)

export const DEFAULT_PRIORITY_ORDER: readonly PriorityClass[] = PRIORITY_CLASSES;

/** 0 = first. Priorities not listed in the setting, and `normal`, come after the listed ones. */
export function priorityRank(
  priority: QueuePriority,
  order: readonly PriorityClass[] = DEFAULT_PRIORITY_ORDER,
): number {
  const i = priority === 'normal' ? -1 : order.indexOf(priority);
  return i < 0 ? order.length : i;
}

export interface Orderable {
  priority: QueuePriority;
  /** Position inside a priority class; starts as `tokenNo * QUEUE_ORDER_STEP` (skips renumber it). */
  queueOrder: number;
  tokenNo: number;
}

/** Gap between consecutive initial `queue_order` values, leaving room for "skip" insertions. */
export const QUEUE_ORDER_STEP = 1000;
/** Skip moves a patient behind this many waiting patients (docs/10 §5). */
export const SKIP_AHEAD = 3;

export function compareQueue(
  a: Orderable,
  b: Orderable,
  order: readonly PriorityClass[] = DEFAULT_PRIORITY_ORDER,
): number {
  return (
    priorityRank(a.priority, order) - priorityRank(b.priority, order) ||
    a.queueOrder - b.queueOrder ||
    a.tokenNo - b.tokenNo
  );
}

/**
 * New `queue_order` for a skipped token: just after the SKIP_AHEAD-th patient behind it in the
 * same priority class, or after the last one when fewer wait. `behind` are the other still-pending
 * tokens of that class, in queue order, that currently come after it.
 */
export function orderAfterSkip(
  own: number,
  behind: readonly number[],
  ahead: number = SKIP_AHEAD,
): number {
  const sorted = [...behind].sort((a, b) => a - b);
  const anchor = sorted[Math.min(ahead, sorted.length) - 1];
  return anchor === undefined ? own : anchor + 1;
}

// ---------------------------------------------------------------- inputs

export const createVisitSchema = z.object({
  patientId: uuidSchema,
  doctorId: uuidSchema,
  /** Omitted: the suggestion (follow-up if valid, else new). */
  visitType: z.enum(VISIT_TYPES).optional(),
  priority: z.enum(QUEUE_PRIORITIES).default('normal'),
  chiefComplaint: z.string().trim().max(200).optional(),
  /** The patient already has a visit with this doctor today; confirm a second one. */
  allowRepeatToday: z.boolean().default(false),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateVisitInput = z.input<typeof createVisitSchema>;

export const visitPreviewSchema = z.object({
  patientId: uuidSchema,
  doctorId: uuidSchema,
  visitType: z.enum(VISIT_TYPES).optional(),
});

export const queueBoardSchema = z.object({
  doctorIds: z.array(uuidSchema).max(20).optional(),
});

export const tokenIdSchema = z.object({ tokenId: uuidSchema });
export const callNextSchema = z.object({ doctorId: uuidSchema });
export const noShowSchema = z.object({
  tokenId: uuidSchema,
  reason: z.string().trim().min(3, 'validation.reason').max(200),
});
export const transferSchema = z.object({ tokenId: uuidSchema, doctorId: uuidSchema });
export const prioritySchema = z.object({
  tokenId: uuidSchema,
  priority: z.enum(QUEUE_PRIORITIES),
});
export const cancelVisitSchema = z.object({
  encounterId: uuidSchema,
  reason: z.string().trim().min(3, 'validation.reason').max(200),
});

/** Display order of priority classes (`queue.priorityOrder` setting). */
export const priorityOrderSchema = z
  .array(z.enum(PRIORITY_CLASSES))
  .max(PRIORITY_CLASSES.length)
  .refine((a) => new Set(a).size === a.length, 'validation.invalid');
