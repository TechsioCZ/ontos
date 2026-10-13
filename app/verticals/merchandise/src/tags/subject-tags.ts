import { subjectsWithTag } from '@app/tagging/clients/records';
import { runTagEffect, useTagsFor } from '@app/tagging/components/tag-controls';
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

interface FilterRequest {
  readonly tagId: TagId | null;
  /** Bumped by `refresh` to re-read the same tag after tags changed. */
  readonly token: number;
}

interface LookupState {
  readonly ids: ReadonlySet<string>;
  readonly status: 'ready' | 'error';
  readonly tagId: TagId;
}

export interface SubjectTagFilter {
  /** No tag selected: every row passes. A pending or failed lookup passes none. */
  readonly matches: (id: string) => boolean;
  readonly refresh: () => void;
  readonly setTagId: (tagId: TagId | null) => void;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly tagId: TagId | null;
}

/** Single-tag filter for a list of one subject kind. Keeps the ids that carry the selected tag. */
export const useSubjectTagFilter = (kind: SubjectKind): SubjectTagFilter => {
  const [request, setRequest] = useState<FilterRequest>({ tagId: null, token: 0 });
  const [lookup, setLookup] = useState<LookupState | null>(null);
  const { tagId } = request;

  useEffect(() => {
    let active = true;
    const selected = request.tagId;
    if (selected !== null) {
      runTagEffect(subjectsWithTag(kind, selected), {
        onFailure: () => {
          if (active) {
            setLookup({ ids: new Set(), status: 'error', tagId: selected });
          }
        },
        onSuccess: (ids) => {
          if (active) {
            setLookup({ ids: new Set<string>(ids), status: 'ready', tagId: selected });
          }
        },
      });
    }
    return () => {
      active = false;
    };
  }, [kind, request]);

  // Until the lookup for the selected tag lands, the lookup belongs to another tag and reads as loading.
  const current = lookup !== null && tagId !== null && lookup.tagId === tagId ? lookup : null;
  const status = tagId === null ? 'idle' : (current?.status ?? 'loading');

  return {
    matches: (id) => tagId === null || (current?.status === 'ready' && current.ids.has(id)),
    refresh: () => setRequest((previous) => ({ ...previous, token: previous.token + 1 })),
    setTagId: (next) => setRequest((previous) => ({ tagId: next, token: previous.token + 1 })),
    status,
    tagId,
  };
};

/** Tags of the rows on screen. `tagsOf` returns no tags for a row that has none or whose lookup failed. */
export const useSubjectTags = (kind: SubjectKind, ids: readonly string[]) => {
  const { refetch, status, tagsBySubject } = useTagsFor(kind, toSubjectIds(ids));
  const byId = new Map<string, readonly Tag[]>(tagsBySubject);
  return {
    refetch,
    status,
    tagsOf: (id: string): readonly Tag[] => byId.get(id) ?? [],
  };
};
