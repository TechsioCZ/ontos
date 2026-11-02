import {
  CoreSearchQueryRuntime,
  CoreSearchProjectionDocumentSchema,
  CoreSearchWorkerSnapshot,
  CoreSearchProjectionStore,
  CoreSearchIngestion,
  ResourceContainmentRelationshipMutation,
  ownerResourceModuleContainment,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import type {
  CoreSearchProjectionDocument,
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
  OperationalScope,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { and, eq, inArray } from 'drizzle-orm';
import { Array as Arr, Effect, Match, Schema } from 'effect';
import { catalogHeads, products, productVariants, orders } from '../database/schema.ts';
import type { MerchandiseCommand } from '../../shared/actions/apply-command.ts';
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

/** Only trusted scope can choose the company; stale or foreign Core results fail closed. */
export const loadMerchandiseSearch = Effect.fn('Merchandise.loadSearch')(function* load<Ref, Encoded>(
  scope: OperationalScope,
  resource: 'product' | 'order',
  query: string,
  refSchema: Schema.Codec<Ref, Encoded>,
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
  return yield* Effect.forEach(
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
      return { ref, selectedLegalEntityId: hit.selectedLegalEntityId, title: hit.title };
    }),
    { concurrency: 1 },
  );
});

interface ProductRow {
  readonly active: boolean;
  readonly archived: boolean;
  readonly id: string;
  readonly legalEntityId: string;
  readonly name: string;
  readonly sku: string;
  readonly tenantId: string;
}
interface VariantRow {
  readonly active: boolean;
  readonly legalEntityId: string;
  readonly name: string;
  readonly productId: string;
  readonly sku: string | null;
  readonly tenantId: string;
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

export const buildMerchandiseSearchDocuments = Effect.fn('Merchandise.buildSearchDocuments')(function* build(
  snapshot: MerchandiseSearchSnapshot,
) {
  const variantTexts = new Map<string, string[]>();
  for (const variant of snapshot.variants) {
    if (!variant.active) {
      continue;
    }
    const key = `${variant.tenantId}:${variant.legalEntityId}:${variant.productId}`;
    const text = variantTexts.get(key) ?? [];
    text.push(variant.name);
    if (variant.sku !== null) {
      text.push(variant.sku);
    }
    variantTexts.set(key, text);
  }
  const rows = [
    ...snapshot.products.map((row) => ({
      ...row,
      archived: row.archived || !row.active,
      text: [row.name, row.sku, ...(variantTexts.get(`${row.tenantId}:${row.legalEntityId}:${row.id}`) ?? [])],
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

const readCompanySearch = Effect.fn('Merchandise.readCompanySearch')(function* readCompany(
  db: CoreSearchSnapshotReadExecutor,
  tenantId: string,
  legalEntityId: string,
  target?: RefreshTarget,
) {
  const [head] = yield* db
    .select({ bootstrapCheckpoint: catalogHeads.bootstrapCheckpoint })
    .from(catalogHeads)
    .where(and(eq(catalogHeads.tenantId, tenantId), eq(catalogHeads.legalEntityId, legalEntityId)))
    .limit(1);
  if (
    head === undefined ||
    (head.bootstrapCheckpoint !== null &&
      !Schema.is(Schema.Struct({ status: Schema.Literal('VERIFIED') }))(head.bootstrapCheckpoint))
  ) {
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
            sku: products.sku,
            tenantId: products.tenantId,
          })
          .from(products)
          .where(
            and(
              eq(products.tenantId, tenantId),
              eq(products.legalEntityId, legalEntityId),
              full ? undefined : inArray(products.id, target.productIds),
            ),
          );
  const variants =
    productRows.length === 0
      ? []
      : yield* db
          .select({
            active: productVariants.active,
            legalEntityId: productVariants.legalEntityId,
            name: productVariants.name,
            productId: productVariants.productId,
            sku: productVariants.sku,
            tenantId: productVariants.tenantId,
          })
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
            ),
          );
  if ([...productRows, ...orderRows].some((row) => row.tenantId !== tenantId || row.legalEntityId !== legalEntityId)) {
    return yield* unavailable();
  }
  return { orders: orderRows, products: productRows, variants };
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
  const containment = yield* ResourceContainmentRelationshipMutation;
  const relationships = yield* Effect.forEach(
    documents,
    (document) => {
      const relationship = ownerResourceModuleContainment(
        snapshot.tenantId,
        document.selectedLegalEntityId ?? '',
        document.ref,
      );
      return relationship === undefined ? Effect.fail(unavailable()) : Effect.succeed(relationship);
    },
    { concurrency: 1 },
  );
  yield* Effect.forEach(Arr.chunksOf(relationships, 100), (batch) => containment.touch({ relationships: batch }), {
    concurrency: 1,
    discard: true,
  });
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
      UpdateCategory: () => base,
      UpdateProduct: (value) => ({ ...base, productIds: [value.id] }),
    }),
  );
};
