'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

/** "Skip to main content" for keyboard users: first Tab stop on every signed-in page. */
export function SkipLink() {
  const t = useTranslations('nav');
  return (
    <a
      href="#main"
      className="sr-only rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 print:hidden"
    >
      {t('skipToContent')}
    </a>
  );
}

/**
 * Moves focus to the page's main area after each in-app navigation, so keyboard and screen-reader
 * users start at the new page instead of at the old link (docs/05 §5). The first load is left alone
 * (the page's own `autoFocus` field, e.g. the search box, wins).
 */
export function MainArea({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLElement | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: false });
  }, [pathname]);
  return (
    <main
      id="main"
      ref={ref}
      tabIndex={-1}
      className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none print:max-w-none print:p-0"
    >
      {children}
    </main>
  );
}
