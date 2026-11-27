import { computeCanonicalValueHash } from '@app/core-runtime/actions/canonical-value-hash';
import type { LiveChange } from '@app/core-runtime/live/change-notification';
import { executeImportSourceCatalogWithAuthorization } from '@app/merchandise/apis/import-source-catalog-action/client';
import {
  CatalogVariantOnHandPageApi,
  CatalogVariantOnHandPageRequestSchema,
} from '@app/inventory/api/catalog-variant-on-hand-page';
import { ImportSourceCatalogPayloadSchema } from '@app/merchandise/contracts/import-source-catalog';
import { CatalogPagePricesApi, CatalogPagePricesRequestSchema } from '@app/pricing-contracts/catalog-page-prices';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import type { SymmyProductRows } from '@app/symmy-integration/symmy-internal-contracts';
import { SymmyJobStatusRequestSchema } from '@app/symmy-integration/api/symmy-job-status';
import { executeSymmyJobStatusWithAuthorization } from '@app/symmy-integration/api/symmy-job-status/client';
import {
  Array as EffectArray,
  Cause,
  Clock,
  Console,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Redacted,
  Ref,
  Schema,
} from 'effect';
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
// copies, below); full sweeps of every product after Symmy reads and job polls, at most one a minute, are the safety net.

const LOG = '[symmy-merchandise-copy]';
const PAGE = 100;
const CATALOG_MODULE_ID = 'commerce.catalog';
const importOperation = {
  entrypointKey: 'demo.merchandise.import-source-catalog',
  moduleId: 'demo.merchandise',
  schemaVersion: '1',
} as const;

type SourceProducts = Effect.Success<ReturnType<typeof projectSymmySourceProducts>>['products'];
type SourceProduct = SourceProducts[number];
type UpsertCommand = Extract<
  typeof ImportSourceCatalogPayloadSchema.Encoded.command,
  { readonly _tag: 'UpsertSourceProduct' }
>;

/** The source code after the record kind and key name: `product:erpId:AKROS-10001` → `AKROS-10001`. */
export const symmySourceCode = (sourceRecordId: string): string =>
  sourceRecordId.slice(sourceRecordId.lastIndexOf(':') + 1).trim();

/** Pricing's current base net price (minor units) and Inventory's current on-hand of one Catalog Variant, when known. */
export interface SymmyVariantFigures {
  readonly priceNetMinor?: number;
  readonly stockOnHand?: number;
}

/**
 * The shop name of one of several Variants: its Czech source name. A Variant is always shown under its product, so a
 * name that repeats the product's name ("Vrut … A2 4 x 40") keeps only what tells the Variant apart ("4 x 40"). The SKU
 * stays the Variant's code beside it. A product with one Variant is the Variant itself and sends no Variant name.
 */
export const symmyVariantName = (productName: string, sourceName: string | undefined): string | undefined => {
  const full = sourceName?.trim() ?? '';
  const rest =
    productName !== '' && full.startsWith(productName)
      ? full.slice(productName.length).replace(/^[\s,;:–-]+/u, '')
      : full;
  const name = (rest === '' ? full : rest).slice(0, 100).trim();
  return name === '' ? undefined : name;
};

/**
 * The UpsertSourceProduct command of one Catalog product, or undefined when it has no source-correlated Variant.
 * A Variant without a known price sends none: the upsert keeps the stored price (and a never-priced row unpublished).
 */
export const symmyUpsertSourceProductCommand = (
  item: SourceProduct,
  figures: ReadonlyMap<string, SymmyVariantFigures> = new Map(),
): UpsertCommand | undefined => {
  const erpCode = symmySourceCode(item.source_record_id).slice(0, 64);
  const name = (item.product.name ?? '').trim().slice(0, 200);
  const variants = item.variantSources.flatMap((variant) => {
    const sku = symmySourceCode(variant.source_record_id).slice(0, 64);
    if (sku === '') {
      return [];
    }
    const catalogVariantId = variant.variantId;
    const { priceNetMinor, stockOnHand } = figures.get(catalogVariantId) ?? {};
    const variantName =
      item.variantSources.length > 1
        ? symmyVariantName(name, variant.localizedNames?.find(({ locale }) => /^cs(?:-|$)/iu.test(locale))?.name)
        : undefined;
    const fields = variantName === undefined ? { catalogVariantId, sku } : { catalogVariantId, name: variantName, sku };
    const priced = priceNetMinor === undefined ? fields : { ...fields, priceNetMinor };
    return [stockOnHand === undefined ? priced : { ...priced, stockOnHand }];
  });
  if (erpCode === '' || name === '' || variants.length === 0) {
    return undefined;
  }
  const description = item.product.description?.trim();
  const command: UpsertCommand = {
    _tag: 'UpsertSourceProduct',
    catalogProductId: item.product.productRef.resourceId,
    erpCode,
    lifecycle: item.product.lifecycle,
    name,
    sourceRecordId: item.source_record_id,
    // A shop product staff unlinked from Symmy links again only once the ERP changed the product after the unlink.
    sourceUpdatedAt: item.product.updatedAt,
    variants,
  };
  return description === undefined || description === ''
    ? command
    : { ...command, description: description.slice(0, 20_000) };
};

