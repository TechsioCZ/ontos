import { computeCanonicalValueHash } from '@app/core-runtime/actions/canonical-value-hash';
import type { LiveChange } from '@app/core-runtime/live/change-notification';
import { executeImportSourceCatalogWithAuthorization } from '@app/merchandise/apis/import-source-catalog-action/client';
import { CatalogVariantOnHandPageApi } from '@app/inventory/api/catalog-variant-on-hand-page';
import { ImportSourceCatalogPayloadSchema } from '@app/merchandise/contracts/import-source-catalog';
import { CatalogPagePricesApi, CatalogPagePricesRequestSchema } from '@app/pricing-contracts/catalog-page-prices';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import type { SymmyProductRows } from '@app/symmy-integration/symmy-internal-contracts';
import { Cause, Clock, Console, Context, Effect, Exit, Fiber, Layer, Redacted, Schema } from 'effect';
import { HttpClientError } from 'effect/http';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { LiveChangeHub } from '../live-changes/hub.ts';
import { symmyUnavailableProblem } from './contract.ts';
import { symmyDemoCatalogDigest, symmyDemoCatalogScopeIdentity } from './demo-catalog-identity.ts';
import { resolveSymmyOwnerReleaseBase } from './owner-release-transport.ts';
import { acquireSymmyReadAssertion, projectSymmySourceProducts } from './source-read-projections.ts';
import type { SymmySourceReadScope } from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';

// Every product the ERP connector Symmy holds in main Catalog is mirrored into demo.merchandise as an ordinary row of
// "Produkty" (and of the shop catalogue) with the mark "Importováno přes Symmy". The copy reads only the owners'
// accepted current state, never a request body: Catalog's source product page, Pricing's CURRENT base (no-group) net
// price of each Variant (catalog-page-prices) and Inventory's CURRENT on-hand (catalog-variant-on-hand-page), and
// writes through merchandise's source-catalog import (UpsertSourceProduct), which compares with the stored row: an
// unchanged product changes nothing. It runs beside the Symmy API, never inside a response: a failing copy is logged
// and retried by the next trigger, and no Symmy response, status code or job result depends on it.
// A products import or a stock import copies only the products it names, the moment their owners commit (targeted
// copies, below); full sweeps of every product after Symmy reads and job polls are the safety net.

const LOG = '[symmy-merchandise-copy]';
const PAGE = 100;
const importOperation = {
  entrypointKey: 'demo.merchandise.import-source-catalog',
  moduleId: 'demo.merchandise',
  schemaVersion: '1',
} as const;

type SourceProducts = Effect.Success<ReturnType<typeof projectSymmySourceProducts>>['products'];
type SourceProduct = SourceProducts[number];

/** The source code after the record kind and key name: `product:erpId:AKROS-10001` → `AKROS-10001`. */
export const symmySourceCode = (sourceRecordId: string): string =>
  sourceRecordId.slice(sourceRecordId.lastIndexOf(':') + 1).trim();

/** Pricing's current base net price (minor units) and Inventory's current on-hand of one Catalog Variant, when known. */
export interface SymmyVariantFigures {
  readonly priceNetMinor?: number;
  readonly stockOnHand?: number;
}

/**
 * The UpsertSourceProduct command of one Catalog product, or undefined when it has no source-correlated Variant.
 * A Variant without a known price sends none: the upsert keeps the stored price (and a never-priced row unpublished).
 */
export const symmyUpsertSourceProductCommand = (
  item: SourceProduct,
  figures: ReadonlyMap<string, SymmyVariantFigures> = new Map(),
) => {
  const erpCode = symmySourceCode(item.source_record_id).slice(0, 64);
  const name = (item.product.name ?? '').trim().slice(0, 200);
  const variants = item.variantSources.flatMap((variant) => {
    const sku = symmySourceCode(variant.source_record_id).slice(0, 64);
    if (sku === '') {
      return [];
    }
    const catalogVariantId = String(variant.variantId);
    const { priceNetMinor, stockOnHand } = figures.get(catalogVariantId) ?? {};
    return [
      {
        catalogVariantId,
        sku,
        ...(priceNetMinor === undefined ? {} : { priceNetMinor }),
        ...(stockOnHand === undefined ? {} : { stockOnHand }),
      },
    ];
  });
  if (erpCode === '' || name === '' || variants.length === 0) {
    return undefined;
  }
  const description = item.product.description?.trim();
  return {
    _tag: 'UpsertSourceProduct' as const,
    catalogProductId: String(item.product.productRef.resourceId),
    erpCode,
    lifecycle: item.product.lifecycle,
    name,
    sourceRecordId: item.source_record_id,
    // A shop product staff unlinked from Symmy links again only once the ERP changed the product after the unlink.
    sourceUpdatedAt: item.product.updatedAt,
    variants,
    ...(description === undefined || description === '' ? {} : { description: description.slice(0, 20_000) }),
  };
};

