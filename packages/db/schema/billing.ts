/**
 * OPD bills, bill lines and payments (docs/04 §6, BIL-01, BIL-02). Money is bigint paise with the
 * D-6 per-row ceiling. The bill arithmetic (docs/04 §15.1) is a CHECK on the header; header ↔
 * lines ↔ payments agreement and the immutability of a final bill (§15.2) are enforced by the
 * triggers in migration `0015_billing_audit.sql`. Nothing here is ever deleted (rule 4): lines of
 * a draft are cancelled, bills are cancelled, payments are reversed.
 *
 * Phase-later columns (discount reason/approver, package, pharmacy, clinical order, day close,
 * credit note, payment reversal) arrive additively with the PRs that use them.
 */
import {
  BILL_KINDS,
  BILL_LINE_SOURCES,
  BILL_STATUSES,
  MONEY_CEILING_PAISE,
  PAYMENT_KINDS,
  PAYMENT_MODES,
  PAYMENT_STATUSES,
  RECORD_STATUSES,
} from '@hmis/shared';
import { sql, type AnyColumn } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, idColumn, sqlIn } from './columns';
import { doctorProfile, payer, service, serviceRate, tariff } from './masters';
import { patient } from './patient';
import { appUser, facilityRef, workstation } from './platform';
import { encounter } from './visit';

const money = () =>
  bigint({ mode: 'bigint' })
    .notNull()
    .default(sql`0`);

const CEILING = sql.raw(String(MONEY_CEILING_PAISE));
/** `0 <= col <= ceiling` */
const inRange = (c: AnyColumn) => sql`${c} >= 0 and ${c} <= ${CEILING}`;
/** `-ceiling <= col <= ceiling` */
const inSignedRange = (c: AnyColumn) => sql`${c} >= -${CEILING} and ${c} <= ${CEILING}`;

export const bill = pgTable(
  'bill',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    /** `OB/26-27/004512`, allocated on finalise (drafts have no number, docs/12 §5). */
    number: text(),
    kind: text().notNull(),
    encounterId: uuid()
      .notNull()
      .references(() => encounter.id),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    payerId: uuid()
      .notNull()
      .references(() => payer.id),
    tariffId: uuid()
      .notNull()
      .references(() => tariff.id),
    status: text().notNull().default('draft'),
    /** IST business day: the visit day for a draft, the finalisation day once final. */
    billDate: date({ mode: 'string' }).notNull(),
    grossPaise: money(),
    discountPaise: money(),
    taxablePaise: money(),
    cgstPaise: money(),
    sgstPaise: money(),
    roundOffPaise: money(),
    netPaise: money(),
    payerSharePaise: money(),
    patientSharePaise: money(),
    paidPaise: money(),
    balancePaise: money(),
    finalizedBy: uuid().references(() => appUser.id),
    finalizedAt: timestamp({ withTimezone: true }),
    cancelNote: text(),
    cancelledBy: uuid().references(() => appUser.id),
    cancelledAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('bill_number_key')
      .on(t.facilityId, t.number)
      .where(sql`${t.number} is not null`),
    /** One open draft OPD bill per visit; a separate USG bill (`billing.splitUsgBill`) is a second one later. */
    uniqueIndex('bill_opd_draft_key')
      .on(t.encounterId)
      .where(sql`${t.kind} = 'opd' and ${t.status} = 'draft'`),
    index('bill_patient_date_idx').on(t.patientId, t.billDate),
    index('bill_status_date_idx').on(t.facilityId, t.status, t.billDate),
    index('bill_encounter_idx').on(t.encounterId),
    check('bill_kind', sqlIn(t.kind, BILL_KINDS)),
    check('bill_status', sqlIn(t.status, BILL_STATUSES)),
    check(
      'bill_money_range',
      sql`${inRange(t.grossPaise)} and ${inRange(t.discountPaise)} and ${inRange(t.taxablePaise)}
        and ${inRange(t.cgstPaise)} and ${inRange(t.sgstPaise)} and ${inRange(t.netPaise)}
        and ${inRange(t.payerSharePaise)} and ${inRange(t.patientSharePaise)}
        and ${inRange(t.paidPaise)} and ${inSignedRange(t.balancePaise)}`,
    ),
    // docs/04 §15.1
    check(
      'bill_net_math',
      sql`${t.netPaise} = ${t.grossPaise} - ${t.discountPaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.roundOffPaise}`,
    ),
    check('bill_share_math', sql`${t.payerSharePaise} + ${t.patientSharePaise} = ${t.netPaise}`),
    check('bill_taxable_math', sql`${t.taxablePaise} = ${t.grossPaise} - ${t.discountPaise}`),
    check('bill_discount_le_gross', sql`${t.discountPaise} <= ${t.grossPaise}`),
    check('bill_round_off_range', sql`${t.roundOffPaise} between -50 and 50`),
    check('bill_balance_math', sql`${t.balancePaise} = ${t.patientSharePaise} - ${t.paidPaise}`),
    // No overpayment (docs/12 §9); refunds of a reduced bill go through a credit note (BIL-04).
    check('bill_no_overpayment', sql`${t.paidPaise} <= ${t.patientSharePaise}`),
    check('bill_final_has_number', sql`${t.status} <> 'final' or ${t.number} is not null`),
    check('bill_finalized_fields', sql`(${t.number} is null) = (${t.finalizedAt} is null)`),
    check(
      'bill_cancel_fields',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelNote} is not null)`,
    ),
  ],
);

export const billLine = pgTable(
  'bill_line',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    billId: uuid()
      .notNull()
      .references(() => bill.id),
    seq: integer().notNull(),
    source: text().notNull().default('service'),
    serviceId: uuid().references(() => service.id),
    /** The `service_rate` row the price was taken from (snapshot provenance, docs/12 §1). */
    serviceRateId: uuid().references(() => serviceRate.id),
    description: text().notNull(),
    descriptionHi: text(),
    qty: numeric({ precision: 12, scale: 3 }).notNull().default('1'),
    unitRatePaise: money(),
    amountPaise: money(),
    discountPaise: money(),
    sacHsn: text(),
    gstRateBp: integer().notNull().default(0),
    isExempt: boolean().notNull().default(true),
    taxablePaise: money(),
    cgstPaise: money(),
    sgstPaise: money(),
    payerSharePaise: money(),
    patientSharePaise: money(),
    serviceDate: date({ mode: 'string' }).notNull(),
    performedByDoctorId: uuid().references(() => doctorProfile.id),
    /** `cancelled` = removed from the draft (with a reason); never deleted. */
    status: text().notNull().default('active'),
    cancelReason: text(),
    cancelledBy: uuid().references(() => appUser.id),
    cancelledAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('bill_line_seq_key').on(t.billId, t.seq),
    check('bill_line_source', sqlIn(t.source, BILL_LINE_SOURCES)),
    check('bill_line_status', sqlIn(t.status, RECORD_STATUSES)),
    check('bill_line_qty_positive', sql`${t.qty} > 0`),
    check('bill_line_gst_bp', sql`${t.gstRateBp} between 0 and 10000`),
    check('bill_line_exempt_no_gst', sql`not ${t.isExempt} or ${t.gstRateBp} = 0`),
    check(
      'bill_line_money_range',
      sql`${inRange(t.unitRatePaise)} and ${inRange(t.amountPaise)} and ${inRange(t.discountPaise)}
        and ${inRange(t.taxablePaise)} and ${inRange(t.cgstPaise)} and ${inRange(t.sgstPaise)}
        and ${inRange(t.payerSharePaise)} and ${inRange(t.patientSharePaise)}`,
    ),
    // Line math in exact numeric: round() on numeric rounds half away from zero, like divRound.
    check('bill_line_amount_math', sql`${t.amountPaise} = round(${t.qty} * ${t.unitRatePaise})`),
    check('bill_line_discount_le_amount', sql`${t.discountPaise} <= ${t.amountPaise}`),
    check('bill_line_taxable_math', sql`${t.taxablePaise} = ${t.amountPaise} - ${t.discountPaise}`),
    check(
      'bill_line_gst_math',
      sql`${t.cgstPaise} = ${t.sgstPaise} and ${t.cgstPaise} = round(${t.taxablePaise}::numeric * ${t.gstRateBp} / 20000)`,
    ),
    check(
      'bill_line_share_math',
      sql`${t.payerSharePaise} + ${t.patientSharePaise} = ${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise}`,
    ),
    check(
      'bill_line_cancel_fields',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelReason} is not null)`,
    ),
  ],
);

