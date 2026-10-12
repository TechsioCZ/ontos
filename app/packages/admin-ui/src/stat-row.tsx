import type { ReactNode } from 'react';

export interface StatRowProps {
  children?: ReactNode;
}

/** Responsive KPI grid: two columns on small screens, four from `xl`. */
export const StatRow = ({ children }: StatRowProps) => (
  <div className="grid grid-cols-2 gap-200 xl:grid-cols-4">{children}</div>
);