const newRequestIdentifier = Effect.sync(() => globalThis.crypto.randomUUID());

const readAllSourceProducts = Effect.fn('SymmyMerchandiseCopy.readAll')(function* readAll(
  scope: SymmySourceReadScope,
  admission: SymmyIngressAdmission,
) {
  const products: SourceProduct[] = [];
  for (let offset = 0; ; ) {
    const page = yield* projectSymmySourceProducts(scope, { limit: PAGE, offset }, admission, newRequestIdentifier);
    products.push(...page.products);
    offset += page.products.length;
    if (page.products.length === 0 || offset >= page.count) {
      return products;
    }
  }
});


/** Pricing's and Inventory's governed reads answer at most 100 Variants per page. */
const VARIANT_PAGE = 100;
type RouteContext = Effect.Success<ReturnType<NonNullable<SymmyIngressAdmission['acquireRouteAssertion']>>>['route'];
type CatalogRef = { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string; readonly tenantId: string };
const variantRefOf = (tenantId: string, variantId: string): CatalogRef => ({
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
});

// Pricing publishes no client for this read in a package the Shell may import; its exact HTTP shape, declared here.
const ExternalPriceSourceScopesApi = HttpApi.make('ExternalPriceSourceScopesApi').add(
  HttpApiGroup.make('externalPriceSourceScopes').add(
    HttpApiEndpoint.post('execute', '/reads/external-price-source-scopes', {
      payload: Schema.Struct({}),
      success: Schema.Struct({
        scopes: Schema.Array(
          Schema.Struct({
            channelId: Schema.Literals(['B2C', 'B2B']),
            currencyCode: Schema.String,
            marketId: Schema.String,
            unitId: Schema.String,
            unitQuantity: Schema.String,
          }),
        ),
      }),
    }),
  ),
);

/** Selects the route the next owner call is proved with (the admission proves owner calls with the LAST selection). */
const selectRoute = Effect.fn('SymmyMerchandiseCopy.selectRoute')(function* selectRoute(
  admission: SymmyIngressAdmission,
  routeKey: 'adminProducts' | 'inventoryStockBatch' | 'productsBatch',
) {
  if (admission.acquireRouteAssertion === undefined) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const selected = yield* admission.acquireRouteAssertion({ routeKey });
  if (selected.compositionRevision !== admission.compositionRevision) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return selected.route;
});

/** Decimal text of a PRE_TAX amount in the currency's major unit (`7.33`) to minor units (733), or undefined. */
const minorOf = (amount: string): number | undefined => {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(amount.trim());
  if (match === null) {
    return undefined;
  }
  const minor = Math.round(Number(`${match[1] ?? '0'}.${match[2] ?? '0'}`) * 100);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : undefined;
};

/**
 * The company's one standing base price key, or undefined (then no price is sent and stored prices stay). This read
 * and the two below are proved with the products route (adminProducts) the caller selected.
 */
const readPriceKey = Effect.fn('SymmyMerchandiseCopy.priceKey')(function* priceKey(
  admission: SymmyIngressAdmission,
  legalEntityId: string,
) {
  const assertion = yield* acquireSymmyReadAssertion(admission, 'pricing', legalEntityId);
  const client = yield* makeGovernedEffectBffClient(
    {
      api: ExternalPriceSourceScopesApi,
      credential: Redacted.make(`Bearer ${Redacted.value(assertion.assertion)}`),
      defaultApiPrefix: '/pricing-api',
      requestCorrelation: yield* newRequestIdentifier,
    },
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  );
  const { scopes } = yield* client.externalPriceSourceScopes.execute({ payload: {} });
  return scopes.length === 1 ? scopes[0] : undefined;
});