const newRequestIdentifier = (admission: SymmyIngressAdmission) =>
  admission.newRequestIdentifier ?? Effect.fail(symmyUnavailableProblem);

interface SourcePageState {
  readonly done: boolean;
  readonly offset: number;
  readonly products: SourceProduct[];
}
const readAllSourceProducts = (scope: SymmySourceReadScope, admission: SymmyIngressAdmission) =>
  Effect.suspend(() => {
    let cursor: SourcePageState = { done: false, offset: 0, products: [] };
    return Effect.whileLoop({
      body: () =>
        projectSymmySourceProducts(
          scope,
          { limit: PAGE, offset: cursor.offset },
          admission,
          newRequestIdentifier(admission),
        ),
      step: (page) => {
        cursor.products.push(...page.products);
        const offset = cursor.offset + page.products.length;
        cursor = { done: page.products.length === 0 || offset >= page.count, offset, products: cursor.products };
      },
      while: () => !cursor.done,
    }).pipe(Effect.map(() => cursor.products));
  });

/** Pricing's and Inventory's governed reads answer at most 100 Variants per page. */
const VARIANT_PAGE = 100;
type RouteContext = Effect.Success<ReturnType<NonNullable<SymmyIngressAdmission['acquireRouteAssertion']>>>['route'];
interface CatalogRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
const variantRefOf = (tenantId: string, variantId: string): CatalogRef => ({
  moduleId: CATALOG_MODULE_ID,
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
            marketId: CatalogPagePricesRequestSchema.fields.marketId,
            unitId: Schema.String.pipe(Schema.brand('CatalogProductUnitId')),
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
  const match = /^(?<whole>\d+)(?:\.(?<fraction>\d+))?$/u.exec(amount.trim());
  if (match === null) {
    return undefined;
  }
  const minor = Math.round(Number(`${match.groups?.['whole'] ?? '0'}.${match.groups?.['fraction'] ?? '0'}`) * 100);
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
      requestCorrelation: yield* newRequestIdentifier(admission),
    },
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  );
  const { scopes } = yield* client.externalPriceSourceScopes.execute({ payload: {} });
  return scopes.length === 1 ? (scopes[0] ?? null) : null;
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
          moduleId: CATALOG_MODULE_ID,
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
      requestCorrelation: yield* newRequestIdentifier(admission),
    },
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  );
  const answer = yield* client.catalogPagePrices.execute({ payload });
  if (!Predicate.isTagged(answer, 'CATALOG_PAGE_PRICED')) {
    yield* Console.error(`${LOG} catalog-page-prices answered ${answer._tag}`);
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const prices = new Map<string, number>();
  for (const price of answer.prices) {
    if (
      Predicate.isTagged(price, 'PRICE_FOUND') &&
      price.priceRevision.monetaryAmount.currencyCode === key.currencyCode
    ) {
      const minor = minorOf(price.priceRevision.monetaryAmount.amount);
      if (minor !== undefined) {
        prices.set(price.catalogSelection.variantRef.resourceId, minor);
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
      requestCorrelation: yield* newRequestIdentifier(admission),
    },
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  );
  const payload = yield* Schema.decodeUnknownEffect(CatalogVariantOnHandPageRequestSchema)({
    customerConfigurationId,
    variantRefs,
  });
  const answer = yield* client.catalogVariantOnHandPage.execute({ payload });
  const onHand = new Map<string, number>();
  for (const item of answer.items) {
    if (item.outcome === 'ON_HAND') {
      const total = Number(item.total.amount);
      if (Number.isFinite(total) && total >= 0) {
        onHand.set(item.variantRef.resourceId, total);
      }
    }
  }
  return onHand;
});

const describe = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).slice(0, 400);

/** An owner's refusal with its status and body (the refusal code), which an undeclared-status decode error drops. */
type OwnerReadFailure = Effect.Error<
  ReturnType<typeof readPriceKey> | ReturnType<typeof readPricePage> | ReturnType<typeof readOnHandPage>
