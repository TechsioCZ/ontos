import { Button } from '@techsio/ui-kit/atoms/button';
import type { DetailViewMode } from './detail-view-mode.ts';

export interface DetailViewModeToggleProps {
  readonly groupLabel: string;
  readonly onChange: (next: DetailViewMode) => void;
  readonly pageLabel: string;
  readonly panelLabel: string;
  readonly value: DetailViewMode;
}

/** Two-way switch between the full-page and side-panel detail views of a list page. */
export const DetailViewModeToggle = ({
  groupLabel,
  onChange,
  pageLabel,
  panelLabel,
  value,
}: DetailViewModeToggleProps) => {
  const option = (mode: DetailViewMode, label: string) => {
    const active = value === mode;
    return (
      <Button
        aria-pressed={active}
        onClick={() => {
          if (!active) {
            onChange(mode);
          }
        }}
        size="sm"
        theme="outlined"
        variant={active ? 'primary' : 'secondary'}
      >
        {label}
      </Button>
    );
  };

  return (
    // A fieldset is the semantic group; its browser frame is reset so it lays out as a plain button row.
    <fieldset aria-label={groupLabel} className="m-0 inline-flex min-w-0 gap-100 border-0 p-0">
      {option('page', pageLabel)}
      {option('panel', panelLabel)}
    </fieldset>
  );
};
