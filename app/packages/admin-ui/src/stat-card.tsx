import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Schema } from 'effect';

const statTrendSchema = Schema.Literals(['up', 'down', 'flat']);
export type StatTrend = typeof statTrendSchema.Type;

export interface StatCardProps {
  delta?: { trend: StatTrend; value: string };
  hint?: string;
  label: string;
  /** Already formatted, e.g. with `formatMoney`. */
  value: string;
}

const trendVariant = {
  down: 'danger',
  flat: 'outline',
  up: 'success',
} as const;

/** KPI tile: label, dominant value, optional trend badge. No icons. */
export const StatCard = ({ delta, hint, label, value }: StatCardProps) => (
  <div className="flex min-w-0 flex-col gap-100 rounded-lg border border-border-primary bg-surface p-200">
    <span className="text-fg-secondary text-sm">{label}</span>
    <div className="flex flex-wrap items-baseline gap-150">
      <span className="font-semibold text-xl tabular-nums">{value}</span>
      {delta !== undefined && (
        <Badge size="sm" variant={trendVariant[delta.trend]}>
          {delta.value}
        </Badge>
      )}
    </div>
    {hint !== undefined && <span className="text-fg-secondary text-xs">{hint}</span>}
  </div>
);
