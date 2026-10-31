import type { ReactNode } from 'react';

export interface StatRowProps {
  children?: ReactNode;
}

/** Responsive KPI grid: one column on phones, two from `sm`, four from `xl`. */
export const StatRow = ({ children }: StatRowProps) => (
  <div className="grid grid-cols-1 gap-200 sm:grid-cols-2 xl:grid-cols-4">{children}</div>
);
