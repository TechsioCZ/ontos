import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Schema } from 'effect';
import type { ReactNode } from 'react';
import { surfaceTileClassName } from './ui-kit-classes.ts';

const statTrendSchema = Schema.Literals(['up', 'down', 'flat']);
export type StatTrend = typeof statTrendSchema.Type;

export interface StatCardProps {
  /** A quiet follow-up inside the tile, e.g. a borderless link to the records behind the number. */
  action?: ReactNode;
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

/** KPI tile: label, dominant value, optional trend badge. Tinted, never outlined; white inside a tinted tile. No icons. */
export const StatCard = ({ action, delta, hint, label, value }: StatCardProps) => (
  <div className={`${surfaceTileClassName} flex min-w-0 flex-col gap-100 p-200`}>
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
    {action !== undefined && <div className="mt-auto flex pt-50">{action}</div>}
  </div>
);
