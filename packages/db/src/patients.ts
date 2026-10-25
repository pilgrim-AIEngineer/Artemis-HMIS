/**
 * Patient registration and search (REG-01, REG-02, docs/10). Everything runs inside the caller's
 * transaction (`withTx`), so the UHID allocation, the locality "learned" insert and the patient
 * row commit together and audit rows carry the actor.
 *
 * Search keys come from `nameSearchKeys` (@hmis/shared); the SQL below only compares them with
 * pg_trgm, so what the client normalises and what the DB stores can never drift apart.
 */
import {
  classifySearchQuery,
  formatUhid,
  joinName,
  nameSearchKeys,
  NUMBER_SERIES_CONFIG_SETTING,
  numberSeriesConfigSchema,
  resolveDob,
  resolveSeriesDefinition,
  SEARCH_LIMIT,
  istToday,
  normaliseName,
  type CreatePatient,
  type UpdatePatient,
} from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { facility, locality, patient, setting } from '../schema';
import { allocateNumber } from './number-series';
import { readSettings } from './settings';
import type { Tx } from './tx';

export class PatientInputError extends Error {
  constructor(readonly key: 'patient.ageInvalid' | 'patient.notFound' | 'patient.notEditable') {
    super(key);
    this.name = 'PatientInputError';
  }
}

export interface PatientMatch {
  id: string;
  uhid: string;
  fullName: string;
  nameHi: string | null;
  sex: string;
  dob: string;
  dobIsEstimated: boolean;
  mobile: string | null;
  guardianName: string | null;
  guardianRelation: string | null;
  localityName: string | null;
  isDeceased: boolean;
  /** Higher is a better match; mobile / UHID hits score 1. */
  score: number;
}

interface MatchRow extends Record<string, unknown> {
  id: string;
  uhid: string;
  full_name: string;
  name_hi: string | null;
  sex: string;
  dob: string;
  dob_is_estimated: boolean;
  mobile: string | null;
  guardian_name: string | null;
  guardian_relation: string | null;
  locality_name: string | null;
  is_deceased: boolean;
  score: number | string;
}

const MATCH_COLUMNS = sql`p.id, p.uhid, p.full_name, p.name_hi, p.sex, p.dob::text as dob,
  p.dob_is_estimated, p.mobile, p.guardian_name, p.guardian_relation, l.name as locality_name,
  p.is_deceased`;

const toMatch = (r: MatchRow): PatientMatch => ({
  id: r.id,
  uhid: r.uhid,
  fullName: r.full_name,
  nameHi: r.name_hi,
  sex: r.sex,
  dob: r.dob,
  dobIsEstimated: r.dob_is_estimated,
  mobile: r.mobile,
  guardianName: r.guardian_name,
  guardianRelation: r.guardian_relation,
  localityName: r.locality_name,
  isDeceased: r.is_deceased,
  score: Number(r.score),
});

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Live, not-merged patients of the facility: the only rows search and duplicate check see. */
const liveFilter = (facilityId: string) =>
  sql`p.facility_id = ${facilityId} and p.status = 'active' and p.merged_into_id is null`;

async function uhidFormat(tx: Tx, facilityId: string) {
  const [row] = await tx
    .select({ value: setting.value })
    .from(setting)
    .where(and(eq(setting.facilityId, facilityId), eq(setting.key, NUMBER_SERIES_CONFIG_SETTING)));
  return resolveSeriesDefinition('uhid', numberSeriesConfigSchema.parse(row?.value));
}

// ---------------------------------------------------------------- search (REG-02)

export interface PatientSearchResult {
  kind: 'empty' | 'mobile' | 'uhid' | 'name';
  /** A mobile search lists everyone on that number: shown grouped as a family (docs/10 §2). */
  family: boolean;
  rows: PatientMatch[];
}

