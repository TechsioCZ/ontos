import type { ReactNode } from 'react';
import { isPresent } from './present.ts';

export interface PageHeaderProps {
  actions?: ReactNode;
  /** Breadcrumb trail rendered above the title, e.g. a ui-kit `BreadcrumbTemplate`. */
  breadcrumbs?: ReactNode;
  description?: ReactNode;
  /** Status badges rendered beside the title. */
  meta?: ReactNode;
  title: string;
}

/** One header per page: where you are, what this is, what you can do. Primary action last. */
export const PageHeader = ({ actions, breadcrumbs, description, meta, title }: PageHeaderProps) => (
  <header className="flex flex-col gap-150">
    {breadcrumbs}
    <div className="flex flex-wrap items-start justify-between gap-200">
      <div className="flex min-w-0 flex-col gap-100">
        <div className="flex flex-wrap items-center gap-150">
          <h1 className="font-semibold text-xl">{title}</h1>
          {meta}
        </div>
        {isPresent(description) && <p className="max-w-prose text-fg-secondary text-sm">{description}</p>}
      </div>
      {isPresent(actions) && <div className="flex flex-wrap items-center gap-100">{actions}</div>}
    </div>
  </header>
);
