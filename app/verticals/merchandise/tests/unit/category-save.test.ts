import { Effect, Option, Schema } from 'effect';
import { describe, expect, it, rstest } from 'effect-rstest';
import { CategoryNodeSchema } from '../../shared/domain/merchandise-model.ts';
import type { CategoryNode } from '../../shared/domain/merchandise-model.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import {
  categoryDraftErrors,
  categoryPatchOf,
  draftOf,
  positionOf,
  sameCategoryDraft,
  saveCategoryEdit,
  savedCategory,
} from '../../src/routes/[lang]/provoz/produkty/category-save.ts';

rstest.mock('../../src/api/manage-catalog-action-client.ts');

const category: CategoryNode = Schema.decodeSync(CategoryNodeSchema)({
  description: 'Káva a čaj',
  hasChildren: false,
  heading: 'Káva',
  id: 'kava',
  longDescription: 'Dlouhý popis kategorie.',
  name: 'Káva',
  parentId: null,
  position: 10,
  published: true,
  slug: 'kava',
});
const saved = draftOf(category);

describe('category edit draft', () => {
  it('treats a draft that differs only in spaces or leading zeroes as already saved', () => {
    expect(sameCategoryDraft(saved, { ...saved, name: 'Káva ', positionText: '010' })).toBe(true);
    expect(sameCategoryDraft(saved, { ...saved, heading: 'Káva a čaj' })).toBe(false);
    expect(sameCategoryDraft(saved, { ...saved, published: false })).toBe(false);
  });

  it('requires a name up to 200 characters and a whole, non-negative position', () => {
    expect(categoryDraftErrors(saved)).toEqual({});
    expect(categoryDraftErrors({ ...saved, name: '   ' })).toEqual({ name: 'required' });
    expect(categoryDraftErrors({ ...saved, name: 'n'.repeat(201) })).toEqual({ name: 'tooLong' });
    expect(categoryDraftErrors({ ...saved, positionText: '' })).toEqual({ position: 'required' });
    expect(categoryDraftErrors({ ...saved, positionText: '2,5' })).toEqual({ position: 'notWhole' });
    expect(categoryDraftErrors({ ...saved, positionText: '-1' })).toEqual({ position: 'negative' });
    expect(Option.isNone(positionOf({ ...saved, positionText: '2,5' }))).toBe(true);
  });

  it('sends only the changed fields, trimmed, so an emptied description clears it', () => {
    expect(categoryPatchOf(saved, category)).toEqual({});
    expect(categoryPatchOf({ ...saved, heading: '', name: ' Káva a čaj ', positionText: '20' }, category)).toEqual({
      heading: '',
      name: 'Káva a čaj',
      position: 20,
    });
    expect(categoryPatchOf({ ...saved, positionText: '10', published: false }, category)).toEqual({ published: false });
  });

  it('keeps the saved category in step with what the server confirmed', () => {
    const next = savedCategory(category, { ...saved, name: 'Káva a čaj', positionText: '20' });
    expect(next).toMatchObject({ name: 'Káva a čaj', position: 20 });
    expect(draftOf(next)).toEqual({ ...saved, name: 'Káva a čaj', positionText: '20' });
    expect(categoryPatchOf(draftOf(next), next)).toEqual({});
  });
});

describe('category save', () => {
  it.effect('sends nothing for an unchanged draft', () =>
    Effect.gen(function* unchanged() {
      rstest.mocked(executeManageCatalog).mockClear();
      const result = yield* saveCategoryEdit(saved, category, 7);
      expect(result).toBe('saved');
      expect(rstest.mocked(executeManageCatalog)).not.toHaveBeenCalled();
    }),
  );

  it.effect('sends one update for the whole changed draft, against the revision the draft is based on', () =>
    Effect.gen(function* changed() {
      rstest.mocked(executeManageCatalog).mockClear();
      rstest.mocked(executeManageCatalog).mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
      const result = yield* saveCategoryEdit({ ...saved, name: 'Káva a čaj', positionText: '20' }, category, 7);
      expect(result).toBe(8);
      const {
        mock: { calls },
      } = rstest.mocked(executeManageCatalog);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toMatchObject({
        command: { _tag: 'UpdateCategory', id: 'kava', patch: { name: 'Káva a čaj', position: 20 } },
        expectedRevision: 7,
      });
    }),
  );
});
