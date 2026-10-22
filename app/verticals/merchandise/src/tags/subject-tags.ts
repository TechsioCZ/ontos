import { subjectsWithTag } from '@app/tagging/clients/records';
import { runTagEffect, useTagsFor } from '@app/tagging/components/tag-controls';
import type { TagsStatus } from '@app/tagging/components/tag-controls';
import { SubjectIdSchema } from '@app/tagging/contracts/records';
import type { SubjectId, SubjectKind, Tag, TagId } from '@app/tagging/contracts/records';
import { Schema } from 'effect';
import { useEffect, useState } from 'react';

const isSubjectId = Schema.is(SubjectIdSchema);

/**
 * Brands merchandise row ids as tagging subject ids. Ids that do not fit the tagging rules are left out:
 * they cannot carry a tag, so they read as untagged rather than breaking the table.
 */
export const toSubjectIds = (ids: readonly string[]): readonly SubjectId[] => ids.filter(isSubjectId);

export interface SubjectTagFilter {
  /**
   * Ids of the subjects carrying the selected tag, for the server-side list filter. `null` while no tag is selected
   * or its subjects are still loading (`status` tells which) or failed.
   */
  readonly ids: readonly string[] | null;
  /** Reads the tag's subjects again (after a tag assignment changed them). */
  readonly refetch: () => void;
  readonly setTagId: (tagId: TagId | null) => void;
  readonly status: 'idle' | TagsStatus;
  readonly tagId: TagId | null;
}

interface TaggedRead {
  readonly ids: readonly string[] | null;
  /** The request this answer belongs to; an answer for an older request never lands. */
  readonly request: object;
  readonly status: TagsStatus;
}

/**
 * Single-tag filter of a server-paged list: the selected tag's subject ids (one tagging read) go into the list
 * query, so the filter covers every page and the total counts only tagged rows.
 */
export const useSubjectTagFilter = (kind: SubjectKind): SubjectTagFilter => {
  const [tagId, setTagId] = useState<TagId | null>(null);
  // A new object starts a new read, so a refetch re-runs the effect for the same tag.
  const [request, setRequest] = useState<object>({});
  const [read, setRead] = useState<TaggedRead | null>(null);
  useEffect(() => {
    let active = tagId !== null;
    if (tagId !== null) {
      runTagEffect(subjectsWithTag(kind, tagId), {
        onFailure: () => {
          if (active) {
            setRead({ ids: null, request, status: 'error' });
          }
        },
        onSuccess: (ids) => {
          if (active) {
            setRead({ ids, request, status: 'ready' });
          }
        },
      });
    }
    return () => {
      active = false;
    };
  }, [kind, request, tagId]);
  const current = read?.request === request ? read : null;
  return {
    // While a newer read is pending the last ids stay, so the list query does not change (and read) twice.
    ids: tagId === null ? null : (read?.ids ?? null),
    refetch: () => setRequest({}),
    setTagId: (next) => {
      setTagId(next);
      setRequest({});
      if (next === null) {
        setRead(null);
      }
    },
    status: tagId === null ? 'idle' : (current?.status ?? 'loading'),
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
