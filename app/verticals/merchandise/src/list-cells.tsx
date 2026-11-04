import { TagBadge } from '@app/admin-ui';
import { tagColorValue } from '@app/tagging/components/tag-controls';
import type { Tag } from '@app/tagging/contracts/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';

/** Two tag chips, then `+N`. Keeps the Štítky column narrow. */
export const TagsCell = ({ tags }: { tags: readonly Tag[] }) => {
  const visible = tags.slice(0, 2);
  const hiddenCount = tags.length - visible.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-50">
      {visible.map((tag) => (
        <TagBadge color={tagColorValue[tag.color]} key={tag.id} name={tag.name} />
      ))}
      {hiddenCount > 0 && <Badge size="sm" variant="outline">{`+${hiddenCount}`}</Badge>}
    </span>
  );
};
