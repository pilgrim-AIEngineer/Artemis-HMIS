/**
 * Day-end close (BIL-06, docs/12 §6, docs/04 §6). A *user close* counts one cashier's payments
 * since their previous close and locks them to it; a *facility close* gathers the user closes of a
 * business day. Nothing is deleted or edited afterwards (rule 4): the guards in migration
 * `0019_day_close_audit.sql` allow only the one-time attachment of a user close to its facility
 * close, and check that every total equals the sum of the payments it covers.
 */
import { DAY_CLOSE_KINDS, MONEY_CEILING_PAISE } from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, idColumn, sqlIn } from './columns';
import { appUser, facilityRef } from './platform';

const money = () =>
  bigint({ mode: 'bigint' })
    .notNull()
    .default(sql`0`);
const CEILING = sql.raw(String(MONEY_CEILING_PAISE));

export const dayClose = pgTable(
  'day_close',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    kind: text().notNull(),
    /** The cashier who closed their counter; NULL for a facility close. */
    userId: uuid().references(() => appUser.id),
    /** IST business day this close belongs to. */
    closeDate: date({ mode: 'string' }).notNull(),
    closedAt: timestamp({ withTimezone: true }).notNull(),
    /** Expected = sum of the covered valid payments by mode; refunds are negative. */
    cashExpectedPaise: money(),
    upiExpectedPaise: money(),
    cardExpectedPaise: money(),
    otherExpectedPaise: money(),
    /** Counted cash (from the denominations); facility close: the sum of its user closes. */
    cashCountedPaise: money(),
    /** counted − expected for cash. */
    differencePaise: money(),
    differenceReason: text(),
    /** The counter's note and coin entries (user close only). */
    denominations: jsonb(),
    paymentCount: integer().notNull().default(0),
    /** User close: the facility close that took it in (set once, with `verifiedBy/At`). */
    facilityCloseId: uuid().references((): AnyPgColumn => dayClose.id),
    verifiedBy: uuid().references(() => appUser.id),
    verifiedAt: timestamp({ withTimezone: true }),
    /** Facility close: closed although some counter was still open, and why. */
    pendingAcknowledged: boolean().notNull().default(false),
    note: text(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('day_close_facility_date_key')
      .on(t.facilityId, t.closeDate)
      .where(sql`${t.kind} = 'facility'`),
    index('day_close_user_idx').on(t.userId, t.closedAt),
    index('day_close_date_idx').on(t.facilityId, t.closeDate),
    index('day_close_facility_close_idx').on(t.facilityCloseId),
    check('day_close_kind', sqlIn(t.kind, DAY_CLOSE_KINDS)),
    check('day_close_user_fields', sql`(${t.kind} = 'user') = (${t.userId} is not null)`),
    check(
      'day_close_denominations_user_only',
      sql`(${t.kind} = 'user') or ${t.denominations} is null`,
    ),
    check(
      'day_close_money_range',
      sql`abs(${t.cashExpectedPaise}) <= ${CEILING} and abs(${t.upiExpectedPaise}) <= ${CEILING}
        and abs(${t.cardExpectedPaise}) <= ${CEILING} and abs(${t.otherExpectedPaise}) <= ${CEILING}
        and ${t.cashCountedPaise} between 0 and ${CEILING} and abs(${t.differencePaise}) <= ${CEILING}`,
    ),
    check(
      'day_close_difference_math',
      sql`${t.differencePaise} = ${t.cashCountedPaise} - ${t.cashExpectedPaise}`,
    ),
    // A variance is never silent (docs/12 §6).
    check(
      'day_close_difference_reason',
      sql`${t.differencePaise} = 0 or ${t.differenceReason} is not null`,
    ),
    check('day_close_facility_note', sql`not ${t.pendingAcknowledged} or ${t.note} is not null`),
    check(
      'day_close_attach_fields',
      sql`(${t.facilityCloseId} is null) = (${t.verifiedAt} is null) and (${t.facilityCloseId} is null) = (${t.verifiedBy} is null)`,
    ),
  ],
);