/** Pricing's current no-group net price of each Variant of one page, by Catalog Variant id (absent: no price). */
const readPricePage = Effect.fn('SymmyMerchandiseCopy.pricePage')(function* pricePage(
  admission: SymmyIngressAdmission,
  legalEntityId: string,
  key: NonNullable<Effect.Success<ReturnType<typeof readPriceKey>>>,
  items: readonly { readonly productRef: CatalogRef; readonly variantRef: CatalogRef }[],
) {
  const payload = yield* Schema.decodeUnknownEffect(CatalogPagePricesRequestSchema)({
    channelId: key.channelId,
    currencyCode: key.currencyCode,
    items: items.map(({ productRef, variantRef }) => ({
      catalogSelection: { productRef, variantRef },
      unitBasis: {
        quantity: key.unitQuantity,
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: key.unitId,
          resourceType: 'commerce.catalog.product-unit',
          tenantId: productRef.tenantId,
        },
      },
    })),
    marketId: key.marketId,
  });
  const assertion = yield* acquireSymmyReadAssertion(admission, 'pricing', legalEntityId);
  const client = yield* makeGovernedEffectBffClient(
    {
      api: CatalogPagePricesApi,
      credential: Redacted.make(`Bearer ${Redacted.value(assertion.assertion)}`),
      defaultApiPrefix: '/pricing-api',
      requestCorrelation: yield* newRequestIdentifier,
    },
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  );
  const answer = yield* client.catalogPagePrices.execute({ payload });
  if (answer._tag !== 'CATALOG_PAGE_PRICED') {
    return yield* Effect.fail(`catalog-page-prices answered ${answer._tag}`);
  }
  const prices = new Map<string, number>();
  for (const price of answer.prices) {
    if (price._tag === 'PRICE_FOUND' && price.priceRevision.monetaryAmount.currencyCode === key.currencyCode) {
      const minor = minorOf(price.priceRevision.monetaryAmount.amount);
      if (minor !== undefined) {
        prices.set(String(price.catalogSelection.variantRef.resourceId), minor);
      }
    }
  }
  return prices;
});

/** Inventory's current exact on-hand of each Variant of one page, by Catalog Variant id (absent: not known). */
const readOnHandPage = Effect.fn('SymmyMerchandiseCopy.onHandPage')(function* onHandPage(
  admission: SymmyIngressAdmission,
  legalEntityId: string,
  customerConfigurationId: string,
  variantRefs: readonly CatalogRef[],
) {
  const assertion = yield* acquireSymmyReadAssertion(admission, 'inventory', legalEntityId);
  const client = yield* makeGovernedEffectBffClient(
    {
      api: CatalogVariantOnHandPageApi,
      credential: Redacted.make(`Bearer ${Redacted.value(assertion.assertion)}`),
      defaultApiPrefix: '/inventory-api',
      requestCorrelation: yield* newRequestIdentifier,
    },
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  );
  const answer = yield* client.catalogVariantOnHandPage.execute({
    payload: { customerConfigurationId, variantRefs } as never,
  });
  const onHand = new Map<string, number>();
  for (const item of answer.items) {
    if (item.outcome === 'ON_HAND') {
      const total = Number(item.total.amount);
      if (Number.isFinite(total) && total >= 0) {
        onHand.set(String(item.variantRef.resourceId), total);
      }
    }
  }
  return onHand;
});

const describe = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).slice(0, 400);

/** An owner's refusal with its status and body (the refusal code), which an undeclared-status decode error drops. */
const describeRefusal = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  const response = HttpClientError.isHttpClientError(error) ? error.response : undefined;
  return response === undefined
    ? Effect.succeed(describe(cause))
    : response.text.pipe(
        Effect.map((body) => `${String(response.status)} ${body.slice(0, 600)} (${describe(cause).slice(0, 200)})`),
        Effect.orElseSucceed(() => describe(cause)),
      );
};

/**
 * The current price and on-hand of every Variant of the products, read page by page (a page's prices and on-hand at
 * once). A product whose price page failed is left out of the answer (`skipped`): it is not copied in this run
 * rather than sent without a price. Without a price key every product is copied without a price (the upsert keeps
 * stored prices); without an Inventory source, or when an on-hand page fails, its Variants' stock stays untouched.
 */
