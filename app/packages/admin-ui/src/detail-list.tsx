import type { ReactNode } from 'react';

export interface DetailListItem {
  label: string;
  value: ReactNode;
}

export interface DetailListProps {
  items: DetailListItem[];
}

/** Read-only label/value grid for detail pages and quick-view drawers. Two columns from `sm`. */
export const DetailList = ({ items }: DetailListProps) => (
  <dl className="grid grid-cols-1 gap-150 sm:grid-cols-2">
    {items.map((item) => (
      <div className="flex min-w-0 flex-col gap-50" key={item.label}>
        <dt className="text-fg-secondary text-xs">{item.label}</dt>
        <dd className="break-words text-sm">{item.value}</dd>
      </div>
    ))}
  </dl>
);
