/**
 * OPD visit creation (REG-03, docs/10 §4): visit type suggestion, follow-up validity, consultation
 * fee from the payer's tariff, the `encounter` row with its fee snapshot, and the token when the
 * fee allows it (docs/10 §4 step 3). All inside the caller's transaction (`withTx`), so the visit
 * number, the encounter and the token commit together. Draft bill creation joins in BIL-01.
 */
import {
  evaluateFollowUp,
  istDateString,
  QUEUE_ORDER_STEP,
  suggestVisitType,
  addDays,
  parseIsoDate,
  toIsoDate,
  type CreateVisitInput,
  type FeeBasis,
  type FollowUpEvaluation,
  type FollowUpPolicy,
  type QueuePriority,
  type TokenIssueBasis,
  type VisitType,
  createVisitSchema,
} from '@hmis/shared';
import { and, desc, eq, gte, isNull, lte, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  consultationRule,
  department,
  doctorProfile,
  encounter,
  opdToken,
  patient,
  payer,
  queueEvent,
  service,
} from '../schema';
import { runIdempotent } from './idempotency';
import { getRate, pickTariff } from './masters';
import { allocateDailyToken, allocateNumber } from './number-series';
import { readSettings } from './settings';
import type { Tx } from './tx';

export type VisitErrorKey =
  | 'visit.patientNotFound'
  | 'visit.patientDeceased'
  | 'visit.doctorNotFound'
  | 'visit.noPayer'
  | 'visit.noTariff'
  | 'visit.followUpNotEligible'
  | 'visit.alreadyToday'
  | 'visit.notFound'
  | 'visit.notCancellable'
  | 'visit.tokenAlreadyIssued'
  | 'visit.notOpen'
  | 'queue.tokenNotFound'
  | 'queue.invalidTransition'
  | 'queue.nothingWaiting'
  | 'queue.sameDoctor'
  | 'queue.notToday'
  | 'queue.notPending';

/** Input / state errors the router turns into i18n keys (docs/02 §7). */
export class VisitInputError extends Error {
  constructor(readonly key: VisitErrorKey) {
    super(key);
    this.name = 'VisitInputError';
  }
}

export interface Actor {
  facilityId: string;
  userId: string | null;
}

// ---------------------------------------------------------------- policy and fee

/** Validity days / free follow-ups for a doctor: master rule, then per-doctor setting, then global. */
export async function followUpPolicy(
  tx: Tx,
  facilityId: string,
  doctorId: string,
): Promise<FollowUpPolicy> {
  const [rule] = await tx
    .select({
      validityDays: consultationRule.followUpValidityDays,
      freeFollowUps: consultationRule.freeFollowUpsCount,
    })
    .from(consultationRule)
    .where(
      and(
        eq(consultationRule.facilityId, facilityId),
        eq(consultationRule.doctorId, doctorId),
        eq(consultationRule.visitType, 'follow_up'),
        eq(consultationRule.status, 'active'),
      ),
    );
  const cfg = await readSettings(tx, facilityId, [
    'opd.followUpValidityDays',
    'opd.freeFollowUps',
    'opd.followUpRulesByDoctor',
  ]);
  const own = cfg['opd.followUpRulesByDoctor'][doctorId];
  return {
    validityDays: rule?.validityDays ?? own?.validityDays ?? cfg['opd.followUpValidityDays'],
    freeFollowUps: rule?.freeFollowUps ?? own?.freeFollowUps ?? cfg['opd.freeFollowUps'],
  };
}

export interface ConsultationFee {
  serviceId: string | null;
  serviceName: string | null;
  ratePaise: bigint;
  basis: FeeBasis;
}

/**
 * Fee for a visit type: the doctor's `consultation_rule` service, priced in the tariff on the
 * visit day. A follow-up without a rule is free (docs/10 §4 "₹0 or follow-up rate"). Any other
 * type without a rule or without a rate gets ₹0 and a basis (`no_rule` / `no_rate`) that keeps
 * the token from being issued automatically, so a missing fee is noticed rather than given away.
 */
