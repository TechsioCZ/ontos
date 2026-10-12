import type { ReactNode } from 'react';
import { isPresent } from './present.ts';

export interface SectionCardProps {
  actions?: ReactNode;
  children?: ReactNode;
  /** Drops the card padding when the child draws its own edges, such as a static table. */
  flush?: boolean;
  title?: ReactNode;
}

/** A titled content block with optional local actions. Never wrap a DataTable in it. */
export const SectionCard = ({ actions, children, flush = false, title }: SectionCardProps) => {
  const hasHeader = isPresent(title) || isPresent(actions);
  const padding = flush ? '' : 'p-250';
  const headerInset = flush ? 'px-250 pt-250' : '';

  return (
    <section className={`flex flex-col gap-200 rounded-lg border border-border-primary bg-surface ${padding}`}>
      {hasHeader && (
        <div className={`flex flex-wrap items-start justify-between gap-150 ${headerInset}`}>
          {isPresent(title) && <h2 className="font-semibold text-md">{title}</h2>}
          {isPresent(actions) && <div className="flex flex-wrap items-center gap-100">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
};
