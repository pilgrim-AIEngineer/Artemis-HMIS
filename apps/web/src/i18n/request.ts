import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@hmis/shared';
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

// Per-user language comes with auth (FND-02/06); until then the cookie decides.
export default getRequestConfig(async () => {
  const store = await cookies();
  const fromCookie = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(fromCookie) ? fromCookie : DEFAULT_LOCALE;
  const messages = (await import(`../../messages/${locale}.json`)) as { default: object };
  return { locale, messages: messages.default, timeZone: 'Asia/Kolkata' };
});
