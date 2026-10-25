/** Small key label shown on a button (`F2 New patient`, `Esc Back`: docs/05 §1.11). */
export function ShortcutHint({ keys }: { keys: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="ml-1 rounded border border-current/40 px-1.5 py-0.5 font-sans text-xs font-medium opacity-80"
    >
      {keys}
    </kbd>
  );
}