export async function consultationFee(
  tx: Tx,
  q: { facilityId: string; doctorId: string; visitType: VisitType; tariffId: string; on: string },
): Promise<ConsultationFee> {
  const [rule] = await tx
    .select({ serviceId: consultationRule.serviceId, serviceName: service.name })
    .from(consultationRule)
    .innerJoin(service, eq(service.id, consultationRule.serviceId))
    .where(
      and(
        eq(consultationRule.facilityId, q.facilityId),
        eq(consultationRule.doctorId, q.doctorId),
        eq(consultationRule.visitType, q.visitType),
        eq(consultationRule.status, 'active'),
        eq(service.status, 'active'),
      ),
    );
  if (!rule) {
    return {
      serviceId: null,
      serviceName: null,
      ratePaise: 0n,
      basis: q.visitType === 'follow_up' ? 'free_follow_up' : 'no_rule',
    };
  }
  const rate = await getRate(tx, {
    facilityId: q.facilityId,
    serviceId: rule.serviceId,
    tariffId: q.tariffId,
    on: q.on,
  });
  if (!rate) {
    return {
      ...rule,
      ratePaise: 0n,
      basis: q.visitType === 'follow_up' ? 'free_follow_up' : 'no_rate',
    };
  }
  return { ...rule, ratePaise: rate.ratePaise, basis: 'tariff' };
}

// ---------------------------------------------------------------- preview

export interface VisitPreview {
  doctor: { id: string; displayName: string; displayNameHi: string | null; departmentId: string };
  payerId: string;
  tariffId: string;
  policy: FollowUpPolicy;
  followUp: FollowUpEvaluation;
  suggestedVisitType: VisitType;
  visitType: VisitType;
  fee: ConsultationFee;
  /** Open visits of this patient with this doctor today (second visit needs confirmation). */
  existingToday: { encounterId: string; number: string }[];
}

async function loadPatient(tx: Tx, facilityId: string, patientId: string) {
  const [p] = await tx
    .select({ id: patient.id, isDeceased: patient.isDeceased })
    .from(patient)
    .where(
      and(
        eq(patient.id, patientId),
        eq(patient.facilityId, facilityId),
        eq(patient.status, 'active'),
        isNull(patient.mergedIntoId),
      ),
    );
  if (!p) throw new VisitInputError('visit.patientNotFound');
  if (p.isDeceased) throw new VisitInputError('visit.patientDeceased');
  return p;
}

async function loadDoctor(tx: Tx, facilityId: string, doctorId: string) {
  const [d] = await tx
    .select({
      id: doctorProfile.id,
      displayName: doctorProfile.displayName,
      displayNameHi: doctorProfile.displayNameHi,
      departmentId: doctorProfile.departmentId,
    })
    .from(doctorProfile)
    .innerJoin(department, eq(department.id, doctorProfile.departmentId))
    .where(
      and(
        eq(doctorProfile.id, doctorId),
        eq(doctorProfile.facilityId, facilityId),
        eq(doctorProfile.status, 'active'),
        eq(doctorProfile.isActive, true),
      ),
    );
  if (!d) throw new VisitInputError('visit.doctorNotFound');
  return d;
}

/** The default payer is the active Cash/Self payer (docs/10 §4); PM-JAY / TPA join in Phase 2B. */
async function defaultPayerId(tx: Tx, facilityId: string): Promise<string> {
  const [p] = await tx
    .select({ id: payer.id })
    .from(payer)
    .where(
      and(
        eq(payer.facilityId, facilityId),
        eq(payer.type, 'self'),
        eq(payer.status, 'active'),
        eq(payer.isActive, true),
      ),
    )
    .orderBy(payer.createdAt, payer.id)
    .limit(1);
  if (!p) throw new VisitInputError('visit.noPayer');
  return p.id;
}

/**
 * Everything reception needs before saving: the follow-up evaluation, the suggested and the
 * effective visit type, the fee and any visit already made today. Read-only.
 */