>;
const describeRefusal = (error: OwnerReadFailure) => {
  const cause = Cause.fail(error);
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
const readVariantFigures = Effect.fn('SymmyMerchandiseCopy.figures')(function* collectFigures(
  admission: SymmyIngressAdmission,
  legalEntityId: string,
  products: SourceProducts,
  key: Effect.Success<ReturnType<typeof readPriceKey>>,
  source: NonNullable<RouteContext['inventorySource']> | null,
) {
  const refs = products.flatMap((item) =>
    item.variantSources.map((variant) => ({
      productId: item.product.productRef.resourceId,
      productRef: item.product.productRef,
      variantRef: variantRefOf(item.product.productRef.tenantId, variant.variantId),
    })),
  );
  const figures = new Map<string, { priceNetMinor?: number; stockOnHand?: number }>();
  const skipped = new Set<string>();
  const pages = yield* Effect.forEach(
    EffectArray.chunksOf(refs, VARIANT_PAGE),
    Effect.fn('SymmyMerchandiseCopy.figuresPage')(function* figuresPage(page) {
      const [prices, onHand] = yield* Effect.all(
        [
          key === null
            ? Effect.succeed(new Map<string, number>())
            : readPricePage(admission, legalEntityId, key, page).pipe(
                Effect.catch((error) =>
                  describeRefusal(error).pipe(
                    Effect.flatMap((text) =>
                      Console.error(`${LOG} prices unreadable, ${String(page.length)} variants skipped: ${text}`),
                    ),
                    Effect.as(null),
                  ),
                ),
              ),
          source === null
            ? Effect.succeed(new Map<string, number>())
            : readOnHandPage(
                admission,
                legalEntityId,
                source.customerConfigurationId,
                page.map(({ variantRef }) => variantRef),
              ).pipe(
                Effect.catch((error) =>
                  describeRefusal(error).pipe(
                    Effect.flatMap((text) => Console.error(`${LOG} on-hand unreadable, stock kept: ${text}`)),
                    Effect.as(null),
                  ),
                ),
              ),
        ],
        { concurrency: 2 },
      );
      if (prices === null) {
        for (const { productId } of page) {
          skipped.add(productId);
        }
      }
      for (const [variantId, priceNetMinor] of prices ?? []) {
        figures.set(variantId, { ...figures.get(variantId), priceNetMinor });
      }
      for (const [variantId, stockOnHand] of onHand ?? []) {
        figures.set(variantId, { ...figures.get(variantId), stockOnHand });
      }
      return onHand !== null;
    }),
    { concurrency: 1 },
  );
  return { figures, priced: key !== null, skipped, stocked: source !== null && pages.every(Boolean) };
});

/**
 * The Inventory configuration of the company's Symmy stock: on the products import route (the same configuration as the
 * stock route's), else on the products read route, else on the stock route (selected for it).
 */
const readInventorySource = Effect.fn('SymmyMerchandiseCopy.inventorySource')(function* inventorySource(
  admission: SymmyIngressAdmission,
  write: RouteContext,
  read: RouteContext,
) {
  const enrolled = write.inventorySource ?? read.inventorySource;
  if (enrolled !== undefined) {
    return enrolled;
  }
  const source = yield* selectRoute(admission, 'inventoryStockBatch').pipe(
    Effect.map((route: RouteContext) => route.inventorySource ?? null),
    Effect.catch((error) =>
      Console.error(`${LOG} Inventory route unavailable: ${describe(Cause.fail(error))}`).pipe(Effect.as(null)),
    ),
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
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
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
  const idempotencyInput = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
    yield* symmyDemoCatalogScopeIdentity(scope),
    'merchandise-copy-v2',
    runId,
    sourceRequestDigest,
  ]).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
  const idempotencyKey = yield* symmyDemoCatalogDigest(idempotencyInput);
  const result = yield* executeImportSourceCatalogWithAuthorization(
    payload,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier(admission),
    { baseUrl, compositionRevision: assertion.compositionRevision, idempotencyKey },
  );
  // The import's result names what the upsert did (sourceUpsert.outcome); an older owner answers without it.
  const answer = 'sourceUpsert' in result ? result.sourceUpsert : undefined;
  return { outcome: answer?.outcome ?? 'APPLIED', reason: answer?.reason };
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
      ...(variant.sku === undefined ? [] : [variant.sku]),
    ]),
  ]);

