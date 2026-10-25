'use client';

import { TRPCClientError } from '@trpc/client';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

/**
 * Turns an error (tRPC error with an i18n key + params, or a zod/form message key) into plain
 * text in the current language (docs/05 §1.10: never show codes).
 */
export function useErrorText() {
  const t = useTranslations() as unknown as Translate;
  return useCallback(
    (err: unknown): string => {
      let key: string | undefined;
      let params: Record<string, string | number> | undefined;
      if (err instanceof TRPCClientError) {
        const data = err.data as
          | { params?: Record<string, string | number>; zodIssues?: { message: string }[] }
          | undefined;
        key = data?.zodIssues?.[0]?.message ?? err.message;
        params = data?.params;
      } else if (typeof err === 'string') {
        key = err;
      } else if (err instanceof Error) {
        key = err.message;
      }
      if (key && t.has(key)) return t(key, params);
      return t('errors.internal');
    },
    [t],
  );
}

/** Translates a validation message key from a form field error. */
export function useFieldError() {
  const text = useErrorText();
  return (message: string | undefined) => (message ? text(message) : undefined);
}
