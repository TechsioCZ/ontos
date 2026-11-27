import { computeCanonicalValueHash } from '@app/core-runtime/actions/canonical-value-hash';
import { executeImportSourceCatalogWithAuthorization } from '@app/merchandise/apis/import-source-catalog-action/client';
import { CatalogVariantOnHandPageApi } from '@app/inventory/api/catalog-variant-on-hand-page';
import { ImportSourceCatalogPayloadSchema } from '@app/merchandise/contracts/import-source-catalog';
import { CatalogPagePricesApi, CatalogPagePricesRequestSchema } from '@app/pricing-contracts/catalog-page-prices';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Cause, Console, Effect, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
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

/** The company's one standing base price key, or undefined (then no price is sent and stored prices stay). */
const readPriceKey = Effect.fn('SymmyMerchandiseCopy.priceKey')(function* priceKey(
  admission: SymmyIngressAdmission,
  legalEntityId: string,
) {
  yield* selectRoute(admission, 'adminProducts');
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
  yield* selectRoute(admission, 'adminProducts');
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
  yield* selectRoute(admission, 'adminProducts');
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

/**
 * The current price and on-hand of every Variant of the products, read page by page. A product whose price page
 * failed is left out of the answer (`skipped`): it is not copied in this sweep rather than sent without a price.
 * Without a price key every product is copied without a price (the upsert keeps stored prices); a failed on-hand
 * page only leaves its Variants' stock untouched.
 */
const readVariantFigures = Effect.fn('SymmyMerchandiseCopy.figures')(function* figures(
  admission: SymmyIngressAdmission,
  legalEntityId: string,
  products: SourceProducts,
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
  const key = yield* readPriceKey(admission, legalEntityId).pipe(
    Effect.catchCause((cause) =>
      Console.error(`${LOG} price key unreadable, no prices sent: ${describe(cause)}`).pipe(Effect.as(undefined)),
    ),
  );
  // The Inventory configuration of the company's Symmy stock: on the products route, else on the stock route.
  const ownSource = (yield* selectRoute(admission, 'adminProducts')).inventorySource;
  const source =
    ownSource ??
    (yield* selectRoute(admission, 'inventoryStockBatch').pipe(
      Effect.map((route: RouteContext) => route.inventorySource),
      Effect.catchCause(() => Effect.succeed(undefined)),
    ));
  for (let offset = 0; offset < refs.length; offset += VARIANT_PAGE) {
    const page = refs.slice(offset, offset + VARIANT_PAGE);
    if (key !== undefined) {
      const prices = yield* readPricePage(admission, legalEntityId, key, page).pipe(
        Effect.catchCause((cause) =>
          Console.error(`${LOG} prices unreadable, ${String(page.length)} variants skipped: ${describe(cause)}`).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      if (prices === undefined) {
        for (const { productId } of page) {
          skipped.add(productId);
        }
      }
      for (const [variantId, priceNetMinor] of prices ?? []) {
        figures.set(variantId, { ...figures.get(variantId), priceNetMinor });
      }
    }
    if (source !== undefined) {
      const onHand = yield* readOnHandPage(
        admission,
        legalEntityId,
        String(source.customerConfigurationId),
        page.map(({ variantRef }) => variantRef),
      ).pipe(
        Effect.catchCause((cause) =>
          Console.error(`${LOG} on-hand unreadable, stock kept: ${describe(cause)}`).pipe(Effect.as(new Map<string, number>())),
        ),
      );
      for (const [variantId, stockOnHand] of onHand) {
        figures.set(variantId, { ...figures.get(variantId), stockOnHand });
      }
    }
  }
  return { figures, priced: key !== undefined, skipped };
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
  const outcome: unknown = (result as { readonly sourceUpsert?: { readonly outcome?: unknown } }).sourceUpsert?.outcome;
  return typeof outcome === 'string' ? outcome : 'APPLIED';
});

/**
 * Copies every source-correlated Catalog product of the admitted Symmy route into the route's company's
 * demo.merchandise store, with Pricing's current base net price and Inventory's current on-hand of each Variant.
 * A route not enrolled for the merchandise import (or without a company) copies nothing. Answers the count per
 * outcome; one product's failure is logged and the others still run.
 */
export const copySymmyProductsToMerchandise = Effect.fn('SymmyMerchandiseCopy.copyAll')(function* copyAll(
  admission: SymmyIngressAdmission,
) {
  // The admission proves owner calls with the route selected last, so each owner call selects its route first:
  // productsBatch (enrollment), adminProducts (Catalog, Pricing, Inventory reads), productsBatch again (the writes).
  const write = yield* selectRoute(admission, 'productsBatch');
  const { legalEntityId } = write;
  const enrolled = write.allowedOwnerOperations.some(
    (operation) =>
      operation.moduleId === importOperation.moduleId &&
      operation.entrypointKey === importOperation.entrypointKey &&
      operation.schemaVersion === importOperation.schemaVersion,
  );
  if (legalEntityId === undefined || !enrolled) {
    return { skipped: 'not_enrolled' } as const;
  }
  const read = yield* selectRoute(admission, 'adminProducts');
  if (read.tenantId !== write.tenantId) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const products = yield* readAllSourceProducts(read, admission);
  const { figures, priced, skipped } = yield* readVariantFigures(admission, legalEntityId, products);
  yield* selectRoute(admission, 'productsBatch');
  const outcomes: Record<string, number> = {};
  const runId = yield* newRequestIdentifier;
  for (const item of products) {
    const command = skipped.has(String(item.product.productRef.resourceId))
      ? undefined
      : symmyUpsertSourceProductCommand(item, figures);
    const outcome =
      command === undefined
        ? 'SKIPPED'
        : yield* upsert({ ...write, legalEntityId }, admission, command, runId).pipe(
            Effect.catchCause((cause) =>
              Console.error(`${LOG} ${item.source_record_id} failed: ${describe(cause)}`).pipe(Effect.as('FAILED')),
            ),
          );
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  yield* Console.log(
    `${LOG} company=${legalEntityId} products=${String(products.length)} priced=${String(priced)} ${JSON.stringify(outcomes)}`,
  );
  return { outcomes } as const;
});

/**
 * One copy at a time per process; triggers that arrive meanwhile coalesce into one more run with the newest admission.
 * The admission is a self-contained capability (API key, the request's correlation headers and the services it needs
 * are held by its closures; every owner call re-verifies the key and mints a fresh assertion), so a sweep that runs
 * after the response, or seconds later, still proves its calls. Whatever ends a run (failure, defect, interruption)
 * is logged and frees the queue.
 */
const state: { pending: SymmyIngressAdmission | undefined; running: boolean } = {
  pending: undefined,
  running: false,
};
const COOL_DOWN = '10 seconds';
/** Gaps (ms) of the sweeps after an accepted job submit: about 5, 20 and 60 seconds after it. */
const AFTER_SUBMIT_GAPS = [5_000, 15_000, 40_000] as const;

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
 * Schedules the copy after an authenticated Symmy request that can change or reveal catalogue, price or stock state.
 * Never fails and never waits: the request's response is unchanged whatever the copy does.
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
 * After an accepted job submit (products, prices): the copy now and again about 5, 20 and 60 seconds later, so a
 * job that completes without being polled is still copied. Never fails and never waits.
 */
export const scheduleSymmyMerchandiseCopyAfterSubmit = (admission: SymmyIngressAdmission): Effect.Effect<void> =>
  scheduleSymmyMerchandiseCopy(admission).pipe(
    Effect.andThen(
      Effect.forkDetach(
        Effect.forEach(
          AFTER_SUBMIT_GAPS,
          (gap) => Effect.sleep(gap).pipe(Effect.andThen(scheduleSymmyMerchandiseCopy(admission))),
          { discard: true },
        ),
      ),
    ),
    Effect.asVoid,
    Effect.catchCause((cause) => Console.error(`${LOG} delayed copy not scheduled: ${describe(cause)}`)),
  );
