// Catalog content editing: content history, category assignment and the UpdateCategory command.
import { Effect, Option, Predicate, Result, Schema } from 'effect';
import { MerchandiseLifecycleConflict, MerchandiseNotFound } from '../../shared/actions/apply-command.ts';
import type { MerchandiseCommand } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import {
  CatalogCategoryIdSchema,
  CatalogParameterSchema,
  EntityIdSchema,
  PriceTierSchema,
} from '../../shared/domain/merchandise-model.ts';
import type {
  CatalogCategory,
  CatalogCategoryId,
  CatalogChange,
  Product,
} from '../../shared/domain/merchandise-model.ts';
import type { MerchandiseChange, MerchandiseCommandError, MerchandiseCommandInput } from './persistence.service.ts';

type UpdateCategoryCommand = Extract<MerchandiseCommand, { readonly _tag: 'UpdateCategory' }>;

/** Catalog-content fields tracked in product history, with Czech labels. */
const contentFieldEntries = [
  ['name', 'Název'],
  ['shortDescription', 'Krátký popis'],
  ['description', 'Popis'],
  ['images', 'Obrázky'],
  ['imageSrc', 'Hlavní obrázek'],
  ['imageAlt', 'Popis obrázku'],
  ['category', 'Kategorie'],
  ['additionalCategoryIds', 'Další kategorie'],
  ['parameters', 'Parametry'],
  ['isAction', 'Akce'],
  ['isRecommended', 'Doporučujeme'],
  ['isSale', 'Výprodej'],
  ['isNew', 'Novinka'],
  ['unit', 'Jednotka'],
  ['minimumQuantity', 'Minimální množství'],
  ['packageQuantity', 'Balení'],
  ['priceTiers', 'Množstevní ceny'],
  ['published', 'Zveřejnění v e-shopu'],
  ['slug', 'Adresa v e-shopu'],
] as const;

const categoryFieldEntries = [
  ['published', 'Zveřejnění v navigaci'],
  ['name', 'Název'],
  ['heading', 'Nadpis'],
  ['description', 'Krátký popis'],
  ['longDescription', 'Popis'],
  ['position', 'Pořadí'],
  ['imageSrc', 'Obrázek'],
  ['imageAlt', 'Popis obrázku'],
] as const;

const MAX_HISTORY = 50;

const ContentValueSchema = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.String),
  Schema.Array(CatalogParameterSchema),
  Schema.Array(PriceTierSchema),
]);
type ContentValue = typeof ContentValueSchema.Type;
const equivalentContentValue = Schema.toEquivalence(ContentValueSchema);
const encodeContentValue = Schema.encodeResult(Schema.fromJsonString(ContentValueSchema));
const sameContentValue = (left: ContentValue | undefined, right: ContentValue | undefined) => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return equivalentContentValue(left, right);
};

