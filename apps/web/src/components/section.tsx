import { useId, type ReactNode } from 'react';

/** Titled card used by the admin forms. */
export function Section({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-lg border bg-card p-5">
      <div className="space-y-1">
        <h2 id={id} className="text-xl font-semibold">
          {title}
        </h2>
        {help && <p className="text-muted-foreground">{help}</p>}
      </div>
      {children}
    </section>
  );
}
