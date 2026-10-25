import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';

/**
 * The masters screens build many keys from data (`enums.<group>.<value>`, `kinds.<kind>.title`),
 * which the typed message keys cannot express (the union is too large for TypeScript). Static
 * keys elsewhere stay typed; `test/masters-messages.test.ts` proves every key built here exists
 * in both languages.
 */
export type LooseT = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

export const useMastersT = (): LooseT => useTranslations('admin.masters') as unknown as LooseT;

export async function getMastersT(): Promise<LooseT> {
  return (await getTranslations('admin.masters')) as unknown as LooseT;
}
