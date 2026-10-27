// Catalog content editing: content history, category assignment and the UpdateCategory command.
import { Effect, Option, Result, Schema } from 'effect';
import { MerchandiseLifecycleConflict, MerchandiseNotFound } from '../../shared/actions/apply-command.ts';
import type { MerchandiseCommand } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { EntityIdSchema } from '../../shared/domain/merchandise-model.ts';
import type { CatalogCategory, CatalogChange, CategoryId, Product } from '../../shared/domain/merchandise-model.ts';
import type { MerchandiseChange, MerchandiseCommandError, MerchandiseCommandInput } from './persistence.service.ts';

type UpdateCategoryCommand = Extract<MerchandiseCommand, { readonly _tag: 'UpdateCategory' }>;

/** Catalog-content fields tracked in product history, with Czech labels. */
const CONTENT_FIELDS = {
  category: 'Kategorie',
  description: 'Popis',
  imageAlt: 'Popis obrázku',
  images: 'Obrázky',
  imageSrc: 'Hlavní obrázek',
  isAction: 'Akce',
  isNew: 'Novinka',
  isRecommended: 'Doporučujeme',
  isSale: 'Výprodej',
  minimumQuantity: 'Minimální množství',
  name: 'Název',
  packageQuantity: 'Balení',
  parameters: 'Parametry',
  priceTiers: 'Množstevní ceny',
  published: 'Zveřejnění v e-shopu',
  shortDescription: 'Krátký popis',
  slug: 'Adresa v e-shopu',
  unit: 'Jednotka',
} as const satisfies Partial<Record<keyof Product, string>>;
type ContentField = keyof typeof CONTENT_FIELDS;
// Audit text keeps the presentation order used before object-key sorting.
const contentFields: readonly ContentField[] = [
  'name',
  'shortDescription',
  'description',
  'images',
  'imageSrc',
  'imageAlt',
  'category',
  'parameters',
  'isAction',
  'isRecommended',
  'isSale',
  'isNew',
  'unit',
  'minimumQuantity',
  'packageQuantity',
  'priceTiers',
  'published',
  'slug',
];

const CATEGORY_FIELDS = {
  description: 'Krátký popis',
  heading: 'Nadpis',
  imageAlt: 'Popis obrázku',
  imageSrc: 'Obrázek',
  longDescription: 'Popis',
  name: 'Název',
  position: 'Pořadí',
  published: 'Zveřejnění v navigaci',
} as const;
type CategoryField = keyof typeof CATEGORY_FIELDS;
const categoryFields: readonly CategoryField[] = [
  'published',
  'name',
  'heading',
  'description',
  'longDescription',
  'position',
  'imageSrc',
  'imageAlt',
];
type ContentValue = Product[ContentField] | CatalogCategory[CategoryField];
const encodeHistoryValue = Schema.encodeResult(Schema.fromJsonString(Schema.Json));
const equivalentContent = Schema.toEquivalence(Schema.Json);
const sameContentValue = (before: ContentValue, after: ContentValue) =>
  before === undefined || after === undefined ? before === after : equivalentContent(before, after);

const MAX_HISTORY = 50;

/** Short Czech rendering of one value for history before/after text. */
export const summarizeContentValue = (value: ContentValue): string => {
  if (value === undefined || value === null || value === '') {
    return '—';
  }
  if (Schema.is(Schema.Boolean)(value)) {
    return value === true ? 'ano' : 'ne';
  }
  let text: string;
  if (Schema.is(Schema.String)(value)) {
    text = value;
  } else if (Schema.is(Schema.Finite)(value)) {
    text = String(value);
  } else {
    text = Result.getOrThrow(encodeHistoryValue(value));
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

/** Ids from the category itself up to its root (same order as the seed's `categoryPathIds`). */
export const categoryPathOf = (categories: readonly CatalogCategory[], id: CategoryId): readonly CategoryId[] => {
  const byId = new Map(categories.map((category) => [category.id, category] as const));
  const path: CategoryId[] = [];
  let next: CategoryId | null = id;
  while (next !== null && !path.includes(next)) {
    path.push(next);
    const parent: CatalogCategory['parentId'] | undefined = byId.get(next)?.parentId;
    next = parent === undefined ? null : Option.getOrNull(parent);
  }
  return path;
};

/** One history entry describing changed catalog-content fields, or undefined when nothing changed. */
export const contentChangeOf = (
  before: Product,
  after: Product,
  input: Pick<MerchandiseCommandInput, 'actor' | 'now'>,
): CatalogChange | undefined => {
  const changed = contentFields.filter((field) => !sameContentValue(before[field], after[field]));
  if (changed.length === 0) {
    return undefined;
  }
  return {
    actor: input.actor,
    after: changed.map((field) => `${CONTENT_FIELDS[field]}: ${summarizeContentValue(after[field])}`).join('; '),
    at: input.now,
    before: changed.map((field) => `${CONTENT_FIELDS[field]}: ${summarizeContentValue(before[field])}`).join('; '),
    fields: changed.map((field) => CONTENT_FIELDS[field]),
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

/** Moves the product to an existing category: sets categoryId, categoryPathIds and the `category` name. */
export const assignCategory = (
  product: Product,
  categoryId: string,
  categories: readonly CatalogCategory[] | undefined,
): Effect.Effect<Product, MerchandiseCommandError> => {
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

export const updateCategoryCommand = Effect.fn('CatalogContent.updateCategoryCommand')(
  function* updateCategoryCommandProgram(
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
    const changed = categoryFields.filter((field) => current[field] !== next[field]);
    if (changed.length === 0) {
      return { entityIds: [entity], state };
    }
    const change: CatalogChange = {
      actor: input.actor,
      after: changed.map((field) => `${CATEGORY_FIELDS[field]}: ${summarizeContentValue(next[field])}`).join('; '),
      at: input.now,
      before: changed.map((field) => `${CATEGORY_FIELDS[field]}: ${summarizeContentValue(current[field])}`).join('; '),
      fields: changed.map((field) => CATEGORY_FIELDS[field]),
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
  },
);