const readVariantFigures = Effect.fn('SymmyMerchandiseCopy.figures')(function* figures(
  admission: SymmyIngressAdmission,
  legalEntityId: string,
  products: SourceProducts,
  key: Effect.Success<ReturnType<typeof readPriceKey>>,
  source: RouteContext['inventorySource'],
) {
  const refs = products.flatMap((item) =>
    item.variantSources.map((variant) => ({
      productId: String(item.product.productRef.resourceId),
      productRef: item.product.productRef as CatalogRef,
      variantRef: variantRefOf(String(item.product.productRef.tenantId), String(variant.variantId)),
    })),
  );
  const figures = new Map<string, { priceNetMinor?: number; stockOnHand?: number }>();
  const skipped = new Set<string>();
  let stocked = true;
  for (let offset = 0; offset < refs.length; offset += VARIANT_PAGE) {
    const page = refs.slice(offset, offset + VARIANT_PAGE);
    const [prices, onHand] = yield* Effect.all(
      [
        key === undefined
          ? Effect.succeed(new Map<string, number>())
          : readPricePage(admission, legalEntityId, key, page).pipe(
              Effect.catchCause((cause) =>
                describeRefusal(cause).pipe(
                  Effect.flatMap((text) =>
                    Console.error(`${LOG} prices unreadable, ${String(page.length)} variants skipped: ${text}`),
                  ),
                  Effect.as(undefined),
                ),
              ),
            ),
        source === undefined
          ? Effect.succeed(new Map<string, number>())
          : readOnHandPage(
              admission,
              legalEntityId,
              String(source.customerConfigurationId),
              page.map(({ variantRef }) => variantRef),
            ).pipe(
              Effect.catchCause((cause) =>
                describeRefusal(cause).pipe(
                  Effect.flatMap((text) => Console.error(`${LOG} on-hand unreadable, stock kept: ${text}`)),
                  Effect.as(undefined),
                ),
              ),
            ),
      ],
      { concurrency: 2 },
    );
    if (prices === undefined) {
      for (const { productId } of page) {
        skipped.add(productId);
      }
    }
    for (const [variantId, priceNetMinor] of prices ?? []) {
      figures.set(variantId, { ...figures.get(variantId), priceNetMinor });
    }
    if (onHand === undefined) {
      stocked = false;
    }
    for (const [variantId, stockOnHand] of onHand ?? []) {
      figures.set(variantId, { ...figures.get(variantId), stockOnHand });
    }
  }
  return { figures, priced: key !== undefined, skipped, stocked: source !== undefined && stocked };
});

/** The Inventory configuration of the company's Symmy stock: on the products route, else on the stock route. */
const readInventorySource = Effect.fn('SymmyMerchandiseCopy.inventorySource')(function* inventorySource(
  admission: SymmyIngressAdmission,
  read: RouteContext,
) {
  if (read.inventorySource !== undefined) {
    return read.inventorySource;
  }
  const source = yield* selectRoute(admission, 'inventoryStockBatch').pipe(
    Effect.map((route: RouteContext) => route.inventorySource),
    Effect.catchCause(() => Effect.succeed(undefined)),
  );
  // The reads after this one are proved with the products route again.
  yield* selectRoute(admission, 'adminProducts');
  return source;
});

const upsert = Effect.fn('SymmyMerchandiseCopy.upsert')(function* upsertOne(
  scope: SymmySourceReadScope & { readonly legalEntityId: string },
  admission: SymmyIngressAdmission,
  command: NonNullable<ReturnType<typeof symmyUpsertSourceProductCommand>>,
  runId: string,
) {
  if (admission.acquireOwnerAssertion === undefined) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const sourceRequestDigest = computeCanonicalValueHash(command);
  const payload = yield* Schema.decodeUnknownEffect(ImportSourceCatalogPayloadSchema)({
    command,
    expectedRevision: 0,
    sourceRequestDigest,
  }).pipe(Effect.mapError(() => symmyUnavailableProblem));
  const assertion = yield* admission.acquireOwnerAssertion({
    audience: 'merchandise',
    legalEntityId: scope.legalEntityId,
  });
  if (assertion.compositionRevision !== admission.compositionRevision) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const baseUrl = yield* resolveSymmyOwnerReleaseBase(assertion.apiBaseUrl, 'merchandise');
  // One key per copy run and command: a retry inside the run is the owner's replay, while a later run always reaches
  // the upsert (which answers UNCHANGED without writing), so a return to an earlier value (A → B → A) is applied.
  const idempotencyKey = yield* symmyDemoCatalogDigest(
    JSON.stringify([yield* symmyDemoCatalogScopeIdentity(scope), 'merchandise-copy-v2', runId, sourceRequestDigest]),
  );
  const result = yield* executeImportSourceCatalogWithAuthorization(
    payload,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    { baseUrl, compositionRevision: assertion.compositionRevision, idempotencyKey },
  );
  // The import's result names what the upsert did (sourceUpsert.outcome); an older owner answers without it.
  const answer = (result as { readonly sourceUpsert?: { readonly outcome?: unknown; readonly reason?: unknown } })
    .sourceUpsert;
  return {
    outcome: typeof answer?.outcome === 'string' ? answer.outcome : 'APPLIED',
    reason: typeof answer?.reason === 'string' ? answer.reason : undefined,
  };
});