/** Single search box: mobile, UHID or fuzzy name, best match first, at most `limit` rows. */
export async function searchPatients(
  tx: Tx,
  facilityId: string,
  rawQuery: string,
  limit = SEARCH_LIMIT,
): Promise<PatientSearchResult> {
  const fmt = await uhidFormat(tx, facilityId);
  const q = classifySearchQuery(rawQuery, fmt.prefix);
  const cap = Math.min(Math.max(limit, 1), SEARCH_LIMIT);
  // Deceased patients stay findable (greyed out in the UI) but never lead the list.
  const base = sql`from patient p left join locality l on l.id = p.locality_id where ${liveFilter(facilityId)}`;

  if (q.kind === 'empty') return { kind: 'empty', family: false, rows: [] };

  if (q.kind === 'mobile') {
    const where = q.exact
      ? sql`(p.mobile = ${q.digits} or p.alt_mobile = ${q.digits})`
      : sql`(p.mobile like ${`${likeEscape(q.digits)}%`} or p.alt_mobile like ${`${likeEscape(q.digits)}%`})`;
    const res = await tx.execute<MatchRow>(
      sql`select ${MATCH_COLUMNS}, 1 as score ${base} and ${where}
          order by p.is_deceased, p.dob, p.full_name, p.id limit ${cap}`,
    );
    return { kind: 'mobile', family: true, rows: res.rows.map(toMatch) };
  }

  if (q.kind === 'uhid') {
    if (q.number < 1) return { kind: 'uhid', family: false, rows: [] };
    const uhid = formatUhid(fmt.prefix, q.number, fmt.padding);
    const res = await tx.execute<MatchRow>(
      sql`select ${MATCH_COLUMNS}, 1 as score ${base} and p.uhid = ${uhid} limit ${cap}`,
    );
    return { kind: 'uhid', family: false, rows: res.rows.map(toMatch) };
  }

  // Name: whole query and first word are both tried; words after the first also count when they
  // appear in the guardian's name or the locality (docs/10 §2 "second token as filter").
  const full = nameSearchKeys(q.text);
  if (!full.norm) return { kind: 'name', family: false, rows: [] };
  const firstWord = full.norm.split(' ')[0]!;
  const first = nameSearchKeys(firstWord);
  const extras = q.extra.length ? normaliseName(q.extra.slice(1).join(' ')).split(' ') : [];
  const extraTokens = extras.filter((t) => t.length >= 2);
  const extraHit = extraTokens.length
    ? sql`(${sql.join(
        extraTokens.map(
          (t) =>
            sql`(lower(coalesce(p.guardian_name, '')) like ${`%${likeEscape(t)}%`} or lower(coalesce(l.name, '')) like ${`%${likeEscape(t)}%`})`,
        ),
        sql` or `,
      )})`
    : sql`false`;
  const hasExtras = extraTokens.length > 0;
  const nameHiLike = `%${likeEscape(q.text.toLowerCase())}%`;

  // `<%` / `%` use these thresholds and the GIN trigram indexes.
  await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', '0.5', true)`);
  const fullScore = sql`greatest(word_similarity(${full.phonetic}, p.search_name_phonetic),
      word_similarity(${full.norm}, p.search_name_norm))`;
  const firstScore = sql`greatest(word_similarity(${first.phonetic}, p.search_name_phonetic),
      word_similarity(${first.norm}, p.search_name_norm))`;
  const prefixBonus = sql`case when p.search_name_norm like ${`${likeEscape(full.norm)}%`}
      or p.search_name_norm like ${`% ${likeEscape(full.norm)}%`} then 0.15 else 0 end`;
  // One indexed branch per predicate, UNIONed: an OR across trigram indexes makes the planner fall
  // back to a sequential scan at 2 lakh rows. The phonetic key is a folding of the normalised
  // name, and word similarity already matches prefixes and most inner fragments (`sunit`, `nita`),
  // so there is no extra substring or `search_name_norm` branch: it only re-read the same rows.
  // The Hindi-name branch runs only for Devanagari input and uses the `name_hi` trigram index.
  const preds = [
    sql`${full.phonetic} <% p.search_name_phonetic`,
    ...(hasExtras
      ? [sql`${first.phonetic} <% p.search_name_phonetic`]
      : /\p{Script=Devanagari}/u.test(q.text)
        ? [sql`p.name_hi ilike ${nameHiLike}`] // matches the trigram index on name_hi
        : []),
  ];
  const candidates = sql.join(
    preds.map(
      (pred) => sql`select p.id from patient p where p.facility_id = ${facilityId} and ${pred}`,
    ),
    sql` union `,
  );

  // Score narrow rows (id, name, score) and keep the best `cap`; only those get the wide columns
  // and the locality join. Sorting thousands of full rows was the slow part for common names.
  const res = await tx.execute<MatchRow>(
    sql`with cand as (${candidates}),
        top as (
          select p.id, p.full_name as sort_name,
            (greatest(${fullScore}, ${hasExtras ? sql`0.85 * ${firstScore}` : sql`0`})
              + ${prefixBonus}
              + case when ${extraHit} then 0.25 else 0 end
              - case when p.is_deceased then 0.05 else 0 end)::float8 as score
          from cand
          -- LATERAL pins a primary-key lookup per candidate; left alone the planner chose a
          -- sequential scan of the whole table for this join.
          cross join lateral (select * from patient where id = cand.id) p
          left join locality l on l.id = p.locality_id
          where ${liveFilter(facilityId)}
          order by score desc, sort_name, p.id limit ${cap}
        )
        select ${MATCH_COLUMNS}, top.score
        from top join patient p on p.id = top.id left join locality l on l.id = p.locality_id
        order by top.score desc, top.sort_name, top.id`,
  );
  return { kind: 'name', family: false, rows: res.rows.map(toMatch) };
}

