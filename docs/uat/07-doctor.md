# UAT 07 — Doctor (gynaecologist and paediatrician)

Persons: each doctor separately. About 20 minutes. Role `doctor`. The doctor writes the Rx on
paper; the system's job for the doctor is the queue, the patient's history, and (if the owner
chooses) verifying what the assistant typed (`docs/40` Q15: off / sample / all).

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| K1 | Sign in on the room tablet. Open the Doctor page. | Your waiting patients, in token order, with priority marks. | | |
| K2 | Open a patient: timeline. | Past visits, prescriptions, orders and bills are listed newest first. | | |
| K3 | Open a pregnant patient. | ANC summary: EDD, GA today, risk flags, last visits. The EDD and flags are what you would calculate. | | |
| K4 | **Gynaecologist only:** read the default ANC visit schedule and the risk rules on the ANC card. | You agree, or write the changes on the sign-off sheet. This is the clinical sign-off of `docs/32 §5` for ANC. | | |
| K5 | **Paediatrician only:** open a child; read the vaccine schedule (IAP) and the growth chart; read the weight-based dose ranges. | You agree, or write the changes on the sign-off sheet. This is the sign-off for vaccines, growth and dose rules. | | |
| K6 | Verify queue (if verification is on): open one typed Rx beside the photo of the paper. | The photo of the paper and the typed lines are shown for checking; "Verify" records you as the verifier. | | |
| K7 | Look for any place that shows or asks for the baby's sex. | None exists. | | |
| K8 | Hindi: switch language and open a printed Rx instruction. | Instructions read naturally in Hindi. Write any wording you would change on the sign-off sheet. | | |

## Clinical sign-off notes

Changes required before go-live (write here):

______________________________________________________________________

## Problems found

| # | Step | What happened | Severity |
| --- | --- | --- | --- |
| | | | |

## Sign-off

Name: ____________________  Signature: ____________________  Date: ____________
Observer (vendor): ____________________
