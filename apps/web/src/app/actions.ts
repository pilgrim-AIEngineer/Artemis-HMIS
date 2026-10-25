'use server';

import { LOCALE_COOKIE, isLocale } from '@hmis/shared';
import { cookies } from 'next/headers';
import { z } from 'zod';

const setLocaleInput = z.string().refine(isLocale);

/** Login-screen language choice (signed-in users go through `auth.setLanguage`). */
export async function setLocale(locale: string) {
  const parsed = setLocaleInput.parse(locale);
  const store = await cookies();
  store.set(LOCALE_COOKIE, parsed, {
    path: '/',
    sameSite: 'lax',
    secure: true,
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365,
  });
}