// ---------------------------------------------------------------- duplicate check (REG-01)

export interface DuplicateQuery {
  firstName: string;
  middleName?: string | null;
  lastName?: string | null;
  mobile: string;
  dob: string;
}

/**
 * docs/10 §3: same mobile (or alternate mobile) AND phonetic name similarity ≥ the configured
 * threshold (default 0.6) AND age within the configured tolerance (default ±2 years).
 * Cancelled and merged-away patients are ignored. Best match first.
 */
export async function findDuplicates(
  tx: Tx,
  facilityId: string,
  q: DuplicateQuery,
  limit = 5,
): Promise<PatientMatch[]> {
  const cfg = await readSettings(tx, facilityId, [
    'registration.duplicateMinSimilarityPct',
    'registration.duplicateAgeToleranceYears',
  ]);
  const phonetic = nameSearchKeys(joinName(q)).phonetic;
  if (!phonetic) return [];
  const min = cfg['registration.duplicateMinSimilarityPct'] / 100;
  const days = Math.round(cfg['registration.duplicateAgeToleranceYears'] * 366);
  const res = await tx.execute<MatchRow>(
    sql`select ${MATCH_COLUMNS}, similarity(p.search_name_phonetic, ${phonetic})::float8 as score
        from patient p left join locality l on l.id = p.locality_id
        where ${liveFilter(facilityId)}
          and (p.mobile = ${q.mobile} or p.alt_mobile = ${q.mobile})
          and similarity(p.search_name_phonetic, ${phonetic}) >= ${min}::real
          and abs(p.dob - ${q.dob}::date) <= ${days}
        order by score desc, p.created_at, p.id limit ${limit}`,
  );
  return res.rows.map(toMatch);
}

// ---------------------------------------------------------------- register / update

export type RegisterOutcome =
  | { status: 'created'; id: string; uhid: string }
  | { status: 'duplicates'; matches: PatientMatch[] };

