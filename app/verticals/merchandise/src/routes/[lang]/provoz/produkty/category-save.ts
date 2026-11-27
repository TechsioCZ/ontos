import { committedResult, pendingProposalMessage } from '../../../../api/action-result.ts';
// The editable fields of a storefront category: how a draft of them is compared, validated and turned into a patch,
// and how one draft of an existing category is saved when the user clicks Uložit.
import { DateTime, Effect, Match, Option, Random } from 'effect';
import { executeManageCatalog } from '../../../../api/manage-catalog-action-client.ts';
import type { CategoryPatch, MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { CategoryNode } from '../../../../../shared/domain/merchandise-model.ts';
import { CatalogCategoryIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import type { RevisionedSaveResult } from '@app/admin-ui';

export interface CategoryDraft {
  readonly description: string;
  readonly heading: string;
  readonly imageAlt: string;
  readonly imageSrc: string;
  readonly longDescription: string;
  readonly name: string;
  /** Parent in the storefront tree; null = root. */
  readonly parent: { readonly id: string; readonly trail: string } | null;
  readonly positionText: string;
  readonly published: boolean;
  readonly slug: string;
}

export interface CategoryDraftErrors {
  name?: 'required' | 'tooLong';
  position?: 'negative' | 'notWhole' | 'required';
  slug?: 'invalid';
}

export const NAME_LIMIT = 200;

export const categorySlugValid = (slug: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug);

/** The draft of an existing category, read from the register. */
export const draftOf = (category: CategoryNode, parentTrail?: string): CategoryDraft => ({
  description: category.description ?? '',
  heading: category.heading ?? '',
  imageAlt: category.imageAlt ?? '',
  imageSrc: category.imageSrc ?? '',
  longDescription: category.longDescription ?? '',
  name: category.name,
  parent: Option.match(category.parentId, {
    onNone: () => null,
    onSome: (id) => ({ id, trail: parentTrail ?? id }),
  }),
  positionText: String(category.position),
  published: category.published !== false,
  slug: category.slug,
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
  if (!categorySlugValid(draft.slug.trim())) {
    errors.slug = 'invalid';
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
  left.imageAlt.trim() === right.imageAlt.trim() &&
  left.imageSrc.trim() === right.imageSrc.trim() &&
  left.longDescription.trim() === right.longDescription.trim() &&
  left.name.trim() === right.name.trim() &&
  samePosition(left, right) &&
  left.published === right.published &&
  left.slug.trim() === right.slug.trim() &&
  (left.parent?.id ?? null) === (right.parent?.id ?? null);

/** Only the fields that differ; the server trims every text, so an emptied field clears it. */
export const categoryPatchOf = (draft: CategoryDraft, category: CategoryNode): CategoryPatch => {
  const patch: { -readonly [Key in keyof CategoryPatch]: CategoryPatch[Key] } = {};
  const text = (key: 'description' | 'heading' | 'imageAlt' | 'imageSrc' | 'longDescription', limit: number) => {
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
  text('imageSrc', 500);
  text('imageAlt', 300);
  const position = positionOf(draft);
  if (Option.isSome(position) && position.value !== category.position) {
    patch.position = position.value;
  }
  if (draft.published !== (category.published !== false)) {
    patch.published = draft.published;
  }
  const slug = draft.slug.trim();
  if (slug !== category.slug && categorySlugValid(slug)) {
    patch.slug = slug;
  }
  const parentId = draft.parent?.id ?? null;
  if (parentId !== Option.getOrNull(category.parentId)) {
    patch.parentId = parentId === null ? Option.none() : Option.some(CatalogCategoryIdSchema.make(parentId));
  }
  return patch;
};

const idempotencyKey = Effect.all({ now: DateTime.now, random: Random.nextInt }, { concurrency: 1 }).pipe(
  Effect.map(({ now, random }) => `merchandise:category:${DateTime.toEpochMillis(now)}:${random}`),
);

/**
 * One category update: the new revision once committed, `proposed` when the change was parked for approval (nothing
 * is saved then), `conflict` when someone else changed the category meanwhile, otherwise `failed`.
 */
export const saveCategory = (
  command: Extract<MerchandiseCommand, { readonly _tag: 'UpdateCategory' }>,
  expectedRevision: number,
): Effect.Effect<RevisionedSaveResult> =>
  idempotencyKey.pipe(
    Effect.flatMap((key) => executeManageCatalog({ command, expectedRevision }, key, { idempotencyKey: key })),
    Effect.flatMap(committedResult),
    Effect.match({
      onFailure: (error): RevisionedSaveResult => {
        if (pendingProposalMessage(error) !== undefined) {
          return 'proposed';
        }
        return Match.value(error).pipe(
          Match.tag('ManageCatalogActionConflictProblem', (problem): RevisionedSaveResult =>
            problem.code === 'merchandise_lifecycle_conflict' ? 'failed' : 'conflict',
          ),
          Match.orElse((): RevisionedSaveResult => 'failed'),
        );
      },
      onSuccess: ({ revision }): RevisionedSaveResult => revision,
    }),
  );

/** Save of an existing category: unchanged drafts are no request at all. */
export const saveCategoryEdit = (
  draft: CategoryDraft,
  category: CategoryNode,
  expectedRevision: number,
): Effect.Effect<RevisionedSaveResult> => {
  const patch = categoryPatchOf(draft, category);
  if (Object.keys(patch).length === 0) {
    return Effect.succeed('saved');
  }
  return saveCategory({ _tag: 'UpdateCategory', id: category.id, patch }, expectedRevision);
};

/** A storefront URL slug from a name: lowercase ASCII words joined by dashes, no diacritics. */
export const categorySlugOf = (name: string): string =>
  name
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 200)
    .replaceAll(/-+$/gu, '');

/** The fields of a new category as typed. */
export interface NewCategoryDraft {
  readonly heading: string;
  readonly name: string;
  readonly parent: { readonly id: string; readonly trail: string } | null;
  readonly positionText: string;
  readonly published: boolean;
  /** Null while the slug follows the name. */
  readonly slug: string | null;
}

export const newCategorySlug = (draft: NewCategoryDraft): string => draft.slug ?? categorySlugOf(draft.name);

export const newCategoryInvalid = (draft: NewCategoryDraft): boolean => {
  const position = Number(draft.positionText.trim());
  return (
    draft.name.trim() === '' ||
    draft.name.trim().length > NAME_LIMIT ||
    !categorySlugValid(newCategorySlug(draft)) ||
    !Number.isInteger(position) ||
    position < 0
  );
};

/** The CreateCategory command of a valid draft, with a fresh id. */
export const createCategoryCommandOf = (
  draft: NewCategoryDraft,
  id: string,
): Extract<MerchandiseCommand, { readonly _tag: 'CreateCategory' }> => {
  const command = {
    _tag: 'CreateCategory',
    id: CatalogCategoryIdSchema.make(id),
    name: draft.name.trim(),
    parentId: draft.parent === null ? Option.none() : Option.some(CatalogCategoryIdSchema.make(draft.parent.id)),
    position: Number(draft.positionText.trim()),
    published: draft.published,
    slug: newCategorySlug(draft),
  } as const;
  const heading = draft.heading.trim();
  return heading === '' ? command : { ...command, heading };
};

/** The saved category as the register has it now, so the next save builds on the revision the server confirmed. */
export const savedCategory = (category: CategoryNode, draft: CategoryDraft): CategoryNode => ({
  ...category,
  ...categoryPatchOf(draft, category),
});
