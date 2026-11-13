import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { prepareSearchPredicate, searchReachSql, searchRecordVisible } from './search-record-access.ts';
import {
  CoreSearchQueryRuntime,
  CoreSearchProjectionDocumentSchema,
  CoreSearchWorkerSnapshot,
  CoreSearchProjectionStore,
  CoreSearchIngestion,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import {
  CORE_SEARCH_RELEVANCE_MAX_SCORE,
  matchesCoreSearchValues,
  normalizeCoreSearchText,
  parseCoreSearchQuery,
} from '@app/core-runtime/search-contract';
import { coreSearchRelevance, compareCoreSearchHits } from '@app/core-runtime/search-ranking';
import type {
  CoreSearchProjectionDocument,
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
  OperationalScope,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Effect, Match, Result, Schema } from 'effect';
import { catalogHeads, products, productVariants, orders } from '../database/schema.ts';
import type { MerchandiseCommand } from '../../shared/actions/apply-command.ts';
import type { ProductVariant } from '../../shared/domain/merchandise-model.ts';
import { MinorAmountSchema } from '../../shared/domain/merchandise-model.ts';
import { ProductsProviderMatchedVariantSchema } from '../../shared/apis/products-search.ts';
import type { ProductsProviderMatchedVariant } from '../../shared/apis/products-search.ts';
import type { OutboxPayload as RefreshTarget } from '../../shared/outbox/demo-merchandise-search-refresh-requested-v1.ts';

const MODULE = 'demo.merchandise';
const unavailable = (cause?: unknown) => {
  const error = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Merchandise search projection is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const SearchParameterSchema = Schema.Struct({ label: Schema.String, value: Schema.String });
const SearchParametersSchema = Schema.Array(SearchParameterSchema);
type SearchParameter = typeof SearchParameterSchema.Type;
const parameterTexts = (parameters: readonly SearchParameter[] | undefined): readonly string[] =>
  (parameters ?? []).flatMap(({ label, value }) => [label.trim(), value.trim()].filter((text) => text.length > 0));

/** Pack whole approved fields, never slice a searchable value or drop evidence to fit Core's document bounds. */
const withParameterTexts = (base: readonly string[], parameters: readonly SearchParameter[] | undefined): string[] => {
  const texts = [...base];
  for (const term of parameterTexts(parameters)) {
    const index = texts.findIndex((text) => text.length + 1 + term.length <= 300);
    if (index === -1) {
      texts.push(term);
    } else {
      texts[index] = `${texts[index]} ${term}`;
    }
  }
  return texts;
};

interface ProductRow {
  readonly active: boolean;
  readonly archived: boolean;
  readonly id: string;
  readonly legalEntityId: string;
  readonly name: string;
  readonly parameters?: readonly SearchParameter[];
  readonly sku: string;
  readonly tenantId: string;
}
interface VariantRow extends Pick<ProductVariant, 'active'> {
  readonly legalEntityId: string;
  readonly name: string;
  readonly parameters?: readonly SearchParameter[];
  readonly priceMinor?: number | null;
  readonly productId: string;
  readonly sku: string | null;
  readonly tenantId: string;
  readonly variantId?: string | null;
}
interface OrderRow {
  readonly id: string;
  readonly legalEntityId: string;
  readonly number: string;
  readonly removed: boolean;
  readonly tenantId: string;
}
export interface MerchandiseSearchSnapshot {
  readonly orders: readonly OrderRow[];
  readonly products: readonly ProductRow[];
  readonly projectionVersion: string;
  readonly tenantId: string;
  readonly variants: readonly VariantRow[];
}

/** The same allowlisted, active owner evidence feeds publication and current-query rematching. */
const productSearchEvidence = (productRows: readonly ProductRow[], variants: readonly VariantRow[]) => {
  const byProduct = new Map<string, { skus: string[]; text: string[]; variants: VariantRow[] }>();
  for (const variant of variants) {
    // Match the canonical owner's legacy default (productRowsOf / stock-levels): only explicit false is inactive.
    if (variant.active === false) {
      continue;
    }
    const key = `${variant.tenantId}:${variant.legalEntityId}:${variant.productId}`;
    const evidence = byProduct.get(key) ?? { skus: [], text: [], variants: [] };
    evidence.variants.push(variant);
    evidence.text.push(
      ...withParameterTexts([variant.name, ...(variant.sku === null ? [] : [variant.sku])], variant.parameters),
    );
    if (variant.sku !== null) {
      evidence.skus.push(variant.sku);
    }
    byProduct.set(key, evidence);
  }
  return productRows.map((row) => {
    const variant = byProduct.get(`${row.tenantId}:${row.legalEntityId}:${row.id}`);
    return {
      row,
      skus: [row.sku, ...(variant?.skus ?? [])],
      text: [...withParameterTexts([row.name, row.sku], row.parameters), ...(variant?.text ?? [])],
      variants: variant?.variants ?? [],
    };
  });
};

export const buildMerchandiseSearchDocuments = Effect.fn('Merchandise.buildSearchDocuments')(function* build(
  snapshot: MerchandiseSearchSnapshot,
) {
  const rows = [
    ...productSearchEvidence(snapshot.products, snapshot.variants).map(({ row, text }) => ({
      ...row,
      archived: row.archived || !row.active,
      text,
      title: row.name.trim() || 'Produkt',
      type: 'product',
    })),
    ...snapshot.orders.flatMap((row) =>
      row.removed
        ? []
        : [
            {
              ...row,
              archived: false,
              text: [row.number],
              title: `Objednávka ${row.number}`,
              type: 'order',
            },
          ],
    ),
  ];
  const identities = new Set<string>();
  return yield* Effect.forEach(
    rows,
    (row) => {
      const identity = `${row.legalEntityId}:${row.type}:${row.id}`;
      if (row.tenantId !== snapshot.tenantId || identities.has(identity)) {
        return Effect.fail(unavailable());
      }
      identities.add(identity);
      return Schema.decodeEffect(CoreSearchProjectionDocumentSchema)({
        aliases: [],
        archived: row.archived,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: {
          moduleId: MODULE,
          resourceId: `${row.legalEntityId}.${row.id}`,
          resourceType: `${MODULE}.${row.type}`,
          tenantId: row.tenantId,
        },
        searchableText: row.text,
        selectedLegalEntityId: row.legalEntityId,
        title: row.title,
      }).pipe(Effect.mapError(unavailable));
    },
    { concurrency: 1 },
  );
});

const decodeParameters = <Row extends { readonly parameters: unknown }>(row: Row) =>
  Schema.decodeUnknownEffect(SearchParametersSchema)(row.parameters ?? []).pipe(
    Effect.map((parameters) => ({ ...row, parameters })),
    Effect.mapError(unavailable),
  );

const currentRowsVisible = (
  predicate: ListAccessPredicate | undefined,
  rows: readonly { readonly id: string; readonly legalEntityId: string; readonly tenantId: string }[],
  scope: { readonly legalEntityId: string; readonly tenantId: string },
) => predicate === undefined || rows.every((row) => searchRecordVisible(predicate, row, scope));

/** Whether a company's catalog head is absent (nothing published yet), mid-import, or published. */
const headPublication = (head: { readonly bootstrapCheckpoint: unknown } | undefined) => {
  if (head === undefined) {
    return 'absent' as const;
  }
  return head.bootstrapCheckpoint === null ||
    Schema.is(Schema.Struct({ status: Schema.Literal('VERIFIED') }))(head.bootstrapCheckpoint)
    ? ('published' as const)
    : ('unverified' as const);
};

const readCompanySearch = Effect.fn('Merchandise.readCompanySearch')(function* readCompany(
  db: CoreSearchSnapshotReadExecutor,
  tenantId: string,
  legalEntityId: string,
  target?: RefreshTarget,
  publication: 'snapshot' | 'current' = 'snapshot',
  predicate?: ListAccessPredicate,
) {
  // Publication workers read an internal snapshot; a current user query must carry Core's admitted predicate.
  const admitted = publication === 'current' ? yield* prepareSearchPredicate(predicate) : undefined;
  const [head] = yield* db
    .select({ bootstrapCheckpoint: catalogHeads.bootstrapCheckpoint })
    .from(catalogHeads)
    .where(and(eq(catalogHeads.tenantId, tenantId), eq(catalogHeads.legalEntityId, legalEntityId)))
    .limit(1);
  const published = headPublication(head);
  if (published !== 'published') {
    // A company without a head row has no records yet; only an unfinished import is unavailable to a live search.
    if (publication === 'current' && published === 'unverified') {
      return yield* unavailable();
    }
    // Empty replacement snapshots retire any formerly published records without indexing partial import batches.
    return { orders: [], products: [], variants: [] };
  }
  const full = target === undefined || target.rebuild;
  const productRows =
    !full && target.productIds.length === 0
      ? []
      : yield* db
          .select({
            active: products.active,
            archived: products.archived,
            id: products.id,
            legalEntityId: products.legalEntityId,
            name: products.name,
            // Drizzle cannot select a typed JSON member; project only the approved parameters, never the document.
            parameters: sql<unknown>`${products.document}->'parameters'`,
            sku: products.sku,
            tenantId: products.tenantId,
          })
          .from(products)
          .where(
            and(
              eq(products.tenantId, tenantId),
              eq(products.legalEntityId, legalEntityId),
              full ? undefined : inArray(products.id, target.productIds),
              admitted === undefined
                ? undefined
                : searchReachSql(admitted, sql`${products.legalEntityId} || '.' || ${products.id}`),
            ),
          );
  const variantSelection = {
    active: productVariants.active,
    legalEntityId: productVariants.legalEntityId,
    name: productVariants.name,
    parameters: sql<unknown>`${productVariants.document}->'parameters'`,
    productId: productVariants.productId,
    sku: productVariants.sku,
    tenantId: productVariants.tenantId,
  };
  const variants =
    productRows.length === 0
      ? []
      : yield* db
          .select(
            // Real-variant proof is needed only for the current staff result, never the persisted Core document.
            publication === 'current'
              ? { ...variantSelection, priceMinor: productVariants.priceMinor, variantId: productVariants.variantId }
              : variantSelection,
          )
          .from(productVariants)
          .where(
            and(
              eq(productVariants.tenantId, tenantId),
              eq(productVariants.legalEntityId, legalEntityId),
              inArray(
                productVariants.productId,
                productRows.map((p) => p.id),
              ),
            ),
          );
  const orderRows =
    !full && target.orderIds.length === 0
      ? []
      : yield* db
          .select({
            id: orders.id,
            legalEntityId: orders.legalEntityId,
            number: orders.number,
            removed: orders.removed,
            tenantId: orders.tenantId,
          })
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(orders.legalEntityId, legalEntityId),
              full ? undefined : inArray(orders.id, target.orderIds),
              admitted === undefined
                ? undefined
                : searchReachSql(admitted, sql`${orders.legalEntityId} || '.' || ${orders.id}`),
            ),
          );
  if (
    [...productRows, ...variants, ...orderRows].some(
      (row) => row.tenantId !== tenantId || row.legalEntityId !== legalEntityId,
    )
  ) {
    return yield* unavailable();
  }
  if (!currentRowsVisible(admitted, [...productRows, ...orderRows], { legalEntityId, tenantId })) {
    return yield* unavailable();
  }
  return {
    orders: orderRows,
    products: yield* Effect.forEach(productRows, decodeParameters, { concurrency: 1 }),
    variants: yield* Effect.forEach(variants, decodeParameters, { concurrency: 1 }),
  };
});

