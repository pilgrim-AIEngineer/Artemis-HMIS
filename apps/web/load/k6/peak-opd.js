// Peak-OPD load test (docs/32 §1): 15 concurrent users, 40 registrations/h, 150 bills/day,
// patient search p95 < 300 ms, mutations p95 < 1 s.
//
//   k6 run -e BASE_URL=http://127.0.0.1:3000 infra/load/k6/peak-opd.js
//
// Env:
//   SCALE      multiplies the arrival rates (default 1 = the documented peak; the results doc
//              also records SCALE=4 as a stress run)
//   DURATION   test length (default 10m)
//   USERS      concurrent desk users doing reads (default 15)
//   LOAD_USER / LOAD_PASSWORD   demo user (default demo_reception / demo-pass-2026)
//
// Needs `pnpm db:seed --demo` data (patients, doctors with fees). Everything created here is
// synthetic and marked "k6 load test" in the referred-by field.
import { sleep } from 'k6';
import { int, pick, trpc, uuid, login } from './lib.js';

const SCALE = Number(__ENV.SCALE || 1);
const DURATION = __ENV.DURATION || '10m';
const USERS = Number(__ENV.USERS || 15);
// 150 bills/day over the 9-to-2 peak = 30 paid visits/h; registrations 40/h (docs/32 §1).
const REGISTRATIONS_PER_HOUR = 40 * SCALE;
const PAID_VISITS_PER_HOUR = 30 * SCALE;

export const options = {
  scenarios: {
    desk_browsing: {
      executor: 'constant-vus',
      vus: USERS,
      duration: DURATION,
      exec: 'browse',
    },
    registrations: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(REGISTRATIONS_PER_HOUR)),
      timeUnit: '1h',
      duration: DURATION,
      preAllocatedVUs: 3,
      maxVUs: 10,
      exec: 'register',
    },
    visits_and_payments: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(PAID_VISITS_PER_HOUR)),
      timeUnit: '1h',
      duration: DURATION,
      preAllocatedVUs: 3,
      maxVUs: 10,
      exec: 'visitAndPay',
    },
  },
  thresholds: {
    // docs/32 §1 targets.
    'http_req_duration{name:patients.search}': ['p(95)<300'],
    'http_req_duration{kind:mutation}': ['p(95)<1000'],
    'http_req_duration{kind:query}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
};

const SURNAMES = ['Verma', 'Singh', 'Yadav', 'Gupta', 'Mishra', 'Sharma', 'Pandey', 'Tiwari'];
const FIRST = ['Sunita', 'Anita', 'Poonam', 'Rekha', 'Meena', 'Kavita', 'Pooja', 'Neha'];

export function setup() {
  login();
  const dr = trpc('visit.doctors', undefined, { tag: 'visit.doctors' });
  const doctors = dr.data || [];
  const patients = [];
  for (const q of ['sunita', 'rekha', 'anil', 'poonam', 'vijay', 'meena']) {
    const r = trpc('patients.search', { q, limit: 20 }, { tag: 'setup.search' }).data;
    for (const p of (r && r.rows) || [])
      patients.push({ id: p.id, name: p.fullName, mobile: p.mobile, uhid: p.uhid });
  }
  if (doctors.length === 0 || patients.length === 0) {
    throw new Error(
      `No demo doctors/patients (doctors HTTP ${dr.res.status}: ${String(dr.res.body).slice(0, 200)}): run \`pnpm db:seed --demo\` first`,
    );
  }
  return { doctors: doctors.map((d) => d.id), patients };
}

// 15 desk users: search by name, by mobile and by UHID, open the queue board, think 2-6 s.
export function browse(data) {
  const p = pick(data.patients);
  const first = (p.name || 'a').split(' ')[0].slice(0, int(3, 6));
  trpc('patients.search', { q: first, limit: 20 }, { tag: 'patients.search' });
  sleep(int(2, 4));
  if (p.mobile) trpc('patients.search', { q: p.mobile, limit: 20 }, { tag: 'patients.search' });
  if (p.uhid && Math.random() < 0.3) {
    trpc('patients.search', { q: p.uhid, limit: 20 }, { tag: 'patients.search' });
  }
  if (Math.random() < 0.5) trpc('queue.board', {}, { tag: 'queue.board' });
  sleep(int(1, 3));
}

// New patient at the desk: duplicate check, then save.
export function register() {
  const first = pick(FIRST);
  const last = pick(SURNAMES);
  const mobile = `9${String(int(0, 999999999)).padStart(9, '0')}`;
  trpc(
    'patients.checkDuplicates',
    { firstName: first, lastName: last, sex: 'F', age: '28', mobile },
    { tag: 'patients.checkDuplicates' },
  );
  trpc(
    'patients.create',
    {
      firstName: first,
      lastName: last,
      sex: 'F',
      age: String(int(18, 45)),
      mobile,
      referredBy: 'k6 load test',
      duplicateOverride: { reason: 'k6 load test' },
    },
    { kind: 'mutation', tag: 'patients.create' },
  );
}

// Visit at the desk then the fee in cash: the 150 bills/day.
export function visitAndPay(data) {
  const patient = pick(data.patients);
  const doctorId = pick(data.doctors);
  trpc('visit.preview', { patientId: patient.id, doctorId }, { tag: 'visit.preview' });
  const v = trpc(
    'visit.create',
    { patientId: patient.id, doctorId, allowRepeatToday: true, idempotencyKey: uuid() },
    { kind: 'mutation', tag: 'visit.create' },
  ).data;
  if (!v || !v.billId || v.tokenId) return; // free follow-up or unpriced: nothing to collect
  trpc(
    'billing.collect',
    {
      billId: v.billId,
      tenders: [{ mode: 'cash', amountPaise: String(v.feePaise) }],
      idempotencyKey: uuid(),
    },
    { kind: 'mutation', tag: 'billing.collect', bigints: ['tenders.0.amountPaise'] },
  );
}

export function handleSummary(data) {
  const out = __ENV.SUMMARY_JSON || 'k6-summary.json';
  return { [out]: JSON.stringify(data, null, 2) };
}