/** The source value of a qualified source record id: `variant:variantId:AKROS-1-V1` → `AKROS-1-V1`. */
const sourceValueOf = (recordId: string): string => recordId.split(':').slice(2).join(':').trim();

/** The product is named by `codes`: its own source value, or the source value of one of its Variants, is among them. */
const namedBy = (item: SourceProduct, codes: ReadonlySet<string>): boolean =>
  codes.has(sourceValueOf(item.source_record_id)) ||
  item.variantSources.some((variant) => codes.has(sourceValueOf(variant.source_record_id)));

/** The source codes a products import names: each product's identifier, each Variant's identifier and SKU. */
export const symmyProductBatchCodes = (products: SymmyProductRows): readonly string[] =>
  products.flatMap((product) => [
    ...(product.identifier === undefined ? [] : [product.identifier.value]),
    ...product.variants.flatMap((variant) => [
      ...(variant.identifier === undefined ? [] : [variant.identifier.value]),
      ...(variant.sku === undefined ? [] : [String(variant.sku)]),
    ]),
  ]);

/** When the newest targeted copy of each Catalog product began reading its Pricing and Inventory figures (epoch ms). */
const targetedFiguresAt = new Map<string, number>();

/**
 * What one copy writes, read from the owners: the products (every one, or with `only` those named by one of the
 * codes) and the current figures of their Variants. Undefined when the route is not enrolled for the merchandise
 * import or has no company.
 */
const readCopyPlan = Effect.fn('SymmyMerchandiseCopy.read')(function* readPlan(
  admission: SymmyIngressAdmission,
  only: ReadonlySet<string> | undefined,
) {
  // The admission proves owner calls with the route selected last: productsBatch (enrollment), then adminProducts for
  // every read (Catalog's products and Pricing's price key at once, then each page's prices and on-hand at once).
  const write = yield* selectRoute(admission, 'productsBatch');
  const { legalEntityId } = write;
  const enrolled = write.allowedOwnerOperations.some(
    (operation) =>
      operation.moduleId === importOperation.moduleId &&
      operation.entrypointKey === importOperation.entrypointKey &&
      operation.schemaVersion === importOperation.schemaVersion,
  );
  if (legalEntityId === undefined || !enrolled) {
    return undefined;
  }
  const read = yield* selectRoute(admission, 'adminProducts');
  if (read.tenantId !== write.tenantId) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const source = yield* readInventorySource(admission, read);
  const [all, key] = yield* Effect.all(
    [
      readAllSourceProducts(read, admission),
      readPriceKey(admission, legalEntityId).pipe(
        Effect.catchCause((cause) =>
          describeRefusal(cause).pipe(
            Effect.flatMap((text) => Console.error(`${LOG} price key unreadable, no prices sent: ${text}`)),
            Effect.as(undefined),
          ),
        ),
      ),
    ],
    { concurrency: 2 },
  );
  const products = only === undefined ? all : all.filter((item) => namedBy(item, only));
  const figuresAt = yield* Clock.currentTimeMillis;
  if (only !== undefined) {
    for (const item of products) {
      targetedFiguresAt.set(String(item.product.productRef.resourceId), figuresAt);
    }
  }
  const figures = yield* readVariantFigures(admission, legalEntityId, products, key, source);
  return { ...figures, figuresAt, legalEntityId, products, write };
});

/**
 * Copies the source-correlated Catalog products of the admitted Symmy route into the route's company's
 * demo.merchandise store, with Pricing's current base net price and Inventory's current on-hand of each Variant:
 * every product (a full sweep), or with `only` the products named by one of those source codes (a targeted copy).
 * A route not enrolled for the merchandise import (or without a company) copies nothing. Answers the count per
 * outcome; one product's failure is logged and the others still run. Only the reads can be interrupted (a targeted
 * copy then starts over); once the writes begin they finish.
 */
