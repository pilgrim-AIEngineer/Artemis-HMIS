'use client';

import { useEffect, useRef } from 'react';

/** `Esc`, `F2`, `Ctrl+P`: key names as shown on buttons (docs/05 §1.11). */
export type ShortcutKey = string;

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

function matches(e: KeyboardEvent, combo: ShortcutKey): boolean {
  const parts = combo.split('+');
  const key = parts.at(-1)!;
  const ctrl = parts.includes('Ctrl');
  if (ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (parts.includes('Alt') !== e.altKey) return false;
  return e.key.length === 1 ? e.key.toLowerCase() === key.toLowerCase() : e.key === key;
}

/**
 * Runs `handler` when `combo` is pressed. Shortcuts are an accelerator only (nothing requires
 * them): plain keys are ignored while typing in a field, except Esc, F-keys and Ctrl/Alt combos.
 * `preventDefault` stops the browser's own action (e.g. Ctrl+P, which must go through print logging).
 */
export function useShortcut(combo: ShortcutKey, handler: () => void, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!matches(e, combo)) return;
      const modified = combo.includes('Ctrl') || combo.includes('Alt');
      const special = combo === 'Escape' || /^F\d+$/.test(combo);
      if (isTyping(e.target) && !modified && !special) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, enabled]);
}
