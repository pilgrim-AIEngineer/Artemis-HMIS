/** Posted by the print page inside the hidden frame when the print dialog is closed. */
export const PRINT_DONE_MESSAGE = 'hmis:print-done';

let active: HTMLIFrameElement | null = null;

export function removePrintFrame(): void {
  active?.remove();
  active = null;
}

/**
 * Loads `src` (a `/print/...?copy=n&embed=1` page) in a hidden same-origin iframe, whose page
 * opens the print dialog by itself. At most one frame exists; it is removed when the page reports
 * the dialog closed, or after two minutes if it never does.
 */
export function openPrintFrame(src: string, title: string): void {
  removePrintFrame();
  const f = document.createElement('iframe');
  f.title = title;
  f.setAttribute('aria-hidden', 'true');
  f.tabIndex = -1;
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  f.src = src;
  document.body.appendChild(f);
  active = f;
  window.setTimeout(() => {
    if (active === f) removePrintFrame();
  }, 120_000);
}

/** Listens for the frame's "done" message; returns the unsubscribe function. */
export function onPrintDone(): () => void {
  const handler = (e: MessageEvent) => {
    if (e.origin === window.location.origin && e.data === PRINT_DONE_MESSAGE) removePrintFrame();
  };
  window.addEventListener('message', handler);
  return () => {
    window.removeEventListener('message', handler);
    removePrintFrame();
  };
}
