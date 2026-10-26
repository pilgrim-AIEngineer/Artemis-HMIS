/** Cookie and header names shared by the server, the proxy and the browser (FND-02). */

/** HttpOnly session token (hash stored in `session.token_hash`). */
export const SESSION_COOKIE = '__Host-hmis_session';
/** HttpOnly workstation pairing cookie: `<workstation id>.<secret>` (docs/01 §5). */
export const WORKSTATION_COOKIE = 'hmis_ws';
/** Double-submit CSRF token: readable by the page, echoed in `CSRF_HEADER` on every mutation. */
export const CSRF_COOKIE = 'hmis_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Error message keys the client reacts to (beyond showing the text). */
export const AUTH_ERRORS = {
  required: 'errors.auth.required',
  locked: 'errors.auth.locked',
  mfaRequired: 'errors.auth.mfaRequired',
  passwordChangeRequired: 'errors.auth.passwordChangeRequired',
  forbidden: 'errors.auth.forbidden',
} as const;
