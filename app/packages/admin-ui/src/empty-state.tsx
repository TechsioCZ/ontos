import type { ReactNode } from 'react';
import { isPresent } from './present.ts';

export interface EmptyStateProps {
  /** One next step, e.g. a create button. */
  action?: ReactNode;
  description?: ReactNode;
  title: string;
}

/** Says what is missing and offers the one useful next step. */
export const EmptyState = ({ action, description, title }: EmptyStateProps) => (
  <div className="flex flex-col items-center gap-150 p-450 text-center">
    <div className="flex flex-col gap-50">
      <p className="font-semibold text-md">{title}</p>
      {isPresent(description) && <div className="max-w-prose text-fg-secondary text-sm">{description}</div>}
    </div>
    {action}
  </div>
);