/** Short Czech rendering of one owner-validated value for history before/after text. */
export const summarizeContentValue = (value: ContentValue | null | undefined): string => {
  if (value === undefined || value === null || value === '') {
    return '—';
  }
  if (Predicate.isBoolean(value)) {
    return value ? 'ano' : 'ne';
  }
  let text: string;
  if (Predicate.isString(value)) {
    text = value;
  } else if (Predicate.isNumber(value)) {
    text = String(value);
  } else {
    text = Result.getOrThrow(encodeContentValue(value));
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

/** Ids from the category itself up to its root (same order as the seed's `categoryPathIds`). */
export const categoryPathOf = (categories: readonly CatalogCategory[], id: string): readonly CatalogCategoryId[] => {
  const byId = new Map(categories.map((category) => [category.id, category] as const));
  const path: CatalogCategoryId[] = [];
  let next: CatalogCategoryId | null = CatalogCategoryIdSchema.make(id);
  while (next !== null && !path.includes(next)) {
    path.push(next);
    next = Option.getOrNull(byId.get(next)?.parentId ?? Option.none());
  }
  return path;
};

/** One history entry describing changed catalog-content fields, or undefined when nothing changed. */
export const contentChangeOf = (
  before: Product,
  after: Product,
  input: Pick<MerchandiseCommandInput, 'actor' | 'now'>,
): CatalogChange | undefined => {
  const changed = contentFieldEntries.filter(([field]) => !sameContentValue(before[field], after[field]));
  if (changed.length === 0) {
    return undefined;
  }
  return {
    actor: input.actor,
    after: changed.map(([field, label]) => `${label}: ${summarizeContentValue(after[field])}`).join('; '),
    at: input.now,
    before: changed.map(([field, label]) => `${label}: ${summarizeContentValue(before[field])}`).join('; '),
    fields: changed.map(([, label]) => label),
  };
};

/** `after` with a content-history entry appended when content changed (max 50 entries kept). */
export const withContentHistory = (
  before: Product,
  after: Product,
  input: Pick<MerchandiseCommandInput, 'actor' | 'now'>,
): Product => {
  const change = contentChangeOf(before, after, input);
  if (change === undefined) {
    return after;
  }
  return { ...after, contentHistory: [...(before.contentHistory ?? []), change].slice(-MAX_HISTORY) };
};

/** Opt-in multiple membership: validate every direct id and ancestor; callers never author category paths. */
export const assignCategoryMemberships = Effect.fn('Merchandise.assignCategoryMemberships')(
  function* assignCategoryMemberships(
    product: Product,
    categoryId: string,
    additionalCategoryIds: readonly CatalogCategoryId[],
    categories: readonly CatalogCategory[] | undefined,
  ): Effect.fn.Return<Product, MerchandiseCommandError> {
    const byId = new Map<string, CatalogCategory>((categories ?? []).map((category) => [category.id, category]));
    const primary = byId.get(categoryId);
    if (primary === undefined) {
      return yield* new MerchandiseLifecycleConflict({
        code: 'merchandise_lifecycle_conflict',
        reason: 'Vybraná kategorie neexistuje',
      });
    }
    const additional = [...new Set(additionalCategoryIds)].filter((id) => id !== primary.id).toSorted();
    const path: CatalogCategoryId[] = [];
    for (const id of [primary.id, ...additional]) {
      const seen = new Set<string>();
      let next: string | null = id;
      while (next !== null) {
        const category = byId.get(next);
        if (category === undefined || seen.has(next)) {
          return yield* new MerchandiseLifecycleConflict({
            code: 'merchandise_lifecycle_conflict',
            reason: category === undefined ? 'Nadřazená kategorie neexistuje' : 'Strom kategorií obsahuje cyklus',
          });
        }
        seen.add(next);
        if (!path.includes(category.id)) {
          path.push(category.id);
        }
        next = Option.getOrNull(category.parentId);
      }
    }
    return {
      ...product,
      additionalCategoryIds: additional,
      category: primary.name.slice(0, 120),
      categoryId: primary.id,
      categoryPathIds: path,
    };
  },
);

/** Moves the product to an existing category: sets categoryId, categoryPathIds and the `category` name. */
export const assignCategory = (
  product: Product,
  categoryId: string,
  categories: readonly CatalogCategory[] | undefined,
): Effect.Effect<Product, MerchandiseCommandError> => {
  if (product.additionalCategoryIds !== undefined) {
    return assignCategoryMemberships(product, categoryId, product.additionalCategoryIds, categories);
  }
  const all = categories ?? [];
  const category = all.find((candidate) => candidate.id === categoryId);
  if (category === undefined) {
    return Effect.fail(
      new MerchandiseLifecycleConflict({
        code: 'merchandise_lifecycle_conflict',
        reason: 'Vybraná kategorie neexistuje',
      }),
    );
  }
  return Effect.succeed({
    ...product,
    category: category.name.slice(0, 120),
    categoryId: category.id,
    categoryPathIds: [...categoryPathOf(all, category.id)],
  });
};

export const updateCategoryCommand = Effect.fn('Merchandise.updateCategoryCommand')(function* updateCategoryCommand(
  state: MerchandiseState,
  value: UpdateCategoryCommand,
  input: MerchandiseCommandInput,
): Effect.fn.Return<MerchandiseChange, MerchandiseCommandError> {
  const categories = state.categories ?? [];
  const current = categories.find((category) => category.id === value.id);
  if (current === undefined) {
    return yield* new MerchandiseNotFound({ code: 'merchandise_not_found', reason: 'Kategorie neexistuje' });
  }
  const entity = yield* Schema.decodeEffect(EntityIdSchema)(current.id).pipe(Effect.orDie);
  const next: CatalogCategory = { ...current, ...value.patch };
  const changed = categoryFieldEntries.filter(([field]) => current[field] !== next[field]);
  if (changed.length === 0) {
    return { entityIds: [entity], state };
  }
  const change: CatalogChange = {
    actor: input.actor,
    after: changed.map(([field, label]) => `${label}: ${summarizeContentValue(next[field])}`).join('; '),
    at: input.now,
    before: changed.map(([field, label]) => `${label}: ${summarizeContentValue(current[field])}`).join('; '),
    fields: changed.map(([, label]) => label),
  };
  const updated: CatalogCategory = { ...next, history: [...(current.history ?? []), change].slice(-MAX_HISTORY) };
  const renamed = updated.name !== current.name;
  return {
    entityIds: [entity],
    state: {
      ...state,
      categories: categories.map((category) => (category.id === updated.id ? updated : category)),
      products: renamed
        ? state.products.map((product) =>
            product.categoryId === updated.id
              ? { ...product, category: updated.name.slice(0, 120), updatedAt: input.now }
              : product,
          )
        : state.products,
    },
  };
});

type CreateCategoryCommand = Extract<MerchandiseCommand, { readonly _tag: 'CreateCategory' }>;

/**
 * Adds one category under an existing parent (or at the root) and marks the parent as having children. The new category
 * is published unless the command says otherwise; its position follows its siblings unless the command gives one.
 */
export const createCategoryCommand = Effect.fn('Merchandise.createCategoryCommand')(function* createCategoryCommand(
  state: MerchandiseState,
  value: CreateCategoryCommand,
): Effect.fn.Return<MerchandiseChange, MerchandiseCommandError> {
  const categories = state.categories ?? [];
  if (categories.some((category) => category.id === value.id)) {
    return yield* new MerchandiseLifecycleConflict({
      code: 'merchandise_lifecycle_conflict',
      reason: 'Kategorie s tímto identifikátorem už existuje',
    });
  }
  if (categories.some((category) => category.slug === value.slug)) {
    return yield* new MerchandiseLifecycleConflict({
      code: 'merchandise_category_slug_taken',
      reason: 'Tuto adresu v e-shopu už používá jiná kategorie. Zvolte jinou adresu.',
    });
  }
  const parentId = Option.getOrNull(value.parentId);
  const parent = parentId === null ? undefined : categories.find((category) => category.id === parentId);
  if (parentId !== null && parent === undefined) {
    return yield* new MerchandiseNotFound({ code: 'merchandise_not_found', reason: 'Nadřazená kategorie neexistuje' });
  }
  const siblings = categories.filter((category) => Option.getOrNull(category.parentId) === parentId);
  const created: CatalogCategory = {
    description: '',
    hasChildren: false,
    heading: value.heading ?? value.name,
    id: value.id,
    imageAlt: '',
    imageSrc: '',
    longDescription: '',
    name: value.name,
    parentId: value.parentId,
    position: value.position ?? siblings.length,
    published: value.published ?? true,
    slug: value.slug,
  };
  const entity = yield* Schema.decodeEffect(EntityIdSchema)(created.id).pipe(Effect.orDie);
  const parentUpdated = parent !== undefined && !parent.hasChildren ? { ...parent, hasChildren: true } : undefined;
  const parentEntity =
    parentUpdated === undefined
      ? undefined
      : yield* Schema.decodeEffect(EntityIdSchema)(parentUpdated.id).pipe(Effect.orDie);
  const entityIds = parentEntity === undefined ? [entity] : [entity, parentEntity];
  return {
    entityIds,
    state: {
      ...state,
      categories: [
        ...categories.map((category) =>
          parentUpdated !== undefined && category.id === parentUpdated.id ? parentUpdated : category,
        ),
        created,
      ],
    },
  };
});
