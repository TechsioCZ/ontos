import { TagChip } from '@app/tagging/components/tag-controls';
import type { Tag } from '@app/tagging/contracts/records';
import type { ReactNode } from 'react';
import { Badge } from '@techsio/ui-kit/atoms/badge';

/** Two tag chips, then `+N`. Keeps the Štítky column narrow. `lead` sits first; `maxChips` caps the chips. */
export const TagsCell = ({
  lead,
  maxChips = 2,
  tags,
}: {
  lead?: ReactNode;
  maxChips?: number;
  tags: readonly Tag[];
}) => {
  const visible = tags.slice(0, maxChips);
  const hiddenCount = tags.length - visible.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-50">
      {lead}
      {visible.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {hiddenCount > 0 && <Badge appearance="outline" severity="neutral" size="sm">{`+${hiddenCount}`}</Badge>}
    </span>
  );
};