export const copySymmyProductsToMerchandise = Effect.fn('SymmyMerchandiseCopy.copy')(function* copy(
  admission: SymmyIngressAdmission,
  only?: ReadonlySet<string>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const plan = yield* Effect.interruptible(readCopyPlan(admission, only));
  if (plan === undefined) {
    return { skipped: 'not_enrolled' } as const;
  }
  const { figures, figuresAt, legalEntityId, priced, products, skipped, stocked, write } = plan;
  // The writes are proved with the products import route.
  yield* selectRoute(admission, 'productsBatch');
  const outcomes: Record<string, number> = { CREATED: 0, UPDATED: 0, UNCHANGED: 0, REFUSED: 0 };
  const refused: string[] = [];
  const unpriced: string[] = [];
  const runId = yield* newRequestIdentifier;
  for (const item of products) {
    const code = symmySourceCode(item.source_record_id);
    // A full sweep never writes over a targeted copy that read the owners after it did: those figures are newer.
    if (only === undefined && (targetedFiguresAt.get(String(item.product.productRef.resourceId)) ?? 0) >= figuresAt) {
      outcomes['SUPERSEDED'] = (outcomes['SUPERSEDED'] ?? 0) + 1;
      continue;
    }
    const command = skipped.has(String(item.product.productRef.resourceId))
      ? undefined
      : symmyUpsertSourceProductCommand(item, figures);
    // A product whose price page failed is not written in this sweep. One without a price is still sent: the upsert
    // never creates a row without a price (never a row at 0 Kč), but an existing row keeps taking its stock figure.
    const withoutPrice = command !== undefined && command.variants.some((variant) => variant.priceNetMinor === undefined);
    if (command === undefined || withoutPrice) {
      unpriced.push(code);
    }
    const result =
      command === undefined
        ? { outcome: 'SKIPPED', reason: undefined }
        : yield* upsert({ ...write, legalEntityId }, admission, command, runId).pipe(
            Effect.catchCause((cause) =>
              Console.error(`${LOG} ${item.source_record_id} failed: ${describe(cause)}`).pipe(
                Effect.as({ outcome: 'FAILED', reason: undefined }),
              ),
            ),
          );
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
    if (result.outcome === 'REFUSED') {
      refused.push(`${code}:${result.reason ?? 'unknown'}`);
    }
  }
  const run = only === undefined ? 'full' : `targeted=[${[...only].slice(0, 20).join(', ')}]`;
  const ms = (yield* Clock.currentTimeMillis) - startedAt;
  yield* Console.log(
    `${LOG} company=${legalEntityId} ${run} products=${String(products.length)} ms=${String(ms)} ${JSON.stringify({ ...outcomes, priced, stocked })}` +
      ` refused=[${refused.join(', ')}] withoutPrice=[${unpriced.join(', ')}]`,
  );
  return { outcomes } as const;
});

/**
 * Full sweeps: one at a time per process; triggers that arrive meanwhile coalesce into one more run with the newest
 * admission, after a pause. The admission is a self-contained capability (API key, the request's correlation headers
 * and the services it needs are held by its closures; every owner call re-verifies the key and mints a fresh
 * assertion), so a run after the response, or seconds later, still proves its calls. Whatever ends a run (failure,
 * defect, interruption) is logged and frees the queue.
 */
const state: { pending: SymmyIngressAdmission | undefined; running: boolean } = {
  pending: undefined,
  running: false,
};
const COOL_DOWN = '10 seconds';

const drain: Effect.Effect<void> = Effect.suspend(() => {
  const next = state.pending;
  state.pending = undefined;
  if (next === undefined) {
    state.running = false;
    return Effect.void;
  }
  return copySymmyProductsToMerchandise(next).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Console.error(`${LOG} copy failed: ${describe(cause)}`)),
    Effect.andThen(Effect.sleep(COOL_DOWN)),
    Effect.andThen(drain),
  );
}).pipe(
  Effect.onInterrupt(() =>
    Console.error(`${LOG} copy interrupted; the next trigger runs it again`).pipe(
      Effect.andThen(
        Effect.sync(() => {
          state.running = false;
        }),
      ),
    ),
  ),
);

/**
 * Schedules a full sweep after an authenticated Symmy request that can reveal catalogue, price or stock state (reads,
 * job polls): the safety net for whatever a targeted copy missed. Never fails and never waits: the request's response
 * is unchanged whatever the copy does.
 */
export const scheduleSymmyMerchandiseCopy = (admission: SymmyIngressAdmission): Effect.Effect<void> =>
  Effect.suspend(() => {
    state.pending = admission;
    if (state.running) {
      return Effect.void;
    }
    state.running = true;
    return Effect.forkDetach(drain).pipe(Effect.asVoid);
  }).pipe(Effect.catchCause((cause) => Console.error(`${LOG} copy not scheduled: ${describe(cause)}`)));