export async function previewVisit(
  tx: Tx,
  facilityId: string,
  q: { patientId: string; doctorId: string; visitType?: VisitType },
  now: Date,
): Promise<VisitPreview> {
  await loadPatient(tx, facilityId, q.patientId);
  const doctor = await loadDoctor(tx, facilityId, q.doctorId);
  const today = istDateString(now);
  const policy = await followUpPolicy(tx, facilityId, q.doctorId);

  const since = toIsoDate(addDays(parseIsoDate(today), -366));
  const priors = await tx
    .select({
      id: encounter.id,
      number: encounter.number,
      date: encounter.visitDate,
      visitType: encounter.visitType,
    })
    .from(encounter)
    .where(
      and(
        eq(encounter.facilityId, facilityId),
        eq(encounter.patientId, q.patientId),
        eq(encounter.doctorId, q.doctorId),
        eq(encounter.type, 'opd'),
        ne(encounter.status, 'cancelled'),
        gte(encounter.visitDate, since),
        lte(encounter.visitDate, today),
      ),
    )
    .orderBy(desc(encounter.visitDate));
  const followUp = evaluateFollowUp(
    priors.map((p) => ({ date: p.date, visitType: p.visitType as VisitType })),
    policy,
    today,
  );
  const suggestedVisitType = suggestVisitType({ followUp });
  const visitType = q.visitType ?? suggestedVisitType;

  const payerId = await defaultPayerId(tx, facilityId);
  const tariffId = await pickTariff(tx, { facilityId, payerId, on: today });
  if (!tariffId) throw new VisitInputError('visit.noTariff');
  const fee = await consultationFee(tx, {
    facilityId,
    doctorId: q.doctorId,
    visitType,
    tariffId,
    on: today,
  });

  return {
    doctor,
    payerId,
    tariffId,
    policy,
    followUp,
    suggestedVisitType,
    visitType,
    fee,
    existingToday: priors
      .filter((p) => p.date === today)
      .map((p) => ({ encounterId: p.id, number: p.number })),
  };
}

// ---------------------------------------------------------------- tokens

export interface IssuedToken {
  tokenId: string;
  tokenNo: number;
  tokenDate: string;
}

/**
 * Issues the encounter's token: number from the per-doctor, per-IST-day advisory-locked counter.
 * `basis` records why issuing was allowed (free fee, the "before payment" setting, a payment —
 * BIL-01 passes `payment` — or a manual issue). One token per encounter.
 */
export async function issueToken(
  tx: Tx,
  actor: Actor,
  encounterId: string,
  basis: TokenIssueBasis,
  now: Date,
): Promise<IssuedToken> {
  const [enc] = await tx
    .select({
      id: encounter.id,
      doctorId: encounter.doctorId,
      status: encounter.status,
      priority: encounter.priority,
    })
    .from(encounter)
    .where(and(eq(encounter.id, encounterId), eq(encounter.facilityId, actor.facilityId)))
    .for('update');
  if (!enc) throw new VisitInputError('visit.notFound');
  if (enc.status !== 'open') throw new VisitInputError('visit.notOpen');
  const [existing] = await tx
    .select({ id: opdToken.id })
    .from(opdToken)
    .where(eq(opdToken.encounterId, encounterId));
  if (existing) throw new VisitInputError('visit.tokenAlreadyIssued');

  const { tokenDate, tokenNo } = await allocateDailyToken(tx, {
    facilityId: actor.facilityId,
    doctorId: enc.doctorId,
    at: now,
    currentMax: async (t, date) => {
      const [row] = await t
        .select({ max: sql<number | null>`max(${opdToken.tokenNo})` })
        .from(opdToken)
        .where(and(eq(opdToken.doctorId, enc.doctorId), eq(opdToken.tokenDate, date)));
      return row?.max ?? null;
    },
  });
  const tokenId = uuidv7();
  await tx.insert(opdToken).values({
    id: tokenId,
    facilityId: actor.facilityId,
    encounterId,
    doctorId: enc.doctorId,
    tokenDate,
    tokenNo,
    priority: enc.priority,
    queueState: 'waiting',
    queueOrder: tokenNo * QUEUE_ORDER_STEP,
    issuedBasis: basis,
    issuedAt: now,
  });
  await tx.insert(queueEvent).values({
    id: uuidv7(),
    facilityId: actor.facilityId,
    tokenId,
    fromState: null,
    toState: 'waiting',
    byUser: actor.userId,
    at: now,
    action: 'issue',
  });
  return { tokenId, tokenNo, tokenDate };
}

