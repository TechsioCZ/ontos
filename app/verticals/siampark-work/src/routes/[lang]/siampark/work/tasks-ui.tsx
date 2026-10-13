// Local stand-ins with the same class contract as @app/admin-ui (PageHeader, StatCard, StatRow,
// BulkActionBar, EmptyState). Replace with the package imports once the vertical depends on @app/admin-ui.
import { Button } from '@techsio/ui-kit/atoms/button';
import type { ReactNode } from 'react';

export const PageHeader = ({ actions, title }: { actions?: ReactNode; title: string }) => (
  <header className="flex flex-wrap items-center justify-between gap-200">
    <h1 className="font-semibold text-xl">{title}</h1>
    {actions !== undefined && actions !== false && <div className="flex flex-wrap items-center gap-100">{actions}</div>}
  </header>
);

export const StatCard = ({ label, value }: { label: string; value: string }) => (
  <div className="flex min-w-0 flex-col gap-100 rounded-lg border border-border-primary bg-surface p-200">
    <span className="text-fg-secondary text-sm">{label}</span>
    <span className="font-semibold text-xl tabular-nums">{value}</span>
  </div>
);

export const StatRow = ({ children }: { children?: ReactNode }) => (
  <div className="grid grid-cols-2 gap-200 xl:grid-cols-4">{children}</div>
);

export const EmptyState = ({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description?: string;
  title: string;
}) => (
  <div className="flex flex-col items-center gap-150 p-450 text-center">
    <div className="flex flex-col gap-50">
      <p className="font-semibold text-md">{title}</p>
      {description !== undefined && <p className="max-w-prose text-fg-secondary text-sm">{description}</p>}
    </div>
    {action}
  </div>
);

export const BulkActionBar = ({
  children,
  clearLabel,
  onClear,
  selectedCount,
  selectedLabel,
}: {
  children?: ReactNode;
  clearLabel: string;
  onClear: () => void;
  selectedCount: number;
  selectedLabel: string;
}) => {
  if (selectedCount === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-150 rounded-md border border-border-primary bg-overlay p-150">
      <span className="font-medium text-sm tabular-nums">{selectedLabel}</span>
      <div className="flex flex-wrap items-center gap-100">{children}</div>
      <Button className="ms-auto" onClick={onClear} size="sm" theme="borderless" variant="secondary">
        {clearLabel}
      </Button>
    </div>
  );
};
