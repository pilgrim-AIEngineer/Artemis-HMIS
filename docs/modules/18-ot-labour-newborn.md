# 18 — OT, labour room, newborn and birth/death registers [Phase 2A]

Feature IDs: OT-01, LR-01, NB-01.

## 1. OT (OT-01)

- **Schedule**: calendar by OT room; booking with patient/admission, procedure (service), surgeon, assistant, anaesthetist, planned start/duration, anaesthesia type planned, special needs (blood arranged, implants). Conflicts warned.
- **Pre-op checklist**: consent signed (upload), NPO status, investigations reviewed, blood arranged, site marked (if applicable), PAC done (pre-anaesthesia check note), jewellery removed. Must be complete to start (warning, override with reason).
- **WHO Surgical Safety Checklist** (sign-in, time-out, sign-out) as a tablet form.
- **OT note**: procedure, indication, anaesthesia type, findings, steps (template text per procedure — LSCS, hysterectomy, D&C, laparoscopy, tubectomy, cerclage, cystectomy), blood loss, specimens sent (creates histopathology order — outsourced), drains, complications, start/end times, surgeon signature. Templates editable by surgeon.
- **Consumables & charges**: OT store consumption entry (or pick list per procedure template) → posted to IPD bill (inside/outside package rules). OT charges, surgeon/anaesthetist fees auto-posted from the procedure's service bundle.
- Anaesthesia record (simple): pre-induction vitals, drugs given with times and doses, intra-op vitals every 15 min (manual), recovery notes.

## 2. Labour room (LR-01)

- **Labour admission** fast path (priority token `labour` from reception or direct): minimal fields, bed in LR, then complete details later.
- **Partograph (simplified digital)**: time-series entries for cervical dilatation, descent, contractions (frequency/duration), FHR, liquor, moulding, maternal pulse/BP/temp, oxytocin and drugs. Chart view showing alert/action lines per the standard partograph (WHO modified partograph; the hospital may later adopt the WHO Labour Care Guide — keep the entry model generic: `partograph_entry` with configurable fields). Printable.
- **Delivery note**: delivery time, mode (NVD, vacuum, forceps, emergency LSCS, elective LSCS, VBAC), GA, episiotomy/tear, placenta, blood loss, PPH and management, oxytocin (AMTSL), complications, conducted by, attendants, number of babies.
- On save, for each baby → newborn record (see 3). For LSCS the delivery note links to the OT note.
- Pregnancy closes with outcome `delivered`.

## 3. Newborn (NB-01)

- Each baby becomes a `patient` with its own UHID, name "Baby of <mother full name>" (renamed later), DOB/time, sex of the baby (recorded at/after birth — this is NOT fetal sex and is allowed), weight, length, head circumference, APGAR 1/5, resuscitation, outcome.
- Linked to mother (`newborn` table). Birth-dose vaccines (BCG, OPV-0, Hep B-0) and vitamin K recorded → feed paediatric immunisation schedule.
- Paediatrician's newborn examination note template.
- NICU / baby warmer admission as a separate IPD encounter for the baby if needed (own bill or added to mother's bill — setting `newborn.billing` = `mother_bill` (default for normal care) or `separate`).

## 4. Birth, death and still-birth registers

- **Birth register** auto-created from each live birth: date/time, sex, weight, place (this hospital), mother's name, father's name, address, mother's age, birth order, delivery type, attendant. Report list for submission to the Registrar through the Civil Registration System (CRS) within **21 days** of the event (RBD Act; institutions report digitally). Track `reported_to_registrar_at` and CRS reference.
- **Still-birth register** and **death register** with cause of death (free text + ICD-10), MCCD (Medical Certificate of Cause of Death) print template (Form 4/4A — confirm current format), reported date and reference.
- Dashboard alert for events not reported within 14 days.
- Birth certificate itself is issued by the registrar; the hospital may print a "birth intimation/discharge slip" with the registration details.

## 5. Acceptance

- One delivery note with twins creates two newborn patients, two birth register entries, linked correctly.
- Pregnancy outcome closure updates the ANC register and the active-pregnancy constraint.
- OT consumables posted correctly inside/outside package (fixtures).
