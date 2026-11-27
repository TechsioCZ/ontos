import { Badge } from '@techsio/ui-kit/atoms/badge';

export interface TagBadgeProps {
  /** The tag's stored colour, shown as a small dot. Any CSS colour value. */
  color?: string;
  name: string;
}

/** Tag chip. Tags are not statuses, so they never take a status variant. */
export const TagBadge = ({ color, name }: TagBadgeProps) => (
  <span className="inline-flex min-w-0 items-center gap-50">
    {color !== undefined && (
      <span aria-hidden className="size-100 shrink-0 rounded-full" style={{ backgroundColor: color }} />
    )}
    <Badge size="sm" variant="outline">
      {name}
    </Badge>
  </span>
);
