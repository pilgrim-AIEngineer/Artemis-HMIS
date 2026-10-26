# 34 — OWASP ASVS Level 1 checklist

Feature ID: OPS-01 (hardening, PR 22). Required by `01 §9` before each phase go-live; it also
prepares the ground for the ABDM WASA audit later.

- **Standard:** OWASP ASVS 4.0.3, Level 1. Item numbers and wording are paraphrased from that
  version. Whoever signs this off (see "Sign-off" at the end) should read it next to the
  official ASVS PDF; the paraphrases here are short on purpose.
- **Scope:** the Phase 1 build (`apps/web`, `apps/worker`, `packages/*`, `infra/`). Re-run before
  each phase go-live and when auth, files, or the proxy change.
- **Method:** code review of the paths named in "Evidence", the automated tests named there, and
  `pnpm audit --prod`. No external penetration test was done (see "Follow-ups").
- **Status values:**
  - **Pass**: met, evidence given.
  - **Fixed**: failed when first reviewed, fixed in PR 22 (the fix is named).
  - **Accepted**: not met or only partly met; the risk and the reason are written down and the
    owner of the decision is named. Nothing here is silently skipped.
  - **N/A**: the feature does not exist in this product (reason given).

Where a test is named, `E2E` means `apps/web/e2e/asvs.spec.ts` unless another file is given.

## V1 Architecture, design and threat modelling

ASVS 4.0.3 has no Level 1 items that need more than the documents already in the repo; the
design-level controls are checked under the later chapters.

| Topic | Status | Evidence |
| --- | --- | --- |
| Security-relevant architecture documented (trust boundaries, auth, roles, restricted data) | Pass | `01 §5, §9`, `03`, `30`; Postgres only on the Docker network; Caddy is the only listener (`infra/docker/caddy/Caddyfile`) |

## V2 Authentication

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 2.1.1 | Passwords at least 12 characters | **Fixed** | Was 8. `PASSWORD_MIN_LENGTH = 12` in `packages/shared/src/auth.ts`; unit test `auth.test.ts`; message `validation.passwordShort` (en, hi) |
| 2.1.2 | 64 characters allowed, over 128 may be refused | Pass | `passwordSchema` max 128 |
| 2.1.3 | No truncation; no silent whitespace change | Pass | Password is hashed as typed (`loginPasswordSchema` has no `.trim()`) |
| 2.1.4 | Any printable Unicode allowed | Pass | No character class restriction |
| 2.1.5 / 2.1.6 | User can change password; needs current and new | Pass | `auth.changePassword` takes `currentPassword` + `newPassword`; `auth.test.ts` |
| 2.1.7 | Check against common/breached passwords | **Fixed** (partly) | Was missing. `isCommonPassword` rejects a built-in list and single-character repeats (`validation.passwordCommon`). The server is offline, so no breach corpus; see follow-up F1 |
| 2.1.8 | Password strength meter | Accepted | Not built. Staff are told the rules in words (12+ characters, not a common password). Low value on a LAN-only system with lockout and a common-password check. Owner of decision: product |
| 2.1.9 | No composition rules | Pass | Only length and the common list |
| 2.1.10 | No forced periodic rotation | Pass | None; admin reset forces a change (`passwordMustChange`) |
| 2.1.11 | Paste and password managers allowed | Pass | No paste blocking; `autocomplete` set on login and change forms |
| 2.1.12 | Show-password option | Pass | `login-flow.tsx` show/hide toggle |
| 2.2.1 | Anti-automation: lockout / throttling | Pass | Lock after `auth.maxLoginFailures` for `auth.lockoutMinutes`; separate PIN lockout; `auth.test.ts` |
| 2.2.2 | SMS/PSTN not the only strong factor | N/A | No SMS or OTP by phone. TOTP is used for remote owner/admin |
| 2.2.3 | Users notified of credential changes | Accepted | No email or SMS exists. Changes are in `audit_log` and the admin sees them. Owner of decision: product |
| 2.3.1 | Initial passwords random, single use, expiring | Pass | Generated with `randomBytes` (`bootstrap.ts`); `passwordMustChange` forces a new one at first sign-in; installer prints it once |
| 2.5.1 | No initial password sent in clear to the user by mail | Pass | Shown once to the admin on screen/console; nothing is mailed |
| 2.5.2 | No password hints or knowledge questions | Pass | None exist |
| 2.5.3 | Recovery never reveals the old password | Pass | Admin reset only; hashes are argon2id |
| 2.5.4 | No shared or default accounts | Pass | One user per person (`31 §7`); the first admin password is random; demo users exist only with `db:seed --demo` and are not created by `install.sh` |
| 2.5.6 | Secure recovery mechanism | Pass | Admin reset by a user with `admin.users.manage`; revokes the user's sessions (`users.ts`) |
| 2.7.x | Out-of-band authenticators | N/A | None used |
| 2.8.1 | Time-based OTP valid only briefly | Pass | `totp.ts`: 30 s step, `totpLastStep` stops code re-use |
| 2.4.1 (L2) | Password hashed with an approved KDF | Pass (above L1) | argon2id (`@node-rs/argon2`) |

