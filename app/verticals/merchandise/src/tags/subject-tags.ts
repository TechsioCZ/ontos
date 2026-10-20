import { useTagsFor } from '@app/tagging/components/tag-controls';
import type { TagsStatus } from '@app/tagging/components/tag-controls';
import { SubjectIdSchema } from '@app/tagging/contracts/records';
import type { SubjectId, SubjectKind, Tag, TagId } from '@app/tagging/contracts/records';
import { Schema } from 'effect';
import { useState } from 'react';

const isSubjectId = Schema.is(SubjectIdSchema);

/**
 * Brands merchandise row ids as tagging subject ids. Ids that do not fit the tagging rules are left out:
 * they cannot carry a tag, so they read as untagged rather than breaking the table.
 */
export const toSubjectIds = (ids: readonly string[]): readonly SubjectId[] => ids.filter(isSubjectId);

export interface SubjectTagFilter {
  /** No tag selected: every row passes. While the row tags load or after they failed, no row passes. */
  readonly matches: (id: string) => boolean;
  readonly setTagId: (tagId: TagId | null) => void;
  readonly status: 'idle' | TagsStatus;
  readonly tagId: TagId | null;
}

/**
 * Single-tag filter over the rows on screen. It reads the same tag data as the "Štítky" column, so the
 * filtered rows and the tags shown never disagree, and a refetch of the row tags refreshes the filter too.
 */
export const useSubjectTagFilter = (rowTags: SubjectTags): SubjectTagFilter => {
  const [tagId, setTagId] = useState<TagId | null>(null);
  return {
    matches: (id) =>
      tagId === null || (rowTags.status === 'ready' && rowTags.tagsOf(id).some((tag) => tag.id === tagId)),
    setTagId,
    status: tagId === null ? 'idle' : rowTags.status,
    tagId,
  };
};

export interface SubjectTags {
  readonly canWrite: boolean;
  readonly refetch: () => void;
  readonly status: TagsStatus;
  readonly tagsOf: (id: string) => readonly Tag[];
}

/** Tags of the rows on screen. `tagsOf` returns no tags for a row that has none or whose lookup failed. */
export const useSubjectTags = (kind: SubjectKind, ids: readonly string[]): SubjectTags => {
  const { canWrite, refetch, status, tagsBySubject } = useTagsFor(kind, toSubjectIds(ids));
  const byId = new Map<string, readonly Tag[]>(tagsBySubject);
  return {
    canWrite: ids.length > 0 && canWrite === true,
    refetch,
    status,
    tagsOf: (id: string): readonly Tag[] => byId.get(id) ?? [],
  };
};