/**
 * Targeted copies: only the products a Symmy import names, started the moment their owners commit (a products job)
 * or the import answers (stock), with no pause in front and never queued behind a full sweep. One run at a time per
 * process; the codes a company names meanwhile merge into its next run, which starts as soon as the running one
 * ends. A run still reading when more codes of its company arrive starts over at once with them (within
 * RESTART_WINDOW_MS of its first start, so a company that commits all the time still gets its copy); writes always
 * finish. A run is given the services of the Symmy request that named its codes (the owner relay's fetch among them).
 */
interface Targets {
  readonly admission: SymmyIngressAdmission;
  readonly codes: ReadonlySet<string>;
  readonly context: Context.Context<never>;
  /** When the first run for these codes began; a restart keeps it. */
  readonly since: number;
}
interface TargetedRun {
  readonly company: string;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
  readonly targets: Targets;
}
const targeted: { current: TargetedRun | undefined; readonly pending: Map<string, Targets>; running: boolean } = {
  current: undefined,
  pending: new Map(),
  running: false,
};
const RESTART_WINDOW_MS = 3_000;

const drainTargeted: Effect.Effect<void> = Effect.suspend(() => {
  const next = targeted.pending.entries().next();
  if (next.done === true) {
    targeted.running = false;
    return Effect.void;
  }
  const [company, targets] = next.value;
  targeted.pending.delete(company);
  return copySymmyProductsToMerchandise(targets.admission, targets.codes).pipe(
    Effect.uninterruptible,
    Effect.provideContext(targets.context),
    Effect.forkChild,
    Effect.flatMap((fiber) => {
      targeted.current = { company, fiber, targets };
      return Fiber.await(fiber);
    }),
    Effect.flatMap((exit) => {
      targeted.current = undefined;
      return Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Console.error(`${LOG} targeted copy failed: ${describe(exit.cause)}`)
        : Effect.void;
    }),
    Effect.andThen(drainTargeted),
  );
}).pipe(
  Effect.onInterrupt(() =>
    Console.error(`${LOG} targeted copy interrupted; the next import runs it again`).pipe(
      Effect.andThen(
        Effect.sync(() => {
          targeted.current = undefined;
          targeted.running = false;
        }),
      ),
    ),
  ),
);

/** Adds the codes to the company's next targeted run, restarting its run still reading, and starts the runs. */
const copyTargets = (company: string, targets: Omit<Targets, 'since'>): Effect.Effect<void> =>
  Effect.suspend(() => {
    const now = Date.now();
    const run = targeted.current;
    const restarted =
      run !== undefined && run.company === company && now - run.targets.since < RESTART_WINDOW_MS ? run : undefined;
    const pending = targeted.pending.get(company);
    targeted.pending.set(company, {
      ...targets,
      codes: new Set([...(restarted?.targets.codes ?? []), ...(pending?.codes ?? []), ...targets.codes]),
      since: restarted?.targets.since ?? pending?.since ?? now,
    });
    // Interrupts only the reads: a run already writing ends first, then its codes run again with the new ones.
    const restart = restarted === undefined ? Effect.void : Effect.forkDetach(Fiber.interrupt(restarted.fiber));
    if (targeted.running) {
      return Effect.asVoid(restart);
    }
    targeted.running = true;
    return Effect.forkDetach(drainTargeted).pipe(Effect.asVoid);
  });

/** The company the admitted route copies into ("tenant|legal entity"), or undefined when it has none. */
const companyOf = Effect.fn('SymmyMerchandiseCopy.company')(function* company(admission: SymmyIngressAdmission) {
  const route = yield* selectRoute(admission, 'productsBatch');
  return route.legalEntityId === undefined
    ? undefined
    : {
        key: `${String(route.tenantId)}|${String(route.legalEntityId)}`,
        legalEntityId: String(route.legalEntityId),
        tenantId: String(route.tenantId),
      };
});

/**
 * The products of accepted products imports, watched per company for WATCH_MS after each import: every commit of
 * Catalog, Pricing or Inventory for the company copies them at once, so the import's own commits (each owner commits
 * its effect, the last one included) reach "Produkty" as they land, whether or not anyone polls the job.
 */
