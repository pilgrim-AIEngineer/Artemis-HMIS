import { facilityForDisplayKey } from '@hmis/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTranslator } from 'next-intl';
import { QueueDisplay, type DisplayLabels } from '@/components/display/queue-display';
import { getDb } from '@/server/db';
import en from '../../../../messages/en.json';
import hi from '../../../../messages/hi.json';

export const dynamic = 'force-dynamic';

// The key is in this page's URL (docs/01 §2): never send it on as a referrer, never index it.
export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

const KEYS = [
  'title',
  'now',
  'next',
  'waiting',
  'nobody',
  'idle',
  'reconnecting',
  'enableSound',
  'invalid',
] as const;

/** Both languages at once: the TV is read by everyone in the hall (docs/05 §6). */
function labels(): DisplayLabels {
  const out = {} as Record<(typeof KEYS)[number], { en: string; hi: string }>;
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'display' });
  const tHi = createTranslator({ locale: 'hi', messages: hi, namespace: 'display' });
  for (const k of KEYS) out[k] = { en: tEn(k), hi: tHi(k) };
  return { ...out, announceHi: hi.display.announce };
}

/**
 * `/display/queue?key=…` (REG-05): full-screen token board for the waiting-hall TV. The page is a
 * shell; the key is checked here and again by every poll of `/api/display/queue`.
 */
export default async function QueueDisplayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { key } = await searchParams;
  if (typeof key !== 'string' || !(await facilityForDisplayKey(getDb(), key))) notFound();
  return <QueueDisplay displayKey={key} labels={labels()} />;
}