/** The caller supplies a live Core-governed owner transaction; no executor escapes this read. */
export const loadCurrentMerchandiseSearch = Effect.fn('Merchandise.loadCurrentSearch')(function* loadCurrent(
  db: CoreSearchSnapshotReadExecutor,
  scope: OperationalScope,
  resource: 'product' | 'order',
  ids: readonly string[],
  predicate: ListAccessPredicate,
) {
  if (scope.legalEntityId === undefined) {
    return yield* unavailable();
  }
  return yield* readCompanySearch(
    db,
    scope.tenantId,
    scope.legalEntityId,
    {
      legalEntityId: scope.legalEntityId,
      orderIds: resource === 'order' ? [...ids] : [],
      productIds: resource === 'product' ? [...ids] : [],
      rebuild: false,
    },
    'current',
    predicate,
  ).pipe(Effect.mapError(unavailable));
});

/** Rows are already scoped to one tenant/company/parent. All tokens must belong to one current leaf. */
const uniqueMatchedVariant = (
  variants: readonly VariantRow[],
  tokens: readonly string[],
): ProductsProviderMatchedVariant | undefined => {
  let witness: VariantRow | undefined;
  for (const variant of variants) {
    if (
      !matchesCoreSearchValues(
        [variant.name, ...(variant.sku === null ? [] : [variant.sku]), ...parameterTexts(variant.parameters)],
        tokens,
      )
    ) {
      continue;
    }
    // Count informational matches too: a duplicate exact SKU is ambiguous even if only one row has an identity.
    if (witness !== undefined) {
      return undefined;
    }
    witness = variant;
  }
  if (
    witness === undefined ||
    witness.variantId === null ||
    witness.variantId === undefined ||
    !Schema.is(MinorAmountSchema)(witness.priceMinor)
  ) {
    return undefined;
  }
  const id = witness.variantId;
  if (variants.some((variant) => variant !== witness && variant.variantId === id)) {
    return undefined;
  }
  const name = witness.name.trim();
  const sku = witness.sku?.trim();
  // Decode only approved public fields. No price, stock, parent document, guessed name or synthetic identity escapes.
  const identity = { id };
  const named = name.length === 0 ? identity : { ...identity, name };
  const candidate = sku === undefined || sku.length === 0 ? named : { ...named, sku };
  return Result.getOrUndefined(Schema.decodeResult(ProductsProviderMatchedVariantSchema)(candidate));
};