## V3 Session management

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 3.1.1 | Session token never in the URL | Pass | Cookie only (`session.ts`) |
| 3.2.1 | New session token on authentication | Pass | `login` revokes the previous session and issues a new token; `auth.test.ts` |
| 3.2.2 | Token has at least 64 bits of entropy | Pass | `randomBytes(32)`; only the SHA-256 is stored (`tokens.ts`) |
| 3.2.3 | Token kept in a secure cookie, not web storage | Pass | `HttpOnly` cookie; no localStorage use |
| 3.3.1 | Logout and expiry invalidate the session | Pass | `endSession` revokes server-side; 12 h absolute, idle lock; E2E "logout ends the session" replays the old cookie and gets 401 |
| 3.4.1 | Cookie `Secure` | Pass | `serializeCookie` always sets it; E2E checks the flag |
| 3.4.2 | Cookie `HttpOnly` | Pass | Same; E2E, `auth.spec.ts` |
| 3.4.3 | Cookie `SameSite` | Pass | `Lax`; E2E |
| 3.4.4 | Cookie uses the `__Host-` prefix | **Fixed** | Was `hmis_session`. Now `__Host-hmis_session` (Secure, Path=/, no Domain). Users are signed out once at the update |
| 3.4.5 | Cookie path as narrow as possible | Pass | `Path=/` is required by `__Host-`; the app serves only this application |
| 3.7.1 | Re-authentication before sensitive actions | Pass | Password confirmation for password/PIN/TOTP changes; supervisor PIN for discounts and refunds (`03 §4`); PIN unlock after idle |

## V4 Access control

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 4.1.1 | Access control enforced on a trusted server layer | Pass | Every procedure declares `.meta({ permission })`; the access middleware (`init.ts`) refuses a procedure without it; router-walk test `access.test.ts` |
| 4.1.2 | User/permission attributes cannot be changed by the user | Pass | Permissions are loaded from the DB per request (`loadUserAccess`); nothing trusts client claims |
| 4.1.3 | Least privilege | Pass | Default roles in `03`; `rbac.test.ts` pins the role matrix; app DB role has no DELETE and no UPDATE on `audit_log` (`packages/db/README.md`, `platform.test.ts`) |
| 4.1.5 | Access control fails securely | Pass | Unknown or unlabelled procedures are refused (INTERNAL_SERVER_ERROR, not allowed) |
| 4.2.1 | No direct object reference by id alone | Pass | Every query is filtered by the session's `facility_id`; Rx photo route checks session, permission and facility; restricted (MTP) schema has row-level security |
| 4.2.2 | Anti-CSRF for state changes | Pass | Same-origin check plus double-submit token before tRPC runs (`checkCsrf`); E2E "state-changing request needs the CSRF token", `handler.test.ts` |
| 4.3.1 | Admin interfaces need multi-factor | Pass | Remote (outside `auth.lanNetworks`) owner/admin sign-in requires TOTP; LAN access is the hospital network. Local admin without TOTP is an accepted LAN-only design (`01 §5`) |
| 4.3.2 | No directory listing / metadata leak | Pass | No static file serving of the files volume; documents go through an authorised route |
| 4.3.3 | (L2) step-up for high-value | Pass (above L1) | Supervisor PIN and approval records (`approvals.ts`) |

