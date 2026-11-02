// The tag editor's form values: what the create dialog sends once and the edit panel autosaves.
import type { RevisionedSaveResult } from '@app/admin-ui';
import { Effect, Predicate, Schema } from 'effect';
import type { TaggingCommand } from '../../../../../shared/actions/apply-command.ts';
import { subjectKindValues } from '../../../../../shared/apis/records.ts';
import type { RecordsResponse, SubjectKind, Tag, TagColor, TagId } from '../../../../../shared/apis/records.ts';

export interface TagDraft {
  readonly color: TagColor;
  readonly description: string;
  readonly kinds: readonly SubjectKind[];
  readonly name: string;
}

export const nameMaxLength = 60;

/** The kinds in the canonical order. */
const canonicalKinds = (kinds: readonly SubjectKind[]) => {
  const selected = new Set(kinds);
  return subjectKindValues.filter((kind) => selected.has(kind));
};

/** The form values a tag starts from; a new tag starts blue with nothing else filled in. */
export const tagDraftOf = (tag: Tag | null): TagDraft => ({
  color: tag?.color ?? 'blue',
  description: tag?.description ?? '',
  kinds: canonicalKinds(tag?.subjectKinds ?? []),
  name: tag?.name ?? '',
});

/** Drafts that differ only in surrounding spaces or kind order store the same tag. */
export const sameTagDraft = (left: TagDraft, right: TagDraft): boolean =>
  left.name.trim() === right.name.trim() &&
  left.color === right.color &&
  left.description.trim() === right.description.trim() &&
  canonicalKinds(left.kinds).join(',') === canonicalKinds(right.kinds).join(',');

export const TagNameProblemSchema = Schema.Literals(['required', 'tooLong']);
export type TagNameProblem = typeof TagNameProblemSchema.Type;

export const tagNameProblem = (draft: TagDraft): TagNameProblem | null => {
  const name = draft.name.trim();
  if (name === '') {
    return 'required';
  }
  return name.length > nameMaxLength ? 'tooLong' : null;
};

/** A tag needs a name of at most 60 characters and at least one kind; anything else is never sent. */
export const validTagDraft = (draft: TagDraft): boolean => tagNameProblem(draft) === null && draft.kinds.length > 0;

/** The stored fields of a draft. */
export const tagFieldsOf = (draft: TagDraft) => ({
  color: draft.color,
  // An empty description clears the stored one.
  description: draft.description.trim(),
  name: draft.name.trim(),
  subjectKinds: [...canonicalKinds(draft.kinds)],
});

export const createTagCommand = (draft: TagDraft): TaggingCommand => ({ _tag: 'CreateTag', ...tagFieldsOf(draft) });

export const updateTagCommand = (id: TagId, draft: TagDraft): TaggingCommand => ({
  _tag: 'UpdateTag',
  id,
  patch: tagFieldsOf(draft),
});

/**
 * Whether the owner still has the tag as the draft's base version. Someone else's change of this tag means the
 * draft would overwrite it; changes of other tags do not matter.
 */
export const tagUnchangedSince =
  (id: TagId, base: TagDraft) =>
  (current: RecordsResponse): boolean => {
    const tag = current.tags.find((candidate) => candidate.id === id);
    return tag !== undefined && sameTagDraft(tagDraftOf(tag), base);
  };

/** An autosave of the edit panel: a changed tag or a revision race is a conflict, any other failure `failed`. */
export const tagAutosaveResult = <E>(
  write: Effect.Effect<'applied' | 'stale', E>,
): Effect.Effect<RevisionedSaveResult> =>
  write.pipe(
    Effect.match({
      onFailure: (error): RevisionedSaveResult =>
        Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') ? 'conflict' : 'failed',
      onSuccess: (applied): RevisionedSaveResult => (applied === 'applied' ? 'saved' : 'conflict'),
    }),
  );