interface CurrentSearchEvidence {
  readonly skus: readonly string[];
  readonly text: readonly string[];
  readonly title: string;
  readonly variants?: readonly VariantRow[];
}

/** Only trusted scope can choose the company; stale or foreign Core results fail closed. */
export const loadMerchandiseSearch = Effect.fn('Merchandise.loadSearch')(function* load<Ref, Encoded, CurrentFailure>(
  scope: OperationalScope,
  resource: 'product' | 'order',
  query: string,
  refSchema: Schema.Codec<Ref, Encoded>,
  readCurrentOwner: (
    ids: readonly string[],
  ) => Effect.Effect<Pick<MerchandiseSearchSnapshot, 'orders' | 'products' | 'variants'>, CurrentFailure>,
) {
  const runtime = yield* CoreSearchQueryRuntime;
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return yield* unavailable();
  }
  const hits = yield* runtime
    .search(
      {
        includeArchived: false,
        moduleId: MODULE,
        query,
        resourceType: `${MODULE}.${resource}`,
        selectedLegalEntityId: legalEntityId,
        tenantId: scope.tenantId,
      },
      scope,
    )
    .pipe(Effect.mapError(unavailable));
  const scopedHits = yield* Effect.forEach(
    hits,
    Effect.fn('Merchandise.mapSearchHit')(function* mapHit(hit) {
      if (
        hit.ref.tenantId !== scope.tenantId ||
        hit.selectedLegalEntityId !== legalEntityId ||
        !hit.ref.resourceId.startsWith(`${legalEntityId}.`) ||
        hit.ref.resourceId.length === legalEntityId.length + 1 ||
        hit.ref.moduleId !== MODULE ||
        hit.ref.resourceType !== `${MODULE}.${resource}` ||
        hit.archived ||
        hit.subjectRef !== undefined ||
        hit.matchedRef !== undefined ||
        hit.matchedSubjectRef !== undefined
      ) {
        return yield* unavailable();
      }
      const ref = yield* Schema.decodeUnknownEffect(refSchema)(hit.ref).pipe(Effect.mapError(unavailable));
      return { hit, ref, selectedLegalEntityId: hit.selectedLegalEntityId, title: hit.title };
    }),
    { concurrency: 1 },
  );
  const parsed = yield* Effect.fromResult(parseCoreSearchQuery(query)).pipe(Effect.mapError(unavailable));
  if (scopedHits.length === 0) {
    return [];
  }
  const ids = scopedHits.map(({ hit }) => hit.ref.resourceId.slice(legalEntityId.length + 1));
  // The reader opens its own short governed transaction only after Core candidate I/O has finished.
  const current = yield* readCurrentOwner(ids).pipe(Effect.mapError(unavailable));
  const evidence = new Map<string, CurrentSearchEvidence>(
    resource === 'product'
      ? productSearchEvidence(current.products, current.variants).flatMap(({ row, skus, text, variants }) =>
          row.active && !row.archived
            ? [[row.id, { skus, text, title: row.name.trim() || 'Produkt', variants }] as const]
            : [],
        )
      : current.orders.flatMap((row) =>
          row.removed ? [] : [[row.id, { skus: [], text: [row.number], title: `Objednávka ${row.number}` }] as const],
        ),
  );
  return scopedHits
    .flatMap(({ hit, ref, selectedLegalEntityId }) => {
      const owner = evidence.get(hit.ref.resourceId.slice(legalEntityId.length + 1));
      if (owner === undefined || !matchesCoreSearchValues(owner.text, parsed.tokens)) {
        return [];
      }
      const relevance = coreSearchRelevance({ ...hit, title: owner.title }, parsed);
      const skus = owner.skus.map((sku) => normalizeCoreSearchText(sku).trim().split(/\s+/u).join(' '));
      // These are bounded wire scores, not Core's lower-is-better rank tiers. Keep its version and fallback ranking.
      const prefixScore = skus.some((sku) => sku.startsWith(parsed.phrase)) ? CORE_SEARCH_RELEVANCE_MAX_SCORE - 1 : 0;
      const score = skus.includes(parsed.phrase)
        ? CORE_SEARCH_RELEVANCE_MAX_SCORE
        : Math.max(relevance.score, prefixScore);
      const matchedVariant =
        resource === 'product' ? uniqueMatchedVariant(owner.variants ?? [], parsed.tokens) : undefined;
      const result = { ref, relevance: { ...relevance, score }, selectedLegalEntityId, title: owner.title };
      return [
        {
          hit: { ...hit, title: owner.title },
          result: matchedVariant === undefined ? result : { matchedVariant, ...result },
        },
      ];
    })
    .toSorted(
      (left, right) =>
        right.result.relevance.score - left.result.relevance.score ||
        compareCoreSearchHits(left.hit, right.hit, parsed),
    )
    .map(({ result }) => result);
});