/** When the newest targeted copy of each Catalog product began reading its Pricing and Inventory figures (epoch ms). */
interface CopyProcessState {
  following: boolean;
  readonly full: { pending: SymmyIngressAdmission | null; running: boolean };
  readonly ownerCommitAt: Map<string, number>;
  readonly targeted: { current: TargetedRun | null; readonly pending: Map<string, Targets>; running: boolean };
  readonly targetedFiguresAt: Map<string, number>;
  readonly watches: Map<string, Watch>;
}
const CopyProcess = Context.Reference<Ref.Ref<CopyProcessState>>(
  '@app/shell-super-app/symmy/merchandise-copy/process',
  {
    defaultValue: () =>
      Ref.makeUnsafe<CopyProcessState>({
        following: false,
        full: { pending: null, running: false },
        ownerCommitAt: new Map(),
        targeted: { current: null, pending: new Map(), running: false },
        targetedFiguresAt: new Map(),
        watches: new Map(),
      }),
  },
);
const copyProcessState = CopyProcess.pipe(Effect.flatMap(Ref.get));
const logCopyExit = (message: string) => (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Console.error(`${LOG} ${message}: ${describe(exit.cause)}`) : Effect.void;

/** The products import route enrolls the merchandise import (the copy's writes). */
const enrolledForImport = (route: RouteContext): boolean =>
  route.allowedOwnerOperations.some(
    (operation) =>
      operation.moduleId === importOperation.moduleId &&
      operation.entrypointKey === importOperation.entrypointKey &&
      operation.schemaVersion === importOperation.schemaVersion,
  );

/**
 * What started a copy. `write`: the products import route its trigger already selected (the company, the writes'
 * enrollment, the Inventory configuration), so the copy does not select it again before reading. `settle`: reads that
 * answer before any owner state is read (the statuses of the products jobs a targeted copy watches). `note`: what the
 * log line adds.
 */
interface CopyTrigger {
  readonly note?: () => string;
  readonly settle?: Effect.Effect<void>;
  readonly write?: RouteContext;
}

/**
 * What one copy writes, read from the owners: the products (every one, or with `only` those named by one of the
 * codes) and the current figures of their Variants. Null when the route is not enrolled for the merchandise
 * import or has no company.
 */
const readCopyPlan = Effect.fn('SymmyMerchandiseCopy.read')(function* readPlan(
  admission: SymmyIngressAdmission,
  only: ReadonlySet<string> | undefined,
  trigger: CopyTrigger,
) {
  // The admission proves owner calls with the route selected last: productsBatch (enrollment; the trigger's own
  // selection when it made one), then adminProducts for every read (Catalog's products and Pricing's price key at once,
  // then each page's prices and on-hand at once). The trigger's settle reads run beside the read route's selection.
  const write = trigger.write ?? (yield* selectRoute(admission, 'productsBatch'));
  const { legalEntityId } = write;
  if (legalEntityId === undefined || !enrolledForImport(write)) {
    return null;
  }
  const [read] = yield* Effect.all([selectRoute(admission, 'adminProducts'), trigger.settle ?? Effect.void], {
    concurrency: 2,
  });
  if (read.tenantId !== write.tenantId) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const source = yield* readInventorySource(admission, write, read);
  const [all, key] = yield* Effect.all(
    [
      readAllSourceProducts(read, admission),
      readPriceKey(admission, legalEntityId).pipe(
        Effect.catch((error) =>
          describeRefusal(error).pipe(
            Effect.flatMap((text) => Console.error(`${LOG} price key unreadable, no prices sent: ${text}`)),
            Effect.as(null),
          ),
        ),
      ),
    ],
    { concurrency: 2 },
  );
  const products = only === undefined ? all : all.filter((item) => namedBy(item, only));
  const figuresAt = yield* Clock.currentTimeMillis;
  const { targetedFiguresAt } = yield* copyProcessState;
  if (only !== undefined) {
    for (const item of products) {
      targetedFiguresAt.set(item.product.productRef.resourceId, figuresAt);
    }
  }
  const figures = yield* readVariantFigures(admission, legalEntityId, products, key, source);
  return { ...figures, figuresAt, legalEntityId, products, tenantId: write.tenantId };
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
  trigger: CopyTrigger = {},
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const plan = yield* Effect.interruptible(readCopyPlan(admission, only, trigger));
  if (plan === null) {
    return { skipped: 'not_enrolled' } as const;
  }
  const { figures, figuresAt, legalEntityId, priced, products, skipped, stocked, tenantId } = plan;
  const readMs = (yield* Clock.currentTimeMillis) - startedAt;
  // The writes are proved with the products import route, selected now: still enrolled, still the same company.
  const write = yield* selectRoute(admission, 'productsBatch');
  if (write.tenantId !== tenantId || write.legalEntityId !== legalEntityId || !enrolledForImport(write)) {
    return { skipped: 'not_enrolled' } as const;
  }
  const { targetedFiguresAt } = yield* copyProcessState;
  const outcomes = new Map<string, number>([
    ['CREATED', 0],
    ['UPDATED', 0],
    ['UNCHANGED', 0],
    ['REFUSED', 0],
  ]);
  const refused: string[] = [];
  const unpriced: string[] = [];
  const runId = yield* newRequestIdentifier(admission);
  yield* Effect.forEach(
    products,
    Effect.fn('SymmyMerchandiseCopy.copyOne')(function* copyOne(item) {
      const code = symmySourceCode(item.source_record_id);
      // A full sweep never writes over a targeted copy that read the owners after it did: those figures are newer.
      const targetedAt = targetedFiguresAt.get(item.product.productRef.resourceId);
      if (only === undefined && targetedAt !== undefined && targetedAt >= figuresAt) {
        outcomes.set('SUPERSEDED', (outcomes.get('SUPERSEDED') ?? 0) + 1);
        return;
      }
      const command = skipped.has(item.product.productRef.resourceId)
        ? undefined
        : symmyUpsertSourceProductCommand(item, figures);
      // A product whose price page failed is not written in this sweep. One without a price is still sent: the upsert
      // never creates a row without a price (never a row at 0 Kč), but an existing row keeps taking its stock figure.
      const withoutPrice =
        command !== undefined && command.variants.some((variant) => variant.priceNetMinor === undefined);
      if (command === undefined || withoutPrice) {
        unpriced.push(code);
      }
      const result =
        command === undefined
          ? { outcome: 'SKIPPED', reason: null }
          : yield* upsert({ ...write, legalEntityId }, admission, command, runId).pipe(
              Effect.catch((error) =>
                Console.error(`${LOG} ${item.source_record_id} failed: ${describe(Cause.fail(error))}`).pipe(
                  Effect.as({ outcome: 'FAILED', reason: null }),
                ),
              ),
            );
      outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
      if (result.outcome === 'REFUSED') {
        refused.push(`${code}:${result.reason ?? 'unknown'}`);
      }
    }),
    { concurrency: 1, discard: true },
  );
  const run = only === undefined ? 'full' : `targeted=[${[...only].slice(0, 20).join(', ')}]`;
  const ms = (yield* Clock.currentTimeMillis) - startedAt;
  const summary = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Union([Schema.Number, Schema.Boolean]))),
  )({ ...Object.fromEntries(outcomes), priced, stocked }).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)),
  );
  yield* Console.log(
    `${LOG} company=${legalEntityId} ${run} products=${String(products.length)} ms=${String(ms)} read=${String(readMs)}` +
      `${trigger.note === undefined ? '' : ` ${trigger.note()}`} ${summary}` +
      ` refused=[${refused.join(', ')}] withoutPrice=[${unpriced.join(', ')}]`,
  );
  return { outcomes: Object.fromEntries(outcomes) } as const;
});