## V5 Validation, sanitisation and encoding

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 5.1.1 | HTTP parameter pollution defended | Pass | tRPC reads one JSON body; zod rejects unknown shapes |
| 5.1.3 | All input validated (allow-list) | Pass | zod on every procedure input (`02 §7`); forbidden-term guard on free text (`40` D-10) |
| 5.1.4 | Structured data strongly typed | Pass | zod schemas in `packages/shared`; money as bigint paise |
| 5.1.5 | URL redirects only to allow-listed targets | Pass | No open redirect: the only redirects are to fixed internal routes |
| 5.2.1 | Untrusted HTML sanitised | Pass | No user HTML is accepted or rendered; all `dangerouslySetInnerHTML` uses (`print-settings.tsx`, `(app)/layout.tsx`, print QR/barcode) render server-generated SVG or CSS, with the accent colour validated as `#rrggbb` |
| 5.2.2 | Unstructured data sanitised | Pass | Free text is stored as text and shown through React escaping |
| 5.2.3 | No injection into mail/SMTP | N/A | No mail sent |
| 5.2.4 | No `eval` or dynamic code | Pass | `grep` finds no `eval`/`new Function` in `apps` or `packages` |
| 5.2.5 | No template injection | Pass | Print templates are React components, not string templates |
| 5.2.6 | SSRF protection | Pass | The server fetches only URLs from root-owned env (`OPS_ALERT_WEBHOOK_URL`, `HEALTHCHECK_PING_URL`, WhatsApp provider), never a user-supplied URL |
| 5.3.1 | Output encoding for context | Pass | React auto-escaping; CSP forbids inline script |
| 5.3.3 | Context-aware output escaping against XSS | Pass | As above; strict CSP with per-request nonce (`proxy.ts`), E2E `smoke.spec.ts` |
| 5.3.4 | Parameterised queries | Pass | Drizzle everywhere; the few `sql.raw` uses take only compile-time constants (enum lists, ceilings) |
| 5.3.6 | JSON injection / eval | Pass | superjson parse only |
| 5.3.8 | OS command injection | Pass | No shell-out in the web app; the worker drives Chromium through the Playwright API, not a shell string; ops scripts take validated arguments |
| 5.3.9 | Local/remote file inclusion | Pass | `absolutePath` refuses paths that leave the files root (`files.ts`) |

## V7 Error handling and logging

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 7.1.1 | No credentials or payment data in logs | Pass | Log lines carry path/code only (`handler.ts`); pino without PHI (`01 §8`); audit redacts secret columns |
| 7.1.2 | No other sensitive data in logs | Pass | `AGENTS.md` rule 15; forbidden-term rejections are logged without the text |
| 7.4.1 | Generic error message, no stack traces | Pass | `formatError` maps internal errors to `errors.internal`; zod issues only carry paths and keys |

