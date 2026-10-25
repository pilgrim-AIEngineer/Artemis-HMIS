'use client';

import { useEffect } from 'react';
import { PRINT_DONE_MESSAGE } from './print-frame';

/**
 * Lives inside the hidden print frame: waits for the bundled fonts, opens the print dialog and
 * tells the parent page when it closes so the frame can be removed.
 */
export function AutoPrint() {
  useEffect(() => {
    const done = () => window.parent.postMessage(PRINT_DONE_MESSAGE, window.location.origin);
    window.addEventListener('afterprint', done);
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('afterprint', done);
    };
  }, []);
  return null;
}
