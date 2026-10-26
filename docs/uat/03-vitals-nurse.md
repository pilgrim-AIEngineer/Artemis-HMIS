# UAT 03 — Vitals desk (nurse or vitals staff)

Person: whoever takes vitals. About 30 minutes. Role `nurse` (or any role with `vitals.record`).
Mirrors `docs/32` flow 3. Normal ranges and flags come from `docs/11`; the gynaecologist and
paediatrician confirmed them (`docs/32 §5`).

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| V1 | Open Nursing → Vitals desk. | The list of patients waiting for vitals, oldest first, with token numbers. | | |
| V2 | Open an **adult** patient (use "Enter vitals"). Type BP, pulse, temperature, SpO₂, weight, height using the keyboard only (Tab moves in the order of the paper form). | Fields accept numbers; BMI is calculated; no mouse needed. | | |
| V3 | On a **tablet**: do the same with the on-screen "Number pad" (touch only). | Number pad opens for each field; "Decimal point" works; large keys are easy to hit. | | |
| V4 | Type a BP where the lower number is bigger than the upper (for example 80 / 120). | Message "The lower BP must be less than the upper BP." Save is blocked. | | |
| V5 | Type an impossible value (for example weight 700). | "This value cannot be right. Please check it." Save is blocked. | | |
| V6 | Type a high BP (for example 160 / 110) on an adult. | The value is flagged as out of range but can be saved. | | |
| V7 | **Pregnant** patient: choose "Pregnant" and enter vitals, including the swelling (oedema) choice. | Pregnancy fields appear; a raised BP shows the flag and appears later as a risk on the ANC card. | | |
| V8 | **Child under 2 years**: enter weight, length and head circumference. | The child form has no BP; head circumference is asked. | | |
| V9 | Save vitals. | "Vitals saved". The OPD sheet can be printed with the vitals ("Print OPD sheet"). Token moves to "vitals done". | | |
| V10 | Reprint the sheet. | The A5 sheet shows the vitals and still fits on one page. | | |
| V11 | "Correct vitals" on a patient whose vitals you just saved. | The values can be corrected; the correction is recorded in the audit log. | | |
| V12 | Try to open Billing from your login. | Not available to you. | | |

## Problems found

| # | Step | What happened | Severity |
| --- | --- | --- | --- |
| | | | |

## Sign-off

Name: ____________________  Signature: ____________________  Date: ____________
Observer (vendor): ____________________
