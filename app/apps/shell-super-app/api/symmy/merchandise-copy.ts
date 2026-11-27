import { computeCanonicalValueHash } from '@app/core-runtime/actions/canonical-value-hash';
import { executeImportSourceCatalogWithAuthorization } from '@app/merchandise/apis/import-source-catalog-action/client';
import { ImportSourceCatalogPayloadSchema } from '@app/merchandise/contracts/import-source-catalog';
import { Cause, Console, Effect, Redacted, Schema } from 'effect';
import { symmyUnavailableProblem } from './contract.ts';
import { symmyDemoCatalogDigest, symmyDemoCatalogScopeIdentity } from './demo-catalog-identity.ts';
import { resolveSymmyOwnerReleaseBase } from './owner-release-transport.ts';
import { projectSymmySourceProducts } from './source-read-projections.ts';
import type { SymmySourceReadScope } from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';

// Every product the ERP connector Symmy holds in main Catalog is mirrored into demo.merchandise as an ordinary row of
// "Produkty" (and of the shop catalogue) with the mark "Importováno přes Symmy". The copy reads only the owners'
// accepted current state (Catalog's source product page), never a request body, and writes through merchandise's
// source-catalog import (UpsertSourceProduct), which is idempotent: a replay changes nothing. It runs beside the
// Symmy API, never inside a response: a failing copy is logged and retried by the next trigger, and no Symmy
// response, status code or job result depends on it.

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

/** The UpsertSourceProduct command of one Catalog product, or undefined when it has no source-correlated Variant. */
export const symmyUpsertSourceProductCommand = (item: SourceProduct, stock: ReadonlyMap<string, number> = new Map()) => {
  const erpCode = symmySourceCode(item.source_record_id).slice(0, 64);
  const name = (item.product.name ?? '').trim().slice(0, 200);
  const variants = item.variantSources.flatMap((variant) => {
    const sku = symmySourceCode(variant.source_record_id).slice(0, 64);
    if (sku === '') {
      return [];
    }
    const onHand = stock.get(sku);
    return [{ catalogVariantId: String(variant.variantId), sku, ...(onHand === undefined ? {} : { stockOnHand: onHand }) }];
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
 * demo.merchandise store. A route not enrolled for the merchandise import (or without a company) copies nothing.
 * Answers the count per outcome; one product's failure is logged and the others still run.
 */
export const copySymmyProductsToMerchandise = Effect.fn('SymmyMerchandiseCopy.copyAll')(function* copyAll(
  admission: SymmyIngressAdmission,
  stock: ReadonlyMap<string, number> = new Map(),
) {
  if (admission.acquireRouteAssertion === undefined) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  // The admission proves owner calls with the route selected last, so each phase selects its own route first:
  // productsBatch (enrollment), adminProducts (the Catalog read), productsBatch again (the merchandise writes).
  const write = yield* admission.acquireRouteAssertion({ routeKey: 'productsBatch' });
  if (write.compositionRevision !== admission.compositionRevision) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const { legalEntityId } = write.route;
  const enrolled = write.route.allowedOwnerOperations.some(
    (operation) =>
      operation.moduleId === importOperation.moduleId &&
      operation.entrypointKey === importOperation.entrypointKey &&
      operation.schemaVersion === importOperation.schemaVersion,
  );
  if (legalEntityId === undefined || !enrolled) {
    return { skipped: 'not_enrolled' } as const;
  }
  const read = yield* admission.acquireRouteAssertion({ routeKey: 'adminProducts' });
  if (read.compositionRevision !== admission.compositionRevision || read.route.tenantId !== write.route.tenantId) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const products = yield* readAllSourceProducts(read.route, admission);
  const reselected = yield* admission.acquireRouteAssertion({ routeKey: 'productsBatch' });
  if (reselected.compositionRevision !== admission.compositionRevision) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const outcomes: Record<string, number> = {};
  const runId = yield* newRequestIdentifier;
  for (const item of products) {
    const command = symmyUpsertSourceProductCommand(item, stock);
    const outcome =
      command === undefined
        ? 'SKIPPED'
        : yield* upsert({ ...write.route, legalEntityId }, admission, command, runId).pipe(
            Effect.catchCause((cause) =>
              Console.error(`${LOG} ${item.source_record_id} failed: ${Cause.pretty(cause).slice(0, 400)}`).pipe(
                // The accepted on-hand of a failed product is kept for the next run instead of being dropped.
                Effect.andThen(Effect.sync(() => requeueStock(command.variants, stock))),
                Effect.as('FAILED'),
              ),
            ),
          );
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  yield* Console.log(`${LOG} company=${legalEntityId} products=${String(products.length)} ${JSON.stringify(outcomes)}`);
  return { outcomes } as const;
});

/** One copy at a time per process; triggers that arrive meanwhile coalesce into one more run with the newest admission. */
const state: { pending: SymmyIngressAdmission | undefined; running: boolean; stock: Map<string, number> } = {
  pending: undefined,
  running: false,
  stock: new Map(),
};
const COOL_DOWN = '10 seconds';

/** Puts accepted on-hand figures back for the next run unless a newer figure for the same item arrived meanwhile. */
const requeueStock = (variants: readonly { readonly sku: string }[], stock: ReadonlyMap<string, number>) => {
  for (const { sku } of variants) {
    const onHand = stock.get(sku);
    if (onHand !== undefined && !state.stock.has(sku)) {
      state.stock.set(sku, onHand);
    }
  }
};

const drain: Effect.Effect<void> = Effect.suspend(() => {
  const next = state.pending;
  const stock = state.stock;
  state.pending = undefined;
  state.stock = new Map();
  if (next === undefined) {
    state.running = false;
    return Effect.void;
  }
  return copySymmyProductsToMerchandise(next, stock).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Console.error(`${LOG} copy failed: ${Cause.pretty(cause).slice(0, 400)}`).pipe(
        Effect.andThen(Effect.sync(() => requeueStock([...stock.keys()].map((sku) => ({ sku })), stock))),
      ),
    ),
    Effect.andThen(Effect.sleep(COOL_DOWN)),
    Effect.andThen(drain),
  );
});

/**
 * Schedules the copy after a Symmy request the owners accepted (a products read, a stock batch, a finished job). Never
 * fails and never waits: the request's response is unchanged whatever the copy does. `stock`: the absolute on-hand
 * Inventory ACCEPTED in this request, by item key (the Variant's source code); only those values reach merchandise.
 */
export const scheduleSymmyMerchandiseCopy = (
  admission: SymmyIngressAdmission,
  stock: ReadonlyMap<string, number> = new Map(),
): Effect.Effect<void> =>
  Effect.suspend(() => {
    state.pending = admission;
    for (const [sku, onHand] of stock) {
      state.stock.set(sku, onHand);
    }
    if (state.running) {
      return Effect.void;
    }
    state.running = true;
    return Effect.forkDetach(drain).pipe(Effect.asVoid);
  }).pipe(Effect.catchCause(() => Effect.void));
