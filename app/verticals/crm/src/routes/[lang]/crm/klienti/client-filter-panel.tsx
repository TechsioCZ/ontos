// Approved counted filters, composed from the existing admin-ui panel and design tokens.
import { SectionCard, surfaceTileClassName } from '@app/admin-ui';
import type { ReactNode } from 'react';
import type { ClientEntity, ClientMetric } from './client-filters.ts';

/** One metric as the variant navigation shows it: translated label, id, and its exact formatted count. */
export interface ClientFilterShortcut {
  readonly countLabel: string;
  readonly label: string;
  readonly metricId: ClientMetric;
}

/** Metrics of one record type with the translated group heading. */
export interface ClientFilterGroup {
  readonly entity: ClientEntity;
  readonly label: string;
  readonly metrics: readonly ClientFilterShortcut[];
}

export interface ClientFilterPanelProps {
  readonly children: ReactNode;
  readonly groups: readonly ClientFilterGroup[];
  readonly label: string;
  readonly onOpenMetric: (metricId: ClientMetric) => void;
  readonly selectedMetric: ClientMetric | undefined;
}

/** The compact chip: a tinted pill, so `rounded-full` overrides the tile radius while keeping the tile tint. */
const chipClassName = `${surfaceTileClassName} inline-flex cursor-pointer items-center gap-100 rounded-full px-200 py-100 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`;

/** The one visible selected state: a primary ring around the whole chip, next to its `aria-pressed`. */
const chipActiveClassName = 'ring-2 ring-primary';

const chipCountClassName = 'font-semibold tabular-nums';

interface MetricChipProps {
  readonly active: boolean;
  readonly metric: ClientFilterShortcut;
  readonly onSelect: (metricId: ClientMetric) => void;
}

/** One counted chip. The whole chip is the click target and the only control of its metric, count included. */
const MetricChip = ({ active, metric, onSelect }: MetricChipProps) => (
  <button
    aria-pressed={active}
    className={active ? `${chipClassName} ${chipActiveClassName}` : chipClassName}
    onClick={() => onSelect(metric.metricId)}
    type="button"
  >
    <span>{metric.label}</span>
    <span className={chipCountClassName}>{metric.countLabel}</span>
  </button>
);

const ClientFilterPanel = ({ children, groups, label, onOpenMetric, selectedMetric }: ClientFilterPanelProps) => (
  <SectionCard>
    <nav aria-label={label} className="flex min-w-0 flex-col gap-150">
      {groups.map((group) => (
        <div className="flex min-w-0 flex-col gap-100" key={group.entity}>
          <h2 className="font-medium text-fg-secondary text-xs">{group.label}</h2>
          <div className="flex flex-wrap items-center gap-100">
            {group.metrics.map((metric) => (
              <MetricChip
                active={metric.metricId === selectedMetric}
                key={metric.metricId}
                metric={metric}
                onSelect={onOpenMetric}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
    <div className="min-w-0">{children}</div>
  </SectionCard>
);

export default ClientFilterPanel;