## V8 Data protection

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 8.1.1 | Sensitive data not cached on the server | Pass | No server-side response cache; tRPC and file routes send `no-store` |
| 8.2.1 | Anti-caching headers on sensitive responses | Pass | `Cache-Control: no-store` on tRPC, documents, events and health; authenticated pages are dynamic and non-cacheable; E2E "pages are not cached" |
| 8.2.2 | No sensitive data in browser storage | **Fixed** | The Rx draft autosave (OPD-04) keeps clinical text in `localStorage` (key: visit id only). It was cleared on save/discard but not on sign-out, so a shared PC kept the last user's draft. Now `clearAllLocalDrafts` runs on sign-out, "switch user" and server-side session end (`session-provider.tsx`); unit test in `rx-state.test.ts`. The server copy remains, so the same user gets the draft back. Still on the PC after an idle lock or a crash until the next sign-out (accepted, follow-up F3). Other keys hold only a doctor id |
| 8.3.1 | Sensitive data sent in the body/headers, not the URL | Pass | Queries go by POST so a name or mobile never lands in a URL or access log (`client.tsx`) |

## V9 Communications

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 9.1.1 | TLS for all client connectivity | Pass | Caddy `tls internal` is the only listener; cookies are `Secure`; installer opens 443 from the LAN only |
| 9.1.2 | Strong protocols and ciphers | Pass | Caddy defaults (TLS 1.2+ with modern suites) |
| 9.1.3 | Only current TLS versions | Pass | Same |

## V10 Malicious code

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 10.3.2 | Integrity of downloaded code | Pass | No runtime-fetched code; the browser loads only same-origin scripts (CSP `script-src 'self'` + nonce); images are built and pulled by version tag |

## V11 Business logic

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 11.1.1 | Steps processed in order, no skipping | Pass | Server-side state machines (queue states, bill status, day close); tested in `queue.test.ts`, `billing.test.ts`, `day-close.test.ts` |
| 11.1.2 | Realistic limits on business actions | Pass | Money ceiling (`MONEY_CEILING_PAISE`), discount limits by role, refund approval threshold per bill |
| 11.1.3 | Anti-automation of expensive actions | Pass | Lockouts; idempotent payments (`idempotency_key`) stop duplicate submits |
| 11.1.4 | Sequential/duplicate protection | Pass | Number series inside the transaction; idempotency table |

## V12 Files and resources

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 12.1.1 | Large files cannot fill storage | Pass | Rx photo capped at 10 MB (`MAX_UPLOAD_BYTES`), base64 length limited by zod |
| 12.2.1 | File type verified | Pass | JPEG magic bytes checked on the server (`isJpeg` in `routers/rx`), MIME stored as `image/jpeg` only |
| 12.3.1 | User file names not used on disk | Pass | Server-generated `uuid.ext` paths (`newFilePath`) |
| 12.3.2 | No LFI/RFI | Pass | `absolutePath` root check; `wx` flag never overwrites |
| 12.4.1 | Files outside the web root | Pass | `/data/files` volume, served only through `/api/documents/...` after a session and permission check |
| 12.5.1 | Only intended file types served | Pass | Route serves the stored MIME with `nosniff` and `Content-Disposition: inline` |
| 12.6.1 | SSRF | Pass | See 5.2.6 |

## V13 API and web service

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 13.1.1 | Same security controls on all API paths | Pass | One tRPC handler for all procedures; the three plain routes (`events`, `documents`, `display/queue`) check the session or a hashed display key |
| 13.2.1 | HTTP methods allow-listed | Pass | Route handlers export only the methods they implement; the tRPC handler is the only POST sink |
| 13.2.2 | JSON schema validation | Pass | zod on all inputs |
| 13.2.3 | CSRF protection for REST | Pass | See 4.2.2; the plain routes are GET-only and read-only |

## V14 Configuration

