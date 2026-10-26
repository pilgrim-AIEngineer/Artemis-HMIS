# 21 — WhatsApp and notifications [Phase 1]

Feature ID: MSG-01.

## 1. Provider

WhatsApp Business Platform via one provider adapter: Meta Cloud API directly, or an Indian BSP (Gupshup, Interakt, AiSensy, etc.). Implement `MessagingProvider` interface (`sendTemplate`, `sendDocument`, `getStatus`, webhook parser) with one concrete adapter selected in settings. Webhooks for delivery status are optional (they need a public URL — use a small relay; if absent, poll status or skip).

## 2. Consent

- At registration: "WhatsApp messages OK?" (default yes, with verbal consent recorded as `patient_consent(kind=whatsapp, method=verbal_recorded)`). Opt-out honoured immediately ("STOP" replies via webhook when available, or staff toggle).
- Restricted encounters (MTP) never trigger messages unless explicitly sent by an MTP user.

## 3. Messages (templates must be approved by Meta; Hindi and English variants)

| Kind | Trigger | Content |
| --- | --- | --- |
| Receipt | Payment collected (setting on/off) | Hospital name, amount, receipt no., date; PDF attached |
| Rx summary | Transcription saved (optional) | Medicines with Hindi instructions; follow-up date |
| Lab report | Report released | PDF |
| USG report | Report signed (setting; default off — many centres hand over physically) | PDF |
| Follow-up reminder | 1 day before follow-up date, 10 am | Doctor, date, hospital address/phone |
| ANC reminder | 2 days before suggested next ANC visit | Visit due, tests due |
| Vaccine reminder | 2 days before due | Vaccine name, due date |
| Discharge | Summary signed | Summary PDF + bill PDF |
| Owner daily summary | After facility day close | Totals (to owner only) |

## 4. Mechanics

- All sends go through `message_outbox`; the worker sends when online, retries with exponential backoff for 48 h, then marks failed.
- Quiet hours: no reminders 9 pm – 8 am.
- De-duplication: same template + patient + entity within 24 h → skip.
- PDFs rendered by the worker, stored in `document`, uploaded to provider media API at send time.
- Message log per patient visible in the timeline (sent/delivered/failed).
- Cost control: setting monthly cap; alert at 80%.

## 5. Internal notifications

In-app toasts/alerts (SSE) for: critical lab value, critical vitals, Rx verification pending, deposit low, Form F/MTP/birth report due, backup failure (admin), day close pending at 10 pm.

## 6. Implementation notes (MSG-01)

- `packages/shared/src/messaging.ts`: template registry (en/hi, variable order), retry/backoff, quiet hours, mobile normalisation. Provider template names are `hmis_<kind>_<lang>` and must be created and approved in Meta; `message_template.is_approved` gates real sending (the `fake` provider ignores it).
- `packages/db/src/messaging.ts`: `enqueueMessage` (settings, consent per D-9, 24 h de-duplication, quiet hours) and the worker's claim/result steps. Statuses add `sending` and `skipped_no_consent` to docs/04 §13.
- Worker: `outbox.whatsapp` runs every minute; `reminder.daily` at 19:00 IST queues tomorrow 10:00 follow-up, ANC and vaccine reminders. Settings: `whatsapp.enabled`, `.provider` (`meta` | `fake`), `.sendReceipts`, `.followUpLeadDays` (1), `.ancLeadDays` (2), `.monthlyCap` (0 = none).
- Meta credentials come from the server environment only: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`. Without them messages stay queued.
- Meta has no idempotency key: a worker that dies between the provider call and saving `sent` re-sends after the 15 minute claim timeout (at-least-once). The fake adapter de-duplicates on the outbox id, which the tests rely on.
