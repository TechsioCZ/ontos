import { committedResult, pendingProposalMessage } from '../../../../api/action-result.ts';
// The editable fields of a storefront category: how a draft of them is compared, validated and turned into a patch,
// and how one draft is saved (autosave of an existing category).
import { DateTime, Effect, Match, Option, Random } from 'effect';
import { executeManageCatalog } from '../../../../api/manage-catalog-action-client.ts';
import type { CategoryPatch, MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { CategoryNode } from '../../../../../shared/domain/merchandise-model.ts';
import type { RevisionedSaveResult } from '@app/admin-ui';

export interface CategoryDraft {
  readonly description: string;
  readonly heading: string;
  readonly longDescription: string;
  readonly name: string;
  readonly positionText: string;
  readonly published: boolean;
}

export interface CategoryDraftErrors {
  name?: 'required' | 'tooLong';
  position?: 'negative' | 'notWhole' | 'required';
}

export const NAME_LIMIT = 200;

/** The draft of an existing category, read from the register. */
export const draftOf = (category: CategoryNode): CategoryDraft => ({
  description: category.description ?? '',
  heading: category.heading ?? '',
  longDescription: category.longDescription ?? '',
  name: category.name,
  positionText: String(category.position),
  published: category.published !== false,
});

/** The storefront order the draft asks for; None while the entered position is not a whole number ≥ 0. */
export const positionOf = (draft: CategoryDraft): Option.Option<number> => {
  const text = draft.positionText.trim();
  if (text === '') {
    return Option.none();
  }
  const position = Number(text);
  return Number.isInteger(position) && position >= 0 ? Option.some(position) : Option.none();
};

export const categoryDraftErrors = (draft: CategoryDraft): CategoryDraftErrors => {
  const name = draft.name.trim();
  const errors: CategoryDraftErrors = {};
  if (name === '') {
    errors.name = 'required';
  } else if (name.length > NAME_LIMIT) {
    errors.name = 'tooLong';
  }
  const text = draft.positionText.trim();
  const position = Number(text);
  if (text === '') {
    errors.position = 'required';
  } else if (!Number.isInteger(position)) {
    errors.position = 'notWhole';
  } else if (position < 0) {
    errors.position = 'negative';
  }
  return errors;
};

const samePosition = (left: CategoryDraft, right: CategoryDraft): boolean =>
  left.positionText.trim() === right.positionText.trim() ||
  Option.getOrNull(positionOf(left)) === Option.getOrNull(positionOf(right));

/** Two drafts that would be saved the same: surrounding spaces and `05` for `5` do not count. */
export const sameCategoryDraft = (left: CategoryDraft, right: CategoryDraft): boolean =>
  left.description.trim() === right.description.trim() &&
  left.heading.trim() === right.heading.trim() &&
  left.longDescription.trim() === right.longDescription.trim() &&
  left.name.trim() === right.name.trim() &&
  samePosition(left, right) &&
  left.published === right.published;

/** Only the fields that differ; the server trims every text, so an emptied field clears it. */
export const categoryPatchOf = (draft: CategoryDraft, category: CategoryNode): CategoryPatch => {
  const patch: { -readonly [Key in keyof CategoryPatch]: CategoryPatch[Key] } = {};
  const text = (key: 'description' | 'heading' | 'longDescription', limit: number) => {
    const value = draft[key].trim().slice(0, limit);
    if (value !== (category[key] ?? '')) {
      patch[key] = value;
    }
  };
  const name = draft.name.trim();
  if (name !== category.name) {
    patch.name = name;
  }
  text('heading', 300);
  text('description', 5000);
  text('longDescription', 50_000);
  const position = positionOf(draft);
  if (Option.isSome(position) && position.value !== category.position) {
    patch.position = position.value;
  }
  if (draft.published !== (category.published !== false)) {
    patch.published = draft.published;
  }
  return patch;
};

const idempotencyKey = Effect.all({ now: DateTime.now, random: Random.nextInt }, { concurrency: 1 }).pipe(
  Effect.map(({ now, random }) => `merchandise:category:${DateTime.toEpochMillis(now)}:${random}`),
);

/** One category update; the outcome tells autosave whether to retry, offer the current version or keep the draft. */
export const saveCategory = (
  command: Extract<MerchandiseCommand, { readonly _tag: 'UpdateCategory' }>,
  expectedRevision: number,
  pending?: (message: string | null) => void,
): Effect.Effect<RevisionedSaveResult> =>
  idempotencyKey.pipe(
    Effect.flatMap((key) => executeManageCatalog({ command, expectedRevision }, key, { idempotencyKey: key })),
    Effect.flatMap(committedResult),
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.sync(() => pending?.(pendingProposalMessage(error) ?? null)).pipe(Effect.andThen(Effect.fail(error))),
      onSuccess: Effect.succeed,
    }),
    Effect.match({
      onFailure: (error): RevisionedSaveResult =>
        Match.value(error).pipe(
          Match.tag('ManageCatalogActionConflictProblem', (problem): RevisionedSaveResult =>
            problem.code === 'merchandise_lifecycle_conflict' ? 'failed' : 'conflict',
          ),
          Match.orElse((): RevisionedSaveResult => 'failed'),
        ),
      onSuccess: ({ revision }): RevisionedSaveResult => revision,
    }),
  );

/** Save of an existing category: unchanged drafts are no request at all. */
export const autosaveCategoryEdit = (
  draft: CategoryDraft,
  category: CategoryNode,
  expectedRevision: number,
  pending?: (message: string | null) => void,
): Effect.Effect<RevisionedSaveResult> => {
  const patch = categoryPatchOf(draft, category);
  if (Object.keys(patch).length === 0) {
    return Effect.succeed('saved');
  }
  return saveCategory({ _tag: 'UpdateCategory', id: category.id, patch }, expectedRevision, pending);
};

/** The saved category as the register has it now, so the next save builds on the revision the server confirmed. */
export const savedCategory = (category: CategoryNode, draft: CategoryDraft): CategoryNode => ({
  ...category,
  ...categoryPatchOf(draft, category),
});
