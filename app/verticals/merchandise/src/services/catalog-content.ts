// Catalog content editing: content history, category assignment and the UpdateCategory command.
// SKELETON (lane akros-sync-backend): task "catalog-content" replaces the stub bodies; keep the exported signatures.
import { Effect } from 'effect';
import { MerchandiseNotFound } from '../../shared/actions/apply-command.ts';
import type { MerchandiseCommand } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import type { CatalogCategory, CatalogChange, Product } from '../../shared/domain/merchandise-model.ts';
import type { MerchandiseChange, MerchandiseCommandError, MerchandiseCommandInput } from './persistence.service.ts';

type UpdateCategoryCommand = Extract<MerchandiseCommand, { readonly _tag: 'UpdateCategory' }>;

/** Ids from the category itself up to its root (same order as the seed's `categoryPathIds`). */
export const categoryPathOf = (categories: readonly CatalogCategory[], id: string): readonly string[] => {
  void categories;
  return [id];
};

/** One history entry describing changed catalog-content fields, or undefined when nothing changed. */
export const contentChangeOf = (
  before: Product,
  after: Product,
  input: Pick<MerchandiseCommandInput, 'actor' | 'now'>,
): CatalogChange | undefined => {
  void before;
  void after;
  void input;
  return undefined;
};

/** `after` with a content-history entry appended when content changed (max 50 entries kept). */
export const withContentHistory = (
  before: Product,
  after: Product,
  input: Pick<MerchandiseCommandInput, 'actor' | 'now'>,
): Product => {
  void before;
  void input;
  return after;
};

/** Moves the product to an existing category: sets categoryId, categoryPathIds and the `category` name. */
export const assignCategory = (
  product: Product,
  categoryId: string,
  categories: readonly CatalogCategory[] | undefined,
): Effect.Effect<Product, MerchandiseCommandError> => {
  void categoryId;
  void categories;
  return Effect.succeed(product);
};

export const updateCategoryCommand = (
  state: MerchandiseState,
  value: UpdateCategoryCommand,
  input: MerchandiseCommandInput,
): Effect.Effect<MerchandiseChange, MerchandiseCommandError> => {
  void state;
  void value;
  void input;
  return Effect.fail(new MerchandiseNotFound({ code: 'merchandise_not_found', reason: 'Category editing is not ready yet' }));
};