/** Only explicit tenant/company predicates reach owner tables under the Core-reserved snapshot. */
const readSearchSnapshot = Effect.fn('Merchandise.readSearchSnapshot')(function* readSnapshot(
  view: CoreSearchWorkerSnapshotView,
  context: OutboxWorkerHandlerContext,
  target?: RefreshTarget,
) {
  if (
    view.tenantId !== context.tenantId ||
    (target !== undefined && !view.legalEntityIds.includes(target.legalEntityId))
  ) {
    return yield* unavailable();
  }
  const companies = target === undefined || target.rebuild ? view.legalEntityIds : [target.legalEntityId];
  const scopes = yield* Effect.forEach(
    companies,
    (legalEntityId) =>
      view.forLegalEntity(legalEntityId, (db) => readCompanySearch(db, view.tenantId, legalEntityId, target)),
    { concurrency: 1 },
  );
  return {
    orders: scopes.flatMap((scope) => scope.orders),
    products: scopes.flatMap((scope) => scope.products),
    projectionVersion: view.projectionVersion,
    tenantId: view.tenantId,
    variants: scopes.flatMap((scope) => scope.variants),
  };
});

/** No private order contact/address or notes are selected, even into the indexer's memory. */
export const loadMerchandiseSearchSnapshot = Effect.fn('Merchandise.searchSnapshot')(function* loadSnapshot(
  context: OutboxWorkerHandlerContext,
  target?: RefreshTarget,
) {
  const reader = yield* CoreSearchWorkerSnapshot;
  return yield* reader
    .read(context, (view) => readSearchSnapshot(view, context, target))
    .pipe(Effect.mapError(unavailable));
});

