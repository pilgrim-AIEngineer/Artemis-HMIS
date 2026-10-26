# 36 — Load test (k6) and results

Feature ID: OPS-01 (PR 22). Targets from `docs/32 §1`: peak OPD with 15 concurrent users,
40 registrations/h, 150 bills/day, **patient search p95 < 300 ms**, **mutations p95 < 1 s**.

## What runs

- `apps/web/load/k6/peak-opd.js` (+ `lib.js`): three scenarios against the real tRPC API as
  user `demo_reception`:
  - `desk_browsing`: 15 constant VUs; patient search by name, mobile, UHID; queue board; think time 1–4 s.
  - `registrations`: constant arrival rate, 40/h × `SCALE` (duplicate check + `patients.create`).
  - `visits_and_payments`: 30/h × `SCALE` (150 bills/day over the 5-hour peak): `visit.preview`,
    `visit.create`, then `billing.collect` in cash.
- `apps/web/load/run-load.ts` (`pnpm load`): builds a throwaway stack like the production image
  (Testcontainers Postgres on a random port, migrations, app DB role, `db:seed --demo` data, the
  standalone Next build on a random port), runs k6, writes the summary JSON, removes everything.
  Needs `pnpm build` first and k6 (`K6_BIN` or `k6` on PATH). Env: `SCALE`, `DURATION`, `USERS`,
  `LOAD_OUT`.
- Thresholds in the script fail the run (exit code 99) if search p95 ≥ 300 ms, mutation or query
  p95 ≥ 1 s, request failures ≥ 1 %, or checks < 99 %.
- Everything created is synthetic. Do not point the script at a live database.

```
pnpm build
K6_BIN=/path/to/k6 SCALE=1 DURATION=10m pnpm load      # documented peak
K6_BIN=/path/to/k6 SCALE=4 DURATION=5m  pnpm load      # stress
```

## Results (26 Oct 2026)

**Not the production server.** Development host: 16 cores, 62 GB RAM, NVMe, Postgres in Docker on
the same machine as the web app and k6, k6 v2.3.0. The reference server in `31 §1` (i5/Ryzen 5,
32 GB) is slower per core, so **re-run on the hospital server before go-live** (`35` SW-03).
Seed in the stack: 500 patients, 416 OPD visits, 50 pregnancies, 80 children.

| Run | Rates | Duration | Requests | Search p95 | Mutation p95 | Query p95 | Failed | Thresholds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Target | `SCALE=1` (40 reg/h, 30 paid visits/h, 15 users) | 10 min | 5,082 | 9.9 ms | 49 ms | 9.9 ms | 8 (0.16 %) | pass |
| Stress | `SCALE=4` (160 reg/h, 120 visits/h) | 5 min | 2,581 | 10.3 ms | 35 ms | 10.5 ms | 0 | pass |
| Repeat of target | `SCALE=1` | 4 min | 2,082 | 10.5 ms | 48 ms | 10.6 ms | 0 | pass |

Mutation averages were 20–23 ms; the slowest single request in any run was 219 ms.

### Open point

The first target run had 8 failed requests, all `patients.search`, out of 4,134 searches. The
cause was not captured (the script then did not log failures). The script now logs the
procedure, HTTP status and error key of every failure; two later runs had none. Follow-up: run
`SCALE=1` for 30 minutes on the hospital server and keep the log; if a failure appears, its
status and key will say whether it is a session, validation or capacity problem.

### What this does and does not show

- The API and database sustain several times the documented peak with a 500-patient database
  and 30 days of OPD, with large headroom on this host.
- Patient search on 2 lakh patients is covered by `packages/db/perf/patients-search-speed.test.ts`
  (300 ms budget), not by k6.
- Browser rendering time, printing and the thermal printer are not measured here.