// ---------------------------------------------------------------- create

export interface CreatedVisit {
  encounterId: string;
  number: string;
  visitType: VisitType;
  /** Integer paise as a string (the result is stored as JSON for idempotent replays). */
  feePaise: string;
  feeBasis: FeeBasis;
  priority: QueuePriority;
  tokenId: string | null;
  tokenNo: number | null;
  tokenDate: string | null;
  tokenIssueBasis: TokenIssueBasis | null;
}

/**
 * Creates the visit (REG-03). Duplicate submits with the same `idempotencyKey` return the first
 * result. A follow-up is refused when the patient is not entitled to one (a concession later
 * goes through a discount with approval, BIL-03). The token is issued at once when the fee is
 * ₹0 (and known) or setting `queue.issueTokenBeforePayment` is on; otherwise it waits for the
 * payment (BIL-01) or a manual issue by someone allowed to collect money.
 */
export async function createVisit(
  tx: Tx,
  actor: Actor,
  rawInput: CreateVisitInput,
  now: Date,
): Promise<CreatedVisit> {
  const { idempotencyKey, ...input } = createVisitSchema.parse(rawInput);
  return runIdempotent(
    tx,
    {
      facilityId: actor.facilityId,
      userId: actor.userId,
      procedure: 'visit.create',
      key: idempotencyKey,
      payload: input,
    },
    async () => {
      const preview = await previewVisit(tx, actor.facilityId, input, now);
      if (input.visitType === 'follow_up' && !preview.followUp.eligible) {
        throw new VisitInputError('visit.followUpNotEligible');
      }
      if (preview.existingToday.length > 0 && !input.allowRepeatToday) {
        throw new VisitInputError('visit.alreadyToday');
      }
      const { fee, visitType } = preview;
      const num = await allocateNumber(tx, actor.facilityId, 'opd_visit', now);
      const encounterId = uuidv7();
      await tx.insert(encounter).values({
        id: encounterId,
        facilityId: actor.facilityId,
        patientId: input.patientId,
        type: 'opd',
        number: num.formatted,
        doctorId: input.doctorId,
        departmentId: preview.doctor.departmentId,
        payerId: preview.payerId,
        tariffId: preview.tariffId,
        visitType,
        chiefComplaintShort: input.chiefComplaint || null,
        priority: input.priority,
        startedAt: now,
        visitDate: istDateString(now),
        consultationServiceId: fee.serviceId,
        consultationFeePaise: fee.ratePaise,
        feeBasis: fee.basis,
      });

      const cfg = await readSettings(tx, actor.facilityId, ['queue.issueTokenBeforePayment']);
      const feeKnown = fee.basis === 'tariff' || fee.basis === 'free_follow_up';
      const basis: TokenIssueBasis | null =
        feeKnown && fee.ratePaise === 0n
          ? 'free'
          : cfg['queue.issueTokenBeforePayment']
            ? 'before_payment_setting'
            : null;
      const token = basis ? await issueToken(tx, actor, encounterId, basis, now) : null;
      return {
        encounterId,
        number: num.formatted,
        visitType,
        feePaise: fee.ratePaise.toString(),
        feeBasis: fee.basis,
        priority: input.priority,
        tokenId: token?.tokenId ?? null,
        tokenNo: token?.tokenNo ?? null,
        tokenDate: token?.tokenDate ?? null,
        tokenIssueBasis: basis,
      };
    },
  );
}
