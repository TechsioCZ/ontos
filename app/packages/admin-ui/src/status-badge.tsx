import { Badge } from '@techsio/ui-kit/atoms/badge';
import { statusPresentation } from './status-presentation.ts';
import type { StatusKind } from './status-presentation.ts';

export interface StatusBadgeProps {
  kind: StatusKind;
  value: string;
}

/** Domain status chip. The label and variant come from the shared status map. */
export const StatusBadge = ({ kind, value }: StatusBadgeProps) => {
  const { label, variant } = statusPresentation(kind, value);
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
};
