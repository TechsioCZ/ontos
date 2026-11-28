import { Badge } from '@techsio/ui-kit/atoms/badge';

export interface TagBadgeProps {
  /** The tag's stored colour as a kit tag colour class (`bg-tag-blue` …), shown as a small dot. */
  colorClass?: string;
  name: string;
}

/** Tag chip. Tags are not statuses, so they never take a status variant. */
export const TagBadge = ({ colorClass, name }: TagBadgeProps) => (
  <span className="inline-flex min-w-0 items-center gap-50">
    {colorClass !== undefined && <span aria-hidden className={`size-100 shrink-0 rounded-full ${colorClass}`} />}
    <Badge appearance="outline" severity="neutral" size="sm">
      {name}
    </Badge>
  </span>
);
