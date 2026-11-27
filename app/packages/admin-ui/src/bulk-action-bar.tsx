import { Button } from '@techsio/ui-kit/atoms/button';
import type { ReactNode } from 'react';

export interface BulkActionBarProps {
  /** Actions applied to the selection. Primary first, destructive last. */
  children?: ReactNode;
  onClear: () => void;
  selectedCount: number;
}

/** Appears above a table only while rows are selected. Renders nothing at zero. */
export const BulkActionBar = ({ children, onClear, selectedCount }: BulkActionBarProps) => {
  if (selectedCount === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-150 rounded-lg bg-overlay p-150">
      <span className="font-medium text-sm tabular-nums">{`Vybráno: ${selectedCount}`}</span>
      <div className="flex flex-wrap items-center gap-100">{children}</div>
      <Button className="ms-auto" onClick={onClear} size="sm" theme="borderless" variant="secondary">
        Zrušit výběr
      </Button>
    </div>
  );
};
