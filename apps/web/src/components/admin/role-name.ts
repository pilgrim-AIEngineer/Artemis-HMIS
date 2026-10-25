/** Role display name in the UI language (Hindi name falls back to English). */
export const roleName = (r: { name: string; nameHi: string | null }, locale: string) =>
  locale === 'hi' && r.nameHi ? r.nameHi : r.name;