/**
 * Full sweeps: one at a time per process; triggers that arrive meanwhile coalesce into one more run with the newest
 * admission, a minute after the previous one ended (a sweep writes every product, one at a time: it is the safety net,
 * not the way an import arrives, and must not keep the owners busy while targeted copies run). The admission is a self-contained capability (API key, the request's correlation headers
 * and the services it needs are held by its closures; every owner call re-verifies the key and mints a fresh
 * assertion), so a run after the response, or seconds later, still proves its calls. Whatever ends a run (failure,
 * defect, interruption) is logged and frees the queue.
 */
const COOL_DOWN = '60 seconds';
const drain: Effect.Effect<void> = Effect.gen(function* drainFullCopies() {
  const { full } = yield* copyProcessState;
  const next = full.pending;
  full.pending = null;
  if (next === null) {
    full.running = false;
    return;
  }
  const fiber = yield* Effect.forkChild(copySymmyProductsToMerchandise(next));
  const result = yield* Fiber.await(fiber);
  yield* Exit.match(result, {
    onFailure: (cause) => Console.error(`${LOG} copy failed: ${describe(cause)}`),
    onSuccess: () => Effect.void,
  });
  yield* Effect.sleep(COOL_DOWN);
  yield* drain;
}).pipe(
  Effect.onExit((exit) =>
    Exit.isFailure(exit)
      ? Effect.gen(function* releaseFullQueue() {
          const { full } = yield* copyProcessState;
          full.running = false;
          yield* Console.error(`${LOG} copy stopped; the next trigger runs it again: ${describe(exit.cause)}`);
        })
      : Effect.void,
  ),
);

/**
 * Schedules a full sweep after an authenticated Symmy request that can reveal catalogue, price or stock state (reads,
 * job polls): the safety net for whatever a targeted copy missed; the first one after the process starts (a deploy)
 * runs at once. Never fails and never waits: the request's response is unchanged whatever the copy does.
 */
export const scheduleSymmyMerchandiseCopy = Effect.fn('SymmyMerchandiseCopy.scheduleFull')(function* scheduleFullCopy(
  admission: SymmyIngressAdmission,
) {
  const { full } = yield* copyProcessState;
  full.pending = admission;
  if (full.running) {
    return;
  }
  full.running = true;
  yield* Effect.forkDetach(drain);
});

/**
 * Targeted copies: only the products a Symmy import names, started the moment their owners commit (a products job)
 * or the import answers (stock), with no pause in front and never queued behind a full sweep. One run at a time per
 * process; the codes a company names meanwhile merge into its next run, which starts as soon as the running one
 * ends. A run still reading when more codes of its company arrive starts over at once with them (within
 * RESTART_WINDOW_MS of its first start, so a company that commits all the time still gets its copy); writes always
 * finish. A run is given the services, the admission and the products import route of the newest Symmy request that
 * named its codes (the owner relay's fetch among the services).
 */
