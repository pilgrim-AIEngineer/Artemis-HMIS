# User acceptance scripts (Phase 1, OPD go-live)

Feature ID: OPS-01 (PR 22). Source rules: `docs/32 §4` (who signs), `docs/00 §5` (timing targets),
`docs/31 §7` (go-live gate), `docs/32 §2` (the E2E flows these scripts mirror).

Each real person who will use the system runs the script for their role in **training mode** and
signs it. The developers watch and note problems; they do not click for the person.

## Who does what

| Script | Person who must run and sign it | Home screen |
| --- | --- | --- |
| [01-owner.md](01-owner.md) | Owner (gynaecologist) | Dashboard |
| [02-reception.md](02-reception.md) | One receptionist (a second one repeats flow R3 only) | Registration and token |
| [03-vitals-nurse.md](03-vitals-nurse.md) | Whoever takes vitals (nurse or vitals desk) | Vitals desk |
| [04-assistant.md](04-assistant.md) | The assistant who types prescriptions | Transcription queue |
| [05-cashier.md](05-cashier.md) | One cashier | Billing |
| [06-admin.md](06-admin.md) | Hospital manager / admin | Admin |
| [07-doctor.md](07-doctor.md) | Gynaecologist and paediatrician (queue, verify) | Doctor's queue |

`docs/32 §4` asks for owner, receptionist, assistant, cashier (and a nurse from Phase 2). The vitals,
admin and doctor scripts are added because they are Phase 1 screens that staff use daily.

## Before the session (vendor checklist)

1. Training instance running the **same version** as production (`31 §4`). In this release it is a
   second copy seeded with `pnpm db:seed --demo` (500 patients, 30 days of OPD, 50 pregnancies,
   80 children), reached on a different host name. Never run UAT on the live database.
2. One user per participant with their real role (`demo_<role>` users are fine for training:
   password and PIN are printed by `db:seed --demo`). Participants change the demo password at
   first sign-in if the training copy is reachable from outside the hall.
3. Printers: thermal 80 mm, A5 tray, A4, and the sticker printer are connected and chosen as
   defaults for the workstation (Admin → Workstations).
4. Masters reviewed by the owner (`31 §7` item 1): doctors, fees, follow-up rules, services.
5. Stopwatch or phone timer. A printed copy of the script per participant, plus a pen.

## How to run it

- Read each step aloud only if the person asks. The point is to see whether the screen alone
  guides them.
- Mark **P** (pass), **F** (fail) or **N** (not applicable) for every step. "Pass" means the
  expected result happened **without help**. Any help given = **F** plus a note.
- Timed steps: start the timer when the person starts typing and stop at the stated result.
  Record the seconds. Targets come from `docs/00 §5`; they are measured with real staff, not
  developers.
- A failed step is written in the "Problems found" table with a severity:
  **Blocker** (cannot do the job, or wrong money / wrong patient data), **Major** (workaround
  exists but slow or confusing), **Minor** (cosmetic, wording).
- Every Blocker must be fixed and the step re-run before sign-off. Majors are decided case by case
  by the owner and written in the sign-off sheet.
- Language: run the script once in English and repeat the printed-document steps in Hindi if the
  person prefers Hindi (`language` switch on the login screen and in My account).

## Timing targets (docs/00 §5)

| What | Target |
| --- | --- |
| Returning patient: search → token → receipt (average receptionist) | 60 s or less |
| New patient: register → token → receipt | 120 s or less |
| Typical 4-drug Rx typed by the assistant | 60 s or less |
| Day-end: counter close with denominations | no manual correction of totals |

## Sign-off

Each script ends with a sign-off box. The signed sheets are **scanned and stored in this folder**
as `signed/<date>-<role>-<name>.pdf` (kept by the vendor, a copy with the hospital). The summary
table below is kept up to date by the vendor.

| Role | Person | Date | Result (all P / with notes) | Timing met | Scan |
| --- | --- | --- | --- | --- | --- |
| Owner | | | | | |
| Reception | | | | | |
| Vitals / nurse | | | | | |
| Assistant | | | | | |
| Cashier | | | | | |
| Admin | | | | | |
| Doctor: gynaecology | | | | | |
| Doctor: paediatrics | | | | | |

Go-live may start only when every row above is signed and `docs/35-go-live-checklist.md` item
GL-07 (staff trained) is ticked.

## Sheet header (copy at the top of each printed script)

```
Participant: ______________________   Role: ______________   Date: ____________
Observer (vendor): _________________   Software version: ____________   Language: EN / HI
Workstation: ____________   Printer(s) used: ______________________________
```
