# UAT 06 — Administrator

Person: hospital manager / admin. About 45 minutes. Role `admin`.
Covers `docs/31 §7` items that need an administrator: users, roles, masters, printers, TV link,
import. Nothing here may use real patient data in training.

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| M1 | Admin → Users → New user: a receptionist with a temporary password of 12 or more characters. | User is created; the temporary password is shown once. A password shorter than 12 characters, or one that is very common, is refused with a message. | | |
| M2 | Sign in as the new user in another browser. | The system forces a new password before anything else; the new password must differ from the old. | | |
| M3 | Set the user's PIN (My account). Try 1234 and 0000. | Easy PINs are refused; a good PIN is accepted. | | |
| M4 | Reset the password of a user. | That user is signed out everywhere and must choose a new password. | | |
| M5 | Deactivate a user. | They cannot sign in; their past work stays and still shows their name. | | |
| M6 | Admin → Roles: open "Reception" and read the permissions. | The list matches what the owner approved. Do not change. | | |
| M7 | Try three wrong passwords for a test user. | The account locks for the set time (default 15 minutes) with a clear message. | | |
| M8 | Admin → Masters: doctors, services, tariffs (rates). Add a rate for a service and a date it starts. | Rate shows on new bills from that date; older bills do not change. | | |
| M9 | Admin → Settings: view follow-up validity days, free follow-ups, discount limits, idle lock time. | Values agree with `docs/40` decisions; each setting explains itself. | | |
| M10 | Admin → Facility and Print header: set the hospital name, address, registration numbers and logo. Open the sample prints for A4, A5 and 80 mm. | Header shows on all three; nothing is cut off. | | |
| M11 | Admin → Workstations: pair this PC as "Reception 1" and choose default printers. | The name shows next to actions in the audit log. | | |
| M12 | Admin → TV display: "Make a new TV link", open it on the display PC. | The TV shows the queue; the old link stops working. | | |
| M13 | Admin → Import: upload the hospital's patient Excel (or the sample file) as a **dry run**. | The error report lists each bad row with the reason; nothing is saved until you commit. | | |
| M14 | The vendor shows the audit entry for the user created in M1 (Phase 1 has no audit screen; the entry is read from the database). | Who, when, old and new values, and the workstation. | | |
| M15 | Try to open a record that is MTP-restricted (not applicable in Phase 1 — mark N). | — | | |

## Problems found

| # | Step | What happened | Severity |
| --- | --- | --- | --- |
| | | | |

## Sign-off

Name: ____________________  Signature: ____________________  Date: ____________
Observer (vendor): ____________________