interface Targets {
  readonly admission: SymmyIngressAdmission;
  readonly codes: ReadonlySet<string>;
  readonly context: Context.Context<never>;
  /** The products jobs these codes come from; a run reads the status of those not known settled before anything else. */
  readonly jobs: ReadonlySet<WatchedJob>;
  /** When the first run for these codes began; a restart keeps it. */
  readonly since: number;
  readonly write: RouteContext;
}

/**
 * A products import a targeted copy watches: `admission`, `context` and `write` (its products import route) are those
 * of the import's request. It is watched until a copy has read its products after its job settled every effect (a
 * status read found the job completed), or for at most WATCH_MS.
 */
interface WatchedJob {
  readonly admission: SymmyIngressAdmission;
  readonly codes: readonly string[];
  readonly context: Context.Context<never>;
  readonly jobId: string;
  /** When a status read found the job completed (epoch ms). */
  settledAt: number | null;
  readonly until: number;
  readonly write: RouteContext;
}
interface TargetedRun {
  readonly company: string;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
  readonly targets: Targets;
}
const RESTART_WINDOW_MS = 3000;
/** A job status read that takes longer leaves the job watched and lets the copy read on. */
const SETTLE_WAIT = '1 second';

/** Whether the job has settled every effect (completed); an unknown job has nothing left to copy either. */
const readJobSettled = Effect.fn('SymmyMerchandiseCopy.jobSettled')(function* jobSettled(job: WatchedJob) {
  if (job.admission.acquireOwnerAssertion === undefined) {
    return false;
  }
  const payload = yield* Schema.decodeUnknownEffect(SymmyJobStatusRequestSchema)({ jobId: job.jobId });
  // The status read is the job poll's own (GET /jobs/{id}): the integration's unscoped assertion.
  const assertion = yield* job.admission.acquireOwnerAssertion({ audience: 'symmy-integration' });
  const baseUrl = yield* resolveSymmyOwnerReleaseBase(assertion.apiBaseUrl, 'symmy-integration');
  return yield* executeSymmyJobStatusWithAuthorization(
    payload,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier(job.admission),
    { baseUrl, compositionRevision: assertion.compositionRevision },
  ).pipe(
    Effect.map((status) => String(status.phase).startsWith('completed')),
    Effect.catchTag('SymmyJobStatusNotFoundProblem', () => Effect.succeed(true)),
  );
});

/** Reads the status of each job; a settled one is marked with the time it was found settled. Never fails. */
const settleJobs = (jobs: readonly WatchedJob[]): Effect.Effect<void> =>
  Effect.forEach(
    jobs,
    (job) =>
      readJobSettled(job).pipe(
        Effect.flatMap((settled) =>
          settled
            ? Clock.currentTimeMillis.pipe(
                Effect.map((at) => {
                  job.settledAt = at;
                }),
              )
            : Effect.void,
        ),
        Effect.catchCause((cause) => Console.warn(`${LOG} job ${job.jobId} status unreadable: ${describe(cause)}`)),
      ),
    { concurrency: 4, discard: true },
  ).pipe(Effect.timeoutOrElse({ duration: SETTLE_WAIT, orElse: () => Effect.void }));

const jobsNote = (jobs: readonly WatchedJob[]) => () =>
  jobs.length === 0
    ? 'jobs=[]'
    : `jobs=[${jobs.map((job) => `${job.jobId}:${job.settledAt === null ? 'open' : 'settled'}`).join(', ')}]`;

/** A copy that read these jobs' products after they settled leaves nothing of theirs to copy: they are unwatched. */
const unwatchSettled = (watches: Map<string, Watch>, company: string, jobs: readonly WatchedJob[]) => {
  const watch = watches.get(company);
  if (watch === undefined) {
    return;
  }
  for (const job of jobs) {
    if (job.settledAt !== null && watch.jobs.get(job.jobId) === job) {
      watch.jobs.delete(job.jobId);
    }
  }
  if (watch.jobs.size === 0) {
    watches.delete(company);
  }
};

