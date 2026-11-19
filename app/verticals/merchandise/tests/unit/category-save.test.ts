// @rstest-environment happy-dom
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { beforeEach, describe, expect, it } from 'effect-rstest';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/actions/manage-catalog.ts';
import { ManageCatalogResultSchema } from '../../shared/actions/manage-catalog.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import { CategoryNodeSchema } from '../../shared/domain/merchandise-model.ts';
import type { CategoryNode } from '../../shared/domain/merchandise-model.ts';
import {
  categoryDraftErrors,
  categoryPatchOf,
  draftOf,
  positionOf,
  sameCategoryDraft,
  saveCategoryEdit,
  savedCategory,
} from '../../src/routes/[lang]/provoz/produkty/category-save.ts';

const commands: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const confirmed = Schema.decodeUnknownSync(ManageCatalogResultSchema)({ entityIds: [], revision: 8 });
const OwnerActionApi = ManageCatalogActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return confirmed;
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
);

beforeEach(() => {
  commands.length = 0;
});

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
    const changedDraft = { ...saved, name: 'Káva a čaj', positionText: '20' };
    const next = savedCategory(category, changedDraft);
    expect(next).toMatchObject({ name: 'Káva a čaj', position: 20 });
    expect(draftOf(next)).toEqual({ ...saved, name: 'Káva a čaj', positionText: '20' });
    const repeatedDraft = draftOf(next);
    expect(categoryPatchOf(repeatedDraft, next)).toEqual({});
  });
});

describe('category save', () => {
  it.live('sends nothing for an unchanged draft', () =>
    Effect.gen(function* unchanged() {
      yield* pinTestDocument;
      const result = yield* saveCategoryEdit(saved, category, 7);
      expect(result).toBe('saved');
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(network)),
  );

  it.live('sends one update for the whole changed draft, against the revision the draft is based on', () =>
    Effect.gen(function* changed() {
      yield* pinTestDocument;
      const result = yield* saveCategoryEdit({ ...saved, name: 'Káva a čaj', positionText: '20' }, category, 7);
      expect(result).toBe(8);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        command: { _tag: 'UpdateCategory', id: 'kava', patch: { name: 'Káva a čaj', position: 20 } },
        expectedRevision: 7,
      });
    }).pipe(Effect.provide(network)),
  );
});
