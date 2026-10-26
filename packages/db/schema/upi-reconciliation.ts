/**
 * Daily UPI reconciliation (BIL-06, docs/12 §3): the system's UPI total for a business day against
 * the total read from the bank / UPI app statement, the receipts ticked off one by one (matched by
 * UTR where the statement lines were pasted), and the difference with its reason. Receipts are
 * never deleted from a reconciliation: unticking sets `matched` to false.
 */
import { MONEY_CEILING_PAISE, UPI_RECON_STATUSES } from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { payment } from './billing';
import { auditColumns, idColumn, sqlIn } from './columns';
import { appUser, facilityRef } from './platform';

const money = () =>
  bigint({ mode: 'bigint' })
    .notNull()
    .default(sql`0`);
const CEILING = sql.raw(String(MONEY_CEILING_PAISE));

export const upiReconciliation = pgTable(
  'upi_reconciliation',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    /** IST business day (`payment.business_date`). */
    reconDate: date({ mode: 'string' }).notNull(),
    status: text().notNull().default('open'),
    /** What the system held for the day when this was last saved (net of UPI refunds). */
    systemTotalPaise: money(),
    statementTotalPaise: money(),
    /** statement − system. */
    differencePaise: money(),
    differenceReason: text(),
    reconciledBy: uuid().references(() => appUser.id),
    reconciledAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('upi_reconciliation_date_key').on(t.facilityId, t.reconDate),
    check('upi_reconciliation_status', sqlIn(t.status, UPI_RECON_STATUSES)),
    check(
      'upi_reconciliation_money_range',
      sql`abs(${t.systemTotalPaise}) <= ${CEILING} and abs(${t.statementTotalPaise}) <= ${CEILING}
        and abs(${t.differencePaise}) <= ${CEILING}`,
    ),
    check(
      'upi_reconciliation_difference_math',
      sql`${t.differencePaise} = ${t.statementTotalPaise} - ${t.systemTotalPaise}`,
    ),
    check(
      'upi_reconciliation_done_fields',
      sql`(${t.status} = 'reconciled') = (${t.reconciledAt} is not null and ${t.reconciledBy} is not null)`,
    ),
    check(
      'upi_reconciliation_difference_reason',
      sql`${t.status} <> 'reconciled' or ${t.differencePaise} = 0 or ${t.differenceReason} is not null`,
    ),
  ],
);

export const upiReconciliationItem = pgTable(
  'upi_reconciliation_item',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    reconciliationId: uuid()
      .notNull()
      .references(() => upiReconciliation.id),
    paymentId: uuid()
      .notNull()
      .references(() => payment.id),
    matched: boolean().notNull().default(true),
    /** The full UTR as seen on the statement (the receipt only keeps the last digits). */
    statementUtr: text(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('upi_reconciliation_item_key').on(t.reconciliationId, t.paymentId),
    index('upi_reconciliation_item_payment_idx').on(t.paymentId),
    check(
      'upi_reconciliation_item_utr',
      sql`${t.statementUtr} is null or ${t.statementUtr} ~ '^[0-9]{6,22}$'`,
    ),
  ],
);