/** Snapshot SQL has closed before Core index and SpiceDB mutations start. */
export const publishMerchandiseSearch = Effect.fn('Merchandise.publishSearch')(function* publish(
  context: OutboxWorkerHandlerContext,
  snapshot: MerchandiseSearchSnapshot,
  target?: RefreshTarget,
) {
  if (snapshot.tenantId !== context.tenantId) {
    return yield* unavailable();
  }
  const documents = yield* buildMerchandiseSearchDocuments(snapshot);
  const store = yield* CoreSearchProjectionStore;
  // Core Search enforces the caller's access list predicate and field projection; the owner writes no
  // permission-graph containment edge. Snapshot SQL has closed before Core index mutation starts.
  if (target === undefined || target.rebuild) {
    yield* Effect.forEach(
      ['product', 'order'],
      (type) =>
        store.replace(
          {
            documents: documents.filter((d) => d.ref.resourceType === `${MODULE}.${type}`),
            moduleId: MODULE,
            rebuildVersion: snapshot.projectionVersion,
            resourceType: `${MODULE}.${type}`,
            tenantId: snapshot.tenantId,
          },
          context,
        ),
      { concurrency: 1, discard: true },
    );
    return yield* Effect.void;
  }
  const ingestion = yield* CoreSearchIngestion;
  const observe = (
    mutation:
      | { readonly document: CoreSearchProjectionDocument; readonly kind: 'upsert' }
      | {
          readonly kind: 'delete';
          readonly projectionVersion: string;
          readonly ref: {
            readonly moduleId: string;
            readonly resourceId: string;
            readonly resourceType: string;
            readonly tenantId: string;
          };
        },
  ) =>
    ingestion.ingest(
      {
        consumerModuleKey: MODULE,
        mutation,
        producerModuleKey: context.producerModuleKey,
        projectionVersion: snapshot.projectionVersion,
        tenantId: context.tenantId,
        topic: context.topic,
        workerKey: context.workerKey,
      },
      context,
    );
  yield* Effect.forEach(documents, (document) => observe({ document, kind: 'upsert' }), {
    concurrency: 1,
    discard: true,
  });
  yield* Effect.forEach(
    [
      ['product', target.productIds],
      ['order', target.orderIds],
    ] as const,
    ([type, ids]) =>
      Effect.forEach(
        ids.filter(
          (id) =>
            !documents.some(
              (document) =>
                document.ref.resourceType === `${MODULE}.${type}` &&
                document.ref.resourceId === `${target.legalEntityId}.${id}`,
            ),
        ),
        (id) =>
          observe({
            kind: 'delete',
            projectionVersion: snapshot.projectionVersion,
            ref: {
              moduleId: MODULE,
              resourceId: `${target.legalEntityId}.${id}`,
              resourceType: `${MODULE}.${type}`,
              tenantId: snapshot.tenantId,
            },
          }),
        { concurrency: 1, discard: true },
      ),
    { concurrency: 1, discard: true },
  );
  return yield* Effect.void;
});

