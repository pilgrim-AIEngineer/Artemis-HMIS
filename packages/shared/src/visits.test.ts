import { describe, expect, it } from 'vitest';
import {
  QUEUE_FLOW,
  QUEUE_STATES,
  canTransition,
  compareQueue,
  evaluateFollowUp,
  orderAfterSkip,
  priorityRank,
  suggestVisitType,
  type FollowUpPolicy,
  type PriorVisit,
  type QueueState,
} from './visits';

const policy: FollowUpPolicy = { validityDays: 7, freeFollowUps: 1 };
const v = (date: string, visitType: PriorVisit['visitType'] = 'new'): PriorVisit => ({
  date,
  visitType,
});

describe('follow-up validity (Q6: 7 days, 1 free)', () => {
  it('is not a follow-up without a prior visit', () => {
    expect(evaluateFollowUp([], policy, '2026-10-26')).toMatchObject({
      eligible: false,
      reason: 'no_prior_visit',
    });
  });

  it('counts the same day and day 7 inclusive, not day 8', () => {
    expect(evaluateFollowUp([v('2026-10-26')], policy, '2026-10-26').eligible).toBe(true);
    const day7 = evaluateFollowUp([v('2026-10-19')], policy, '2026-10-26');
    expect(day7).toMatchObject({ eligible: true, validUntil: '2026-10-26' });
    const day8 = evaluateFollowUp([v('2026-10-18')], policy, '2026-10-26');
    expect(day8).toMatchObject({ eligible: false, reason: 'expired', validUntil: '2026-10-25' });
  });

  it('crosses month and year ends and a leap day', () => {
    expect(evaluateFollowUp([v('2026-12-28')], policy, '2027-01-04').eligible).toBe(true);
    expect(evaluateFollowUp([v('2026-12-28')], policy, '2027-01-05').eligible).toBe(false);
    expect(evaluateFollowUp([v('2028-02-25')], policy, '2028-03-03').eligible).toBe(true);
    expect(evaluateFollowUp([v('2028-02-25')], policy, '2028-03-04').eligible).toBe(false);
  });

  it('validity 0 means the same day only', () => {
    const p = { validityDays: 0, freeFollowUps: 1 };
    expect(evaluateFollowUp([v('2026-10-26')], p, '2026-10-26').eligible).toBe(true);
    expect(evaluateFollowUp([v('2026-10-26')], p, '2026-10-27').eligible).toBe(false);
  });

  it('is exhausted after the free follow-ups are used', () => {
    const priors = [v('2026-10-20'), v('2026-10-22', 'follow_up')];
    expect(evaluateFollowUp(priors, policy, '2026-10-24')).toMatchObject({
      eligible: false,
      reason: 'exhausted',
      usedFollowUps: 1,
      remainingFollowUps: 0,
    });
    const two = { validityDays: 7, freeFollowUps: 2 };
    expect(evaluateFollowUp(priors, two, '2026-10-24')).toMatchObject({
      eligible: true,
      remainingFollowUps: 1,
    });
  });

  it('does not let a follow-up extend the window', () => {
    const priors = [v('2026-10-10'), v('2026-10-16', 'follow_up')];
    const two = { validityDays: 7, freeFollowUps: 2 };
    expect(evaluateFollowUp(priors, two, '2026-10-18')).toMatchObject({
      eligible: false,
      reason: 'expired',
      indexDate: '2026-10-10',
    });
  });

  it('starts a fresh window and count at a new consultation', () => {
    const priors = [v('2026-10-01'), v('2026-10-03', 'follow_up'), v('2026-10-20')];
    expect(evaluateFollowUp(priors, policy, '2026-10-24')).toMatchObject({
      eligible: true,
      indexDate: '2026-10-20',
      usedFollowUps: 0,
    });
  });

  it('is off when no free follow-ups are allowed', () => {
    const p = { validityDays: 7, freeFollowUps: 0 };
    expect(evaluateFollowUp([v('2026-10-25')], p, '2026-10-26')).toMatchObject({
      eligible: false,
      reason: 'disabled',
    });
  });

  it('ignores visits dated after the new one (back-entered)', () => {
    expect(evaluateFollowUp([v('2026-10-30')], policy, '2026-10-26').reason).toBe('no_prior_visit');
  });

  it('treats an emergency or ANC visit as a consultation that opens a window', () => {
    expect(evaluateFollowUp([v('2026-10-25', 'anc')], policy, '2026-10-26').eligible).toBe(true);
    expect(evaluateFollowUp([v('2026-10-25', 'emergency')], policy, '2026-10-26').eligible).toBe(
      true,
    );
  });
});