const drainTargeted: Effect.Effect<void> = Effect.gen(function* drainTargetedCopies() {
  const { targeted, watches } = yield* copyProcessState;
  const next = targeted.pending.entries().next();
  if (next.done === true) {
    targeted.running = false;
    return;
  }
  const [company, targets] = next.value;
  targeted.pending.delete(company);
  const jobs = [...targets.jobs];
  const fiber = yield* copySymmyProductsToMerchandise(targets.admission, targets.codes, {
    note: jobsNote(jobs),
    settle: settleJobs(jobs.filter((job) => job.settledAt === null)),
    write: targets.write,
  }).pipe(Effect.uninterruptible, Effect.provideContext(targets.context), Effect.forkChild);
  targeted.current = { company, fiber, targets };
  const exit = yield* Fiber.await(fiber);
  targeted.current = null;
  if (Exit.isSuccess(exit)) {
    unwatchSettled(watches, company, jobs);
  } else if (!Cause.hasInterruptsOnly(exit.cause)) {
    // Its products may not have been written: the jobs' next commit (or any later one) copies them again.
    for (const job of jobs) {
      job.settledAt = null;
    }
    yield* Console.error(`${LOG} targeted copy failed: ${describe(exit.cause)}`);
  }
  yield* drainTargeted;
}).pipe(
  Effect.onExit((exit) =>
    Exit.isFailure(exit)
      ? Effect.gen(function* releaseTargetedQueue() {
          const { targeted } = yield* copyProcessState;
          targeted.current = null;
          targeted.running = false;
          yield* Console.error(`${LOG} targeted copy stopped; the next import runs it again: ${describe(exit.cause)}`);
        })
      : Effect.void,
  ),
);

/** Adds the codes to the company's next targeted run, restarting its run still reading, and starts the runs. */
const copyTargets = Effect.fn('SymmyMerchandiseCopy.scheduleTargets')(function* scheduleTargetedCopy(
  company: string,
  targets: Omit<Targets, 'since'>,
) {
  const now = yield* Clock.currentTimeMillis;
  const { targeted } = yield* copyProcessState;
  const run = targeted.current;
  const restarted = run !== null && run.company === company && now - run.targets.since < RESTART_WINDOW_MS ? run : null;
  const pending = targeted.pending.get(company);
  targeted.pending.set(company, {
    ...targets,
    codes: new Set([...(restarted?.targets.codes ?? []), ...(pending?.codes ?? []), ...targets.codes]),
    jobs: new Set([...(restarted?.targets.jobs ?? []), ...(pending?.jobs ?? []), ...targets.jobs]),
    since: restarted?.targets.since ?? pending?.since ?? now,
  });
  // Interrupts only the reads: a run already writing ends first, then its codes run again with the new ones.
  const restart = restarted === null ? Effect.void : Effect.forkDetach(Fiber.interrupt(restarted.fiber));
  if (targeted.running) {
    return yield* Effect.asVoid(restart);
  }
  targeted.running = true;
  return yield* Effect.forkDetach(drainTargeted).pipe(Effect.asVoid);
});

/** The company the admitted route copies into ("tenant|legal entity") with its products import route, if it has one. */
const companyOf = Effect.fn('SymmyMerchandiseCopy.company')(function* company(admission: SymmyIngressAdmission) {
  const route = yield* selectRoute(admission, 'productsBatch');
  return route.legalEntityId === undefined
    ? undefined
    : {
        key: `${String(route.tenantId)}|${String(route.legalEntityId)}`,
        legalEntityId: String(route.legalEntityId),
        tenantId: String(route.tenantId),
        write: route,
      };
});

/**
 * The products jobs of accepted products imports, watched per company (see WatchedJob): every commit of Catalog,
 * Pricing or Inventory for the company copies the products of its jobs not known settled at once, so the job's own
 * commits (each owner commits its effect, the last one included) reach "Produkty" as they land, whether or not anyone
 * polls the job. A job found settled is no longer copied by later commits: they are not its own.
 */