export const projectMerchandiseSearch = Effect.fn('Merchandise.projectSearch')(function* project(
  context: OutboxWorkerHandlerContext,
  target?: RefreshTarget,
) {
  const snapshot = yield* loadMerchandiseSearchSnapshot(context, target);
  yield* publishMerchandiseSearch(context, snapshot, target);
});

/** Mutation targets contain owner identities only, never untrusted company selection or raw state. */
export const merchandiseSearchRefreshTarget = (
  command: MerchandiseCommand,
  ids: readonly string[],
  legalEntityId: string,
): RefreshTarget => {
  const base = { legalEntityId, orderIds: [], productIds: [], rebuild: false };
  return Match.value(command).pipe(
    Match.tagsExhaustive({
      AiDecideChanges: () => ({ ...base, orderIds: ids }),
      AiProposeChanges: () => base,
      AiRevertBatch: () => ({ ...base, orderIds: ids }),
      ArchiveDemoProduct: (value) => ({ ...base, productIds: [value.id] }),
      BulkUpdateProducts: (value) => ({ ...base, productIds: value.ids }),
      ChangeOrderStatus: (value) => ({ ...base, orderIds: [value.id] }),
      ChangePrice: (value) => ({ ...base, productIds: [value.id] }),
      ChangeProductImages: (value) => ({ ...base, productIds: [value.id] }),
      ConfigureMarket: () => base,
      CreateCategory: () => base,
      CreateOrder: () => ({ ...base, orderIds: ids }),
      CreateProduct: () => ({ ...base, productIds: ids }),
      EditOrder: (value) => ({ ...base, orderIds: [value.id] }),
      LinkOrderCustomer: (value) => ({ ...base, orderIds: [value.id] }),
      PlaceStorefrontOrder: () => ({ ...base, orderIds: ids }),
      RecordStockMovement: (value) => ({ ...base, productIds: [value.productId] }),
      RemoveDemoOrder: (value) => ({ ...base, orderIds: [value.id] }),
      RemoveMarket: () => base,
      ResetDemoData: () => ({ ...base, rebuild: true }),
      SetMarketProductOffers: () => base,
      SetProductMarketOffer: () => base,
      SyncTaxRates: () => base,
      UpdateCategory: () => base,
      UpdateProduct: (value) => ({ ...base, productIds: [value.id] }),
    }),
  );
};