async function resolveLocality(
  tx: Tx,
  facilityId: string,
  input: { localityId?: string; localityName?: string | null; district?: string | null },
): Promise<string | null> {
  if (input.localityId) {
    const [row] = await tx
      .select({ id: locality.id })
      .from(locality)
      .where(
        and(
          eq(locality.id, input.localityId),
          eq(locality.facilityId, facilityId),
          eq(locality.status, 'active'),
        ),
      );
    if (!row) throw new PatientInputError('patient.notFound');
    return row.id;
  }
  const name = input.localityName?.trim();
  if (!name) return null;
  const [existing] = await tx
    .select({ id: locality.id })
    .from(locality)
    .where(
      and(
        eq(locality.facilityId, facilityId),
        eq(locality.status, 'active'),
        sql`lower(${locality.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const id = uuidv7();
  await tx.insert(locality).values({
    id,
    facilityId,
    name,
    district: input.district ?? null,
    learned: true,
  });
  return id;
}

/** Fields copied from the validated form to the row (create and update). */
function rowFields(
  v: CreatePatient,
  dob: { dob: string; estimated: boolean },
  localityId: string | null,
  defaults: { district: string | null; state: string | null },
) {
  const keys = nameSearchKeys(joinName(v));
  return {
    firstName: v.firstName,
    middleName: v.middleName ?? null,
    lastName: v.lastName ?? null,
    nameHi: v.nameHi ?? null,
    sex: v.sex,
    dob: dob.dob,
    dobIsEstimated: dob.estimated,
    mobile: v.mobile ?? null,
    noMobileReason: v.mobile ? null : (v.noMobileReason ?? null),
    altMobile: v.altMobile ?? null,
    relationToMobileOwner: v.relationToMobileOwner ?? null,
    guardianName: v.guardianName ?? null,
    guardianRelation: v.guardianRelation ?? null,
    addressLine: v.addressLine ?? null,
    localityId,
    district: v.district ?? defaults.district,
    state: v.state ?? defaults.state,
    pincode: v.pincode ?? null,
    bloodGroup: v.bloodGroup ?? null,
    maritalStatus: v.maritalStatus ?? null,
    occupation: v.occupation ?? null,
    referredBy: v.referredBy ?? null,
    searchNameNorm: keys.norm,
    searchNamePhonetic: keys.phonetic,
  };
}

async function facilityDefaults(tx: Tx, facilityId: string) {
  const [f] = await tx
    .select({ district: facility.district, state: facility.state })
    .from(facility)
    .where(eq(facility.id, facilityId));
  return { district: f?.district ?? null, state: f?.state ?? null };
}

/**
 * Registers a patient. Runs the duplicate check first (unless `duplicateOverride` carries a
 * reason, which is stored on the row and audited) and returns the matches instead of creating.
 * `now` is the business instant: it fixes the IST date for the age → DOB estimate.
 */
export async function registerPatient(
  tx: Tx,
  facilityId: string,
  input: CreatePatient,
  now: Date,
): Promise<RegisterOutcome> {
  const dob = resolveDob(input, istToday(now));
  if (!dob) throw new PatientInputError('patient.ageInvalid');

  if (input.mobile && !input.duplicateOverride) {
    const matches = await findDuplicates(tx, facilityId, {
      firstName: input.firstName,
      middleName: input.middleName,
      lastName: input.lastName,
      mobile: input.mobile,
      dob: dob.dob,
    });
    if (matches.length) return { status: 'duplicates', matches };
  }

  const localityId = await resolveLocality(tx, facilityId, input);
  const defaults = await facilityDefaults(tx, facilityId);
  const uhid = await allocateNumber(tx, facilityId, 'uhid', now);
  const id = uuidv7();
  await tx.insert(patient).values({
    id,
    facilityId,
    uhid: uhid.formatted,
    ...rowFields(input, dob, localityId, defaults),
    duplicateOverrideReason: input.duplicateOverride?.reason ?? null,
  });
  return { status: 'created', id, uhid: uhid.formatted };
}

/**
 * Edits a patient. Name, DOB or sex changes set `identity_changed_at` (the "changed" badge);
 * every change is in `audit_log` through the trigger. An update without an age/DOB keeps the
 * stored one.
 */
export async function updatePatient(
  tx: Tx,
  facilityId: string,
  input: UpdatePatient,
  now: Date,
): Promise<{ id: string; identityChanged: boolean }> {
  const [cur] = await tx
    .select()
    .from(patient)
    .where(and(eq(patient.id, input.id), eq(patient.facilityId, facilityId)))
    .for('update');
  if (!cur) throw new PatientInputError('patient.notFound');
  if (cur.status !== 'active' || cur.mergedIntoId)
    throw new PatientInputError('patient.notEditable');

  let dob = { dob: cur.dob, estimated: cur.dobIsEstimated };
  // An unchanged DOB keeps its "estimated" flag (the edit form always sends the stored date).
  if ((input.dob && input.dob !== cur.dob) || input.age) {
    const next = resolveDob(input, istToday(now));
    if (!next) throw new PatientInputError('patient.ageInvalid');
    dob = next;
  }
  const localityId = await resolveLocality(tx, facilityId, input);
  const defaults = await facilityDefaults(tx, facilityId);
  const fields = rowFields(input, dob, localityId, defaults);
  const identityChanged =
    cur.firstName !== fields.firstName ||
    (cur.middleName ?? null) !== fields.middleName ||
    (cur.lastName ?? null) !== fields.lastName ||
    cur.sex !== fields.sex ||
    cur.dob !== fields.dob;
  await tx
    .update(patient)
    .set({ ...fields, ...(identityChanged ? { identityChangedAt: now } : {}) })
    .where(eq(patient.id, input.id));
  return { id: input.id, identityChanged };
}
