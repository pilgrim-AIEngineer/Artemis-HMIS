# 24 — ABDM and NHCX [Phase 3]

Feature IDs: ABD-01, ABD-02, NHX-01.

Not built in Phases 1–2, but Phase 1–2 code must not block it. Before starting, read the current ABDM sandbox documentation (sandbox.abdm.gov.in) and NHCX documentation; APIs and certification steps change.

## 1. Design hooks to keep now

- `patient_identifier` supports `abha_number` and `abha_address`.
- `facility.hfr_id`, `doctor_profile.registration_no` (HPR id field to add later).
- Clinical data is structured enough to map to FHIR R4 (Patient, Encounter, Practitioner, Organization, Condition, MedicationRequest, Observation, DiagnosticReport, Composition for OPConsultation / Prescription / DischargeSummary / DiagnosticReport bundles following NRCeS/ABDM profiles).
- Documents (PDF reports) are stored with sha256 and can be attached to FHIR bundles.
- The local server has no public URL: ABDM/NHCX callbacks will come through a small cloud relay (separate repo) that forwards to the hospital server over Tailscale or Cloudflare Tunnel, with message signing.

## 2. ABD-01: M1

- ABHA creation (Aadhaar OTP / mobile flows as per current ABDM APIs) and verification at reception; link ABHA to patient.
- **Scan and Share**: hospital QR at reception; patient scans with an ABHA app; profile arrives as a queue entry; reception confirms/creates the patient and issues a token. Big time-saver at 150 OPD/day.

## 3. ABD-02: M2 / M3

- M2 (HIP): care-context linking for visits/admissions; consent notification handling; FHIR bundle generation and encrypted transfer.
- M3 (HIU): consent requests and fetching records from other facilities; display in the timeline as external records.
- Certification: functional testing + security audit (WASA) by empanelled agencies; keep the ABDM module isolated (`packages/abdm`) so re-audits are scoped.

## 4. NHX-01: NHCX

- Participant registration, encryption (JWE) and signing per NHCX specs; FHIR claim resources from `preauth`/`claim`.
- Use NHA reference adapters only after checking their licences.