| ID | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 14.1.x | Build is repeatable and warnings are fixed | Pass | CI runs `pnpm lint`, `typecheck`, `test`, `check:forbidden`; Docker images are versioned |
| 14.2.1 | Components up to date, no known vulnerabilities | Accepted | `pnpm audit --prod` (26 Oct 2026): 1 moderate, `uuid` < 11.1.1 through `exceljs` (GHSA-w5hq-g745-h8pq). The flaw is in `uuid` v3/v5/v6 called with a caller-supplied buffer; `exceljs` uses `v4()` without a buffer, so the code path is not reachable. Revisit when `exceljs` updates (follow-up F2) |
| 14.2.2 | Unneeded features, samples and documentation removed | Pass | Standalone Next build; no sample routes; `X-Powered-By` removed (`poweredByHeader: false`, `Server` header dropped in Caddy) |
| 14.2.3 | No third-party assets from untrusted CDNs | Pass | CSP `default-src 'self'`; fonts and icons are bundled |
| 14.3.2 | Debug modes off in production | Pass | `NODE_ENV=production` in the images; error details are not returned |
| 14.3.3 | No version or framework details in headers | Pass | No `X-Powered-By`; `/api/health` shows the app version only (see 14.5 note) |
| 14.4.1 | Content-Type with charset on every response | Pass | Next and Caddy set it; E2E smoke |
| 14.4.2 | API responses have a safe Content-Disposition | Pass | `inline` + `nosniff` for stored photos only |
| 14.4.3 | CSP present | Pass | Nonce CSP from `proxy.ts`, baseline from `next.config.ts` |
| 14.4.4 | `X-Content-Type-Options: nosniff` | Pass | `next.config.ts` and Caddy; E2E |
| 14.4.5 | HSTS | Pass | Caddy `Strict-Transport-Security max-age=31536000` |
| 14.4.6 | Referrer-Policy | Pass | `no-referrer`; E2E |
| 14.4.7 | Not embeddable by other sites | Pass | `frame-ancestors 'none'` + `X-Frame-Options: DENY`; print pages `'self'` only (hidden print frame); E2E |
| 14.5.1 | Only the defined HTTP methods are accepted | Pass | See 13.2.1 |
| 14.5.2 | Origin header not used for authorisation | Pass | `Origin` is used only for CSRF; authorisation comes from the session |
| 14.5.3 | Strict CORS | Pass | No CORS headers are sent; `Cross-Origin-Resource-Policy: same-origin` |
| 14.5.4 | Headers cannot be spoofed to bypass controls | Pass | Caddy overwrites `X-Forwarded-For` with the peer address, so the LAN check for remote TOTP cannot be forged (`request.ts`) |

Note on `/api/health`: it is open on purpose (compose healthcheck, Uptime Kuma, `backup-check.sh`).
It reveals the app version, free-disk percentage and backup age, and no patient data. Caddy
serves the app only to the hospital LAN and Tailscale. Accepted; owner of decision: product.

## Findings summary

| Result | Count | Items |
| --- | --- | --- |
| Fixed in PR 22 | 4 | 2.1.1 (12 characters), 2.1.7 (common-password check), 3.4.4 (`__Host-` cookie), 8.2.2 (Rx draft cleared from the browser on sign-out) |
| Accepted (written risk) | 4 | 2.1.8 (no strength meter), 2.2.3 (no credential-change notification), 14.2.1 (`uuid` advisory, unreachable), `/api/health` openness |
| Open failures | 0 | |

## Follow-ups

- **F1** Check passwords against a larger offline list (for example the top 100,000 from a public
  corpus) instead of the short built-in list. Needs a licence decision on the list.
- **F2** Re-run `pnpm audit --prod` in CI and fail the build on high/critical; override or upgrade
  `exceljs`'s `uuid` when a compatible release appears.
- **F3** Re-check browser storage use (8.2.2) whenever a new draft-autosave screen is added; consider clearing drafts on idle lock too if the lock screen proves to be used as a hand-over.
- **F4** A level-1 review by a person who is not the author, and an external test before
  PM-JAY/ABDM work (Phase 2B), as `01 §9` plans.

## Sign-off

| Role | Name | Date | Signature |
| --- | --- | --- | --- |
| Implementer | | | |
| Reviewer (not the author) | | | |
| Owner | | | |