interface Watch {
  readonly admission: SymmyIngressAdmission;
  /** Each watched code until when (epoch ms). */
  readonly codes: Map<string, number>;
  readonly context: Context.Context<never>;
  readonly legalEntityId: string;
  readonly tenantId: string;
}
const watches = new Map<string, Watch>();
/** The newest owner commit seen per tenant (epoch ms). */
const ownerCommitAt = new Map<string, number>();
const OWNER_MODULES: ReadonlySet<string> = new Set(['commerce.catalog', 'commerce.inventory', 'commerce.pricing']);
const WATCH_MS = 120_000;

/** Copies the watched products of every company `concerns` names, dropping codes watched long enough. */
const copyWatched = (concerns: (watch: Watch) => boolean): Effect.Effect<void> =>
  Effect.suspend(() => {
    const now = Date.now();
    const due: [string, Watch][] = [];
    for (const [company, watch] of watches) {
      for (const [code, until] of watch.codes) {
        if (until <= now) {
          watch.codes.delete(code);
        }
      }
      if (watch.codes.size === 0) {
        watches.delete(company);
      } else if (concerns(watch)) {
        due.push([company, watch]);
      }
    }
    return Effect.forEach(
      due,
      ([company, { admission, codes, context }]) => copyTargets(company, { admission, codes: new Set(codes.keys()), context }),
      { discard: true },
    );
  });

/** A committed change: a Catalog, Pricing or Inventory commit of a company copies its watched products. */
const copyOnOwnerCommit = (change: LiveChange): Effect.Effect<void> =>
  change.moduleKeys.some((key) => OWNER_MODULES.has(key))
    ? Effect.suspend(() => {
        ownerCommitAt.set(change.tenantId, Date.now());
        return copyWatched(
          (watch) =>
            watch.tenantId === change.tenantId &&
            (change.legalEntityId === null || change.legalEntityId === watch.legalEntityId),
        );
      })
    : Effect.void;

/**
 * Feeds every committed change to the targeted copies for as long as the Shell runs; after a lost change tail (changes
 * may have been missed) every watched product is copied again.
 */
const follower = { active: false };
export const SymmyMerchandiseCopyLive = Layer.effectDiscard(
  Effect.gen(function* followOwnerCommits() {
    const hub = yield* LiveChangeHub;
    // One follower per process: another Shell runtime of the process (the root route handler) adds none, so a commit
    // starts one copy.
    const first = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (follower.active) {
          return false;
        }
        follower.active = true;
        return true;
      }),
      (owned) =>
        Effect.sync(() => {
          if (owned) {
            follower.active = false;
          }
        }),
    );
    if (first) {
      yield* Effect.forkScoped(hub.follow({ publish: copyOnOwnerCommit, resetAll: copyWatched(() => true) }));
    }
  }),
);

/**
 * After an accepted products import: its products are watched (see Watch), so they are copied the moment their owners
 * commit the job's effects. Never fails and never waits.
 */
export const copySymmyProductsOnCommit = (admission: SymmyIngressAdmission, codes: readonly string[]): Effect.Effect<void> =>
  Effect.gen(function* watchImport() {
    if (codes.length === 0) {
      return;
    }
    const at = yield* Clock.currentTimeMillis;
    const context = yield* Effect.context<never>();
    const company = yield* companyOf(admission);
    if (company === undefined) {
      return;
    }
    const watched = new Map(watches.get(company.key)?.codes);
    for (const code of codes) {
      watched.set(code, at + WATCH_MS);
    }
    watches.set(company.key, { ...company, admission, codes: watched, context });
    // A commit of the job that landed while the route was being read is not missed.
    if ((ownerCommitAt.get(company.tenantId) ?? 0) >= at) {
      yield* copyTargets(company.key, { admission, codes: new Set(codes), context });
    }
  }).pipe(
    Effect.catchCause((cause) => Console.error(`${LOG} targeted copy not scheduled: ${describe(cause)}`)),
    Effect.forkDetach,
    Effect.asVoid,
  );

/** After an accepted stock import: the products of its items are copied at once. Never fails and never waits. */
export const copySymmyStockToMerchandise = (admission: SymmyIngressAdmission, itemKeys: readonly string[]): Effect.Effect<void> =>
  Effect.gen(function* copyStock() {
    if (itemKeys.length === 0) {
      return;
    }
    const context = yield* Effect.context<never>();
    const company = yield* companyOf(admission);
    if (company !== undefined) {
      yield* copyTargets(company.key, { admission, codes: new Set(itemKeys), context });
    }
  }).pipe(
    Effect.catchCause((cause) => Console.error(`${LOG} targeted copy not scheduled: ${describe(cause)}`)),
    Effect.forkDetach,
    Effect.asVoid,
  );