export const payment = pgTable(
  'payment',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    /** Receipt number `RC/26-27/010233`; the rows of one split payment share it. */
    number: text().notNull(),
    /** Groups the rows of one collection (one receipt); the receipt print's entity id. */
    collectionId: uuid().notNull(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    encounterId: uuid().references(() => encounter.id),
    /** NULL for deposits/advances (P2A). */
    billId: uuid().references(() => bill.id),
    kind: text().notNull().default('payment'),
    mode: text().notNull(),
    /** Refunds negative (docs/04 §6). */
    amountPaise: bigint({ mode: 'bigint' }).notNull(),
    /** UTR (or its last digits), optional per `billing.upiRefRequired`. */
    upiRef: text(),
    upiPayerName: text(),
    /** Gateway/soundbox reference for a later dynamic-QR upgrade (docs/12 §3). */
    providerRef: text(),
    cardLast4: text(),
    cardAuthCode: text(),
    chequeNo: text(),
    receivedBy: uuid().references(() => appUser.id),
    receivedAt: timestamp({ withTimezone: true }).notNull(),
    workstationId: uuid().references(() => workstation.id),
    status: text().notNull().default('valid'),
    /** The client-generated key of the submit that created the row (rule 9). */
    idempotencyKey: uuid().notNull(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('payment_number_mode_key').on(t.facilityId, t.number, t.mode),
    index('payment_received_idx').on(t.receivedBy, t.receivedAt),
    index('payment_bill_idx').on(t.billId),
    index('payment_collection_idx').on(t.collectionId),
    index('payment_facility_day_idx').on(t.facilityId, t.receivedAt),
    check('payment_kind', sqlIn(t.kind, PAYMENT_KINDS)),
    check('payment_mode', sqlIn(t.mode, PAYMENT_MODES)),
    check('payment_status', sqlIn(t.status, PAYMENT_STATUSES)),
    check('payment_amount_range', inSignedRange(t.amountPaise)),
    check(
      'payment_amount_sign',
      sql`(${t.kind} = 'refund' and ${t.amountPaise} < 0) or (${t.kind} <> 'refund' and ${t.amountPaise} > 0)`,
    ),
    check(
      'payment_bill_kind',
      sql`${t.kind} not in ('payment', 'refund') or ${t.billId} is not null`,
    ),
    check('payment_upi_ref_format', sql`${t.upiRef} is null or ${t.upiRef} ~ '^[0-9]{4,12}$'`),
    check(
      'payment_upi_fields',
      sql`${t.mode} = 'upi' or (${t.upiRef} is null and ${t.upiPayerName} is null)`,
    ),
    check(
      'payment_card_last4_format',
      sql`${t.cardLast4} is null or ${t.cardLast4} ~ '^[0-9]{4}$'`,
    ),
    check(
      'payment_card_fields',
      sql`${t.mode} = 'card' or (${t.cardLast4} is null and ${t.cardAuthCode} is null)`,
    ),
  ],
);
