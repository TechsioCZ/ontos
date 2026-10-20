// Catalog content editing: content history, category assignment and the UpdateCategory command.
import { Effect, Schema } from 'effect';
import { MerchandiseLifecycleConflict, MerchandiseNotFound } from '../../shared/actions/apply-command.ts';
import type { MerchandiseCommand } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { EntityIdSchema } from '../../shared/domain/merchandise-model.ts';
import type { CatalogCategory, CatalogChange, Product } from '../../shared/domain/merchandise-model.ts';
import type { MerchandiseChange, MerchandiseCommandError, MerchandiseCommandInput } from './persistence.service.ts';

type UpdateCategoryCommand = Extract<MerchandiseCommand, { readonly _tag: 'UpdateCategory' }>;

/** Catalog-content fields tracked in product history, with Czech labels. */
const CONTENT_FIELDS = {
  name: 'Název',
  shortDescription: 'Krátký popis',
  description: 'Popis',
  images: 'Obrázky',
  imageSrc: 'Hlavní obrázek',
  imageAlt: 'Popis obrázku',
  category: 'Kategorie',
  parameters: 'Parametry',
  isAction: 'Akce',
  isRecommended: 'Doporučujeme',
  isSale: 'Výprodej',
  isNew: 'Novinka',
  unit: 'Jednotka',
  minimumQuantity: 'Minimální množství',
  packageQuantity: 'Balení',
  priceTiers: 'Množstevní ceny',
  published: 'Zveřejnění v e-shopu',
  slug: 'Adresa v e-shopu',
} as const satisfies Partial<Record<keyof Product, string>>;
type ContentField = keyof typeof CONTENT_FIELDS;
const contentFields = Object.keys(CONTENT_FIELDS) as ContentField[];

const CATEGORY_FIELDS = {
  name: 'Název',
  heading: 'Nadpis',
  description: 'Krátký popis',
  longDescription: 'Popis',
  position: 'Pořadí',
  imageSrc: 'Obrázek',
  imageAlt: 'Popis obrázku',
} as const;
type CategoryField = keyof typeof CATEGORY_FIELDS;

const MAX_HISTORY = 50;

/** Short Czech rendering of one value for history before/after text. */
export const summarizeContentValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'ano' : 'ne';
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

/** Ids from the category itself up to its root (same order as the seed's `categoryPathIds`). */
export const categoryPathOf = (categories: readonly CatalogCategory[], id: string): readonly string[] => {
  const byId = new Map(categories.map((category) => [category.id, category] as const));
  const path: string[] = [];
  let next: string | null = id;
  while (next !== null && !path.includes(next)) {
    path.push(next);
    next = byId.get(next)?.parentId ?? null;
  }
  return path;
};

/** One history entry describing changed catalog-content fields, or undefined when nothing changed. */
export const contentChangeOf = (
  before: Product,
  after: Product,
  input: Pick<MerchandiseCommandInput, 'actor' | 'now'>,
): CatalogChange | undefined => {
  const changed = contentFields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  if (changed.length === 0) return undefined;
  return {
    actor: input.actor,
    at: input.now,
    fields: changed.map((field) => CONTENT_FIELDS[field]),
    before: changed.map((field) => `${CONTENT_FIELDS[field]}: ${summarizeContentValue(before[field])}`).join('; '),
    after: changed.map((field) => `${CONTENT_FIELDS[field]}: ${summarizeContentValue(after[field])}`).join('; '),
  };
};

/** `after` with a content-history entry appended when content changed (max 50 entries kept). */
export const withContentHistory = (
  before: Product,
  after: Product,
  input: Pick<MerchandiseCommandInput, 'actor' | 'now'>,
): Product => {
  const change = contentChangeOf(before, after, input);
  if (change === undefined) return after;
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
      new MerchandiseLifecycleConflict({ code: 'merchandise_lifecycle_conflict', reason: 'Vybraná kategorie neexistuje' }),
    );
  }
  return Effect.succeed({
    ...product,
    categoryId: category.id,
    categoryPathIds: [...categoryPathOf(all, category.id)],
    category: category.name.slice(0, 120),
  });
};

export const updateCategoryCommand = (
  state: MerchandiseState,
  value: UpdateCategoryCommand,
  input: MerchandiseCommandInput,
): Effect.Effect<MerchandiseChange, MerchandiseCommandError> =>
  Effect.gen(function* () {
    const categories = state.categories ?? [];
    const current = categories.find((category) => category.id === value.id);
    if (current === undefined) {
      return yield* new MerchandiseNotFound({ code: 'merchandise_not_found', reason: 'Kategorie neexistuje' });
    }
    const entity = yield* Schema.decodeEffect(EntityIdSchema)(current.id).pipe(Effect.orDie);
    const next: CatalogCategory = { ...current, ...value.patch };
    const changed = (Object.keys(CATEGORY_FIELDS) as CategoryField[]).filter((field) => current[field] !== next[field]);
    if (changed.length === 0) return { entityIds: [entity], state };
    const change: CatalogChange = {
      actor: input.actor,
      at: input.now,
      fields: changed.map((field) => CATEGORY_FIELDS[field]),
      before: changed.map((field) => `${CATEGORY_FIELDS[field]}: ${summarizeContentValue(current[field])}`).join('; '),
      after: changed.map((field) => `${CATEGORY_FIELDS[field]}: ${summarizeContentValue(next[field])}`).join('; '),
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