describe('visit type suggestion (docs/10 §4)', () => {
  const eligible = evaluateFollowUp([v('2026-10-25')], policy, '2026-10-26');
  const not = evaluateFollowUp([], policy, '2026-10-26');
  it('follows the documented precedence', () => {
    expect(suggestVisitType({ followUp: eligible })).toBe('follow_up');
    expect(suggestVisitType({ followUp: not })).toBe('new');
    expect(suggestVisitType({ followUp: not, ancActive: true })).toBe('anc');
    expect(suggestVisitType({ followUp: not, vaccineDue: true })).toBe('paeds_vaccination');
    expect(suggestVisitType({ followUp: eligible, ancActive: true })).toBe('follow_up');
    expect(suggestVisitType({ followUp: eligible, emergency: true })).toBe('emergency');
  });
});

describe('queue state machine (docs/10 §5)', () => {
  const allowed = (from: QueueState) => QUEUE_STATES.filter((to) => canTransition(from, to));

  it('moves forward, skipping steps', () => {
    expect(canTransition('waiting', 'vitals_done')).toBe(true);
    expect(canTransition('waiting', 'with_doctor')).toBe(true);
    expect(canTransition('with_doctor', 'seen')).toBe(true);
    expect(canTransition('seen', 'rx_entered')).toBe(true);
    expect(canTransition('rx_entered', 'billed_orders')).toBe(true);
    expect(canTransition('billed_orders', 'done')).toBe(true);
    expect(canTransition('rx_entered', 'done')).toBe(true);
  });

  it('never moves backwards on the flow, except the skip / late-arrival moves', () => {
    for (const from of QUEUE_FLOW) {
      for (const to of QUEUE_FLOW) {
        if (QUEUE_FLOW.indexOf(to) >= QUEUE_FLOW.indexOf(from)) continue;
        const expected = from === 'with_doctor' && (to === 'waiting' || to === 'vitals_done');
        expect(canTransition(from, to), `${from}->${to}`).toBe(expected);
      }
    }
    expect(canTransition('no_show', 'waiting')).toBe(true);
  });

  it('allows no-show and cancel only before the doctor has seen the patient', () => {
    for (const from of ['waiting', 'vitals_done', 'with_doctor'] as const) {
      expect(canTransition(from, 'no_show')).toBe(true);
      expect(canTransition(from, 'cancelled')).toBe(true);
    }
    for (const from of ['seen', 'rx_entered', 'billed_orders'] as const) {
      expect(canTransition(from, 'no_show')).toBe(false);
      expect(canTransition(from, 'cancelled')).toBe(false);
    }
  });

  it('treats done and cancelled as final and a state as not a move to itself', () => {
    expect(allowed('done')).toEqual([]);
    expect(allowed('cancelled')).toEqual([]);
    expect(allowed('no_show')).toEqual(['waiting']);
    for (const s of QUEUE_STATES) expect(canTransition(s, s)).toBe(false);
  });
});

describe('queue order', () => {
  const tok = (
    tokenNo: number,
    priority: 'normal' | 'emergency' | 'labour' | 'elderly' = 'normal',
  ) => ({
    tokenNo,
    priority,
    queueOrder: tokenNo * 1000,
  });

  it('puts emergency and labour first, then the configured classes, then normal by number', () => {
    const q = [tok(1), tok(2, 'elderly'), tok(3, 'labour'), tok(4), tok(5, 'emergency')];
    expect(q.sort((a, b) => compareQueue(a, b)).map((t) => t.tokenNo)).toEqual([5, 3, 2, 1, 4]);
  });

  it('honours a different configured order', () => {
    const order = ['elderly', 'emergency'] as const;
    const q = [tok(1, 'emergency'), tok(2, 'elderly'), tok(3), tok(4, 'labour')];
    expect(q.sort((a, b) => compareQueue(a, b, order)).map((t) => t.tokenNo)).toEqual([2, 1, 3, 4]);
    expect(priorityRank('normal', order)).toBe(2);
    expect(priorityRank('labour', order)).toBe(2);
  });

  it('skips behind the next three of the same class, or to the end', () => {
    expect(orderAfterSkip(1000, [2000, 3000, 4000, 5000, 6000])).toBe(4001);
    expect(orderAfterSkip(1000, [2000, 3000])).toBe(3001);
    expect(orderAfterSkip(1000, [])).toBe(1000);
    expect(orderAfterSkip(1000, [6000, 2000, 4000, 3000])).toBe(4001);
  });
});
