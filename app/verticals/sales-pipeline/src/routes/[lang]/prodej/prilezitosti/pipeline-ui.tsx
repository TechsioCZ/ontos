// Local stand-ins for the @app/admin-ui helpers (PageHeader, StatRow, StatCard, BulkActionBar,
// EmptyState, StatusBadge). Replace with the package imports once `@app/admin-ui` resolves here.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import type { ReactNode } from 'react';
import { stageVariant } from './pipeline-model.ts';
import type { OpportunityStage } from './pipeline-model.ts';

export const PageHeader = ({
  actions,
  description,
  title,
}: {
  actions?: ReactNode | undefined;
  description?: ReactNode | undefined;
  title: string;
}) => (
  <header className="flex flex-wrap items-start justify-between gap-200">
    <div className="flex min-w-0 flex-col gap-100">
      <h1 className="font-semibold text-xl">{title}</h1>
      {description !== undefined && <p className="max-w-prose text-fg-secondary text-sm">{description}</p>}
    </div>
    {actions !== undefined && <div className="flex flex-wrap items-center gap-100">{actions}</div>}
  </header>
);

export const StatRow = ({ children }: { children: ReactNode }) => (
  <div className="grid grid-cols-2 gap-200 xl:grid-cols-4">{children}</div>
);

export const StatCard = ({ hint, label, value }: { hint?: string | undefined; label: string; value: string }) => (
  <div className="flex min-w-0 flex-col gap-100 rounded-lg border border-border-primary bg-surface p-200">
    <span className="text-fg-secondary text-sm">{label}</span>
    <span className="font-semibold text-xl tabular-nums">{value}</span>
    {hint !== undefined && <span className="text-fg-secondary text-xs">{hint}</span>}
  </div>
);

export const BulkActionBar = ({
  children,
  clearLabel,
  label,
  onClear,
  visible,
}: {
  children: ReactNode;
  clearLabel: string;
  label: string;
  onClear: () => void;
  visible: boolean;
}) => {
  if (!visible) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-150 rounded-md border border-border-primary bg-overlay p-150">
      <span className="font-medium text-sm tabular-nums">{label}</span>
      <div className="flex flex-wrap items-center gap-100">{children}</div>
      <Button className="ms-auto" onClick={onClear} size="sm" theme="borderless" variant="secondary">
        {clearLabel}
      </Button>
    </div>
  );
};

export const EmptyState = ({
  action,
  description,
  title,
}: {
  action?: ReactNode | undefined;
  description?: ReactNode | undefined;
  title: string;
}) => (
  <div className="flex flex-col items-center gap-150 p-450 text-center">
    <div className="flex flex-col gap-50">
      <p className="font-semibold text-md">{title}</p>
      {description !== undefined && <div className="max-w-prose text-fg-secondary text-sm">{description}</div>}
    </div>
    {action}
  </div>
);

export const StageBadge = ({ label, stage }: { label: string; stage: OpportunityStage }) => (
  <Badge size="sm" variant={stageVariant[stage]}>
    {label}
  </Badge>
);