interface Watch {
  readonly jobs: Map<string, WatchedJob>;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

/** The newest owner commit seen per tenant (epoch ms). */

const OWNER_MODULES: ReadonlySet<string> = new Set([CATALOG_MODULE_ID, 'commerce.inventory', 'commerce.pricing']);
const WATCH_MS = 120_000;

/** One targeted run for the products of the jobs, with the newest job's request. */
const copyJobs = (company: string, jobs: readonly [WatchedJob, ...WatchedJob[]]) => {
  const newest = jobs.at(-1) ?? jobs[0];
  return copyTargets(company, {
    admission: newest.admission,
    codes: new Set(jobs.flatMap((job) => job.codes)),
    context: newest.context,
    jobs: new Set(jobs),
    write: newest.write,
  });
};

/** Copies the products of the open jobs of every company `concerns` names, dropping jobs watched long enough. */
const copyWatched = Effect.fn('SymmyMerchandiseCopy.copyWatched')(function* copyWatchedProducts(
  concerns: (watch: Watch) => boolean,
) {
  const now = yield* Clock.currentTimeMillis;
  const { watches } = yield* copyProcessState;
  const due: [string, [WatchedJob, ...WatchedJob[]]][] = [];
  for (const [company, watch] of watches) {
    for (const [jobId, job] of watch.jobs) {
      if (job.until <= now) {
        watch.jobs.delete(jobId);
      }
    }
    if (watch.jobs.size === 0) {
      watches.delete(company);
      continue;
    }
    const [first, ...rest] = [...watch.jobs.values()].filter((job) => job.settledAt === null);
    if (first !== undefined && concerns(watch)) {
      due.push([company, [first, ...rest]]);
    }
  }
  return yield* Effect.forEach(due, ([company, jobs]) => copyJobs(company, jobs), { concurrency: 1, discard: true });
});

/** A committed change: a Catalog, Pricing or Inventory commit of a company copies the products of its open jobs. */
const copyOnOwnerCommit = (change: LiveChange): Effect.Effect<void> =>
  change.moduleKeys.some((key) => OWNER_MODULES.has(key))
    ? Effect.gen(function* copyCommittedProducts() {
        const { ownerCommitAt } = yield* copyProcessState;
        ownerCommitAt.set(change.tenantId, yield* Clock.currentTimeMillis);
        return yield* copyWatched(
          (watch) =>
            watch.tenantId === change.tenantId &&
            (change.legalEntityId === null || change.legalEntityId === watch.legalEntityId),
        );
      })
    : Effect.void;

/**
 * Feeds every committed change to the targeted copies for as long as the Shell runs; after a lost change tail (changes
 * may have been missed) the products of every open job are copied again.
 */
export const SymmyMerchandiseCopyLive = Layer.effectDiscard(
  Effect.gen(function* followOwnerCommits() {
    const hub = yield* LiveChangeHub;
    const process = yield* copyProcessState;
    // One follower per process: another Shell runtime of the process (the root route handler) adds none, so a commit
    // starts one copy.
    const first = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (process.following) {
          return false;
        }
        process.following = true;
        return true;
      }),
      (owned) =>
        Effect.sync(() => {
          if (owned) {
            process.following = false;
          }
        }),
    );
    if (first) {
      yield* Effect.forkScoped(hub.follow({ publish: copyOnOwnerCommit, resetAll: copyWatched(() => true) }));
    }
  }),
);

/**
 * After an accepted products import: its job is watched (see Watch), so its products are copied the moment their
 * owners commit the job's effects. Never fails and never waits.
 */
export const copySymmyProductsOnCommit = (
  admission: SymmyIngressAdmission,
  jobId: string,
  codes: readonly string[],
): Effect.Effect<void> =>
  Effect.gen(function* watchImport() {
    if (codes.length === 0) {
      return;
    }
    const at = yield* Clock.currentTimeMillis;
    const context = yield* Effect.context();
    const { ownerCommitAt, watches } = yield* copyProcessState;
    const company = yield* companyOf(admission);
    if (company === undefined) {
      return;
    }
    const job: WatchedJob = {
      admission,
      codes,
      context,
      jobId,
      settledAt: null,
      until: at + WATCH_MS,
      write: company.write,
    };
    const watch = watches.get(company.key) ?? {
      jobs: new Map<string, WatchedJob>(),
      legalEntityId: company.legalEntityId,
      tenantId: company.tenantId,
    };
    watch.jobs.set(jobId, job);
    watches.set(company.key, watch);
    // A commit of the job that landed while the route was being read is not missed.
    if ((ownerCommitAt.get(company.tenantId) ?? 0) >= at) {
      yield* copyJobs(company.key, [job]);
    }
  }).pipe(Effect.onExit(logCopyExit('targeted copy stopped')), Effect.forkDetach, Effect.asVoid);

/**
 * After a job poll found a products job completed: when no copy has read its products since it settled and none is
 * running or queued with it (the copy started by its last owner commit can find it still running), its products are
 * copied at once, so a missed or failed copy does not wait for the next full sweep. Never fails and never waits.
 */
export const copySymmyJobOnCompleted = (jobId: string): Effect.Effect<void> =>
  Effect.gen(function* copyCompletedJob() {
    const { targeted, watches } = yield* copyProcessState;
    for (const [company, watch] of watches) {
      const job = watch.jobs.get(jobId);
      if (
        job !== undefined &&
        job.settledAt === null &&
        targeted.current?.targets.jobs.has(job) !== true &&
        targeted.pending.get(company)?.jobs.has(job) !== true
      ) {
        return yield* copyJobs(company, [job]);
      }
    }
  }).pipe(Effect.onExit(logCopyExit('targeted copy stopped')), Effect.forkDetach, Effect.asVoid);

/** After an accepted stock import: the products of its items are copied at once. Never fails and never waits. */
export const copySymmyStockToMerchandise = (
  admission: SymmyIngressAdmission,
  itemKeys: readonly string[],
): Effect.Effect<void> =>
  Effect.gen(function* copyStock() {
    if (itemKeys.length === 0) {
      return;
    }
    const context = yield* Effect.context();
    const company = yield* companyOf(admission);
    if (company !== undefined) {
      yield* copyTargets(company.key, {
        admission,
        codes: new Set(itemKeys),
        context,
        jobs: new Set(),
        write: company.write,
      });
    }
  }).pipe(Effect.onExit(logCopyExit('targeted copy stopped')), Effect.forkDetach, Effect.asVoid);
