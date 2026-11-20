import { GatewayAuthenticationRequiredProblemSchema } from '@app/shared-contracts';
import { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import {
  summarizeSymmyItemOutcome,
  SYMMY_FIXTURE_ROUTES,
  SYMMY_REST_PREFIX,
  SYMMY_ROUTES,
} from '@app/shared-contracts/symmy';
import type { SymmyItemOutcome, SymmyRouteKey } from '@app/shared-contracts/symmy';
import {
  SymmyCustomerGroupRowsSchema,
  SymmyCustomerRowsSchema,
  SymmyGroupCustomerRowsSchema,
  SymmyPriceBatchSchema,
  SymmyPriceListRowsSchema,
  SymmyProductRowsSchema,
  SymmyStockRowsSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import type {
  SymmyCustomerGroupRows,
  SymmyCustomerRows,
  SymmyGroupCustomerRows,
  SymmyPriceBatch,
  SymmyPriceListRows,
  SymmyProductRows,
  SymmyStockRows,
} from '@app/symmy-integration/symmy-internal-contracts';
import type { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import { useEffectContext } from '@modern-js/bff-effect/context';
import { HttpApiBuilder, HttpEffect } from '@modern-js/bff-effect/effect-edge';
import { Array as EffectArray, Context, Effect, Match, Option, Predicate, Redacted, Schema } from 'effect';
import type { Types } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { HttpMethod } from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';

import { ShellAuthenticationApi } from '../../shared/api.ts';

import {
  symmyInvalidProblem,
  isSymmyCustomerFieldName,
  isSymmyProductFieldName,
  isSymmyRegionFieldName,
  SymmyFixtureAdmissionSchema,
  SymmyFixtureJobStatusSchema,
  SymmyMethodNotAllowedProblemSchema,
  SymmySchemaError,
  symmyMethodNotAllowedProblem,
  symmyIdempotencyRequiredProblem,
  symmyUnavailableProblem,
  SymmyInternalPlanPayloadSchema,
  SymmyInternalReadQuerySchema,
} from './contract.ts';
import type {
  SymmyCustomerFieldName,
  SymmyProductFieldName,
  SymmyRegionFieldName,
  SymmyClientIdempotencyKeySchema,
  symmyFixtureIntentConflictProblem,
  symmyFixtureJobNotFoundProblem,
  SymmyFixtureItemResultsSchema,
  SymmyFixtureJobIdSchema,
  SymmyFixtureSubmitPayloadSchema,
  SymmyIngressProblem,
} from './contract.ts';
import type { SymmyInternalRegionsProjectionSchema } from './regions-projection-contract.ts';
import { mapSymmyCustomersBatchRequest } from './customers-batch-public-contract.ts';
import { SymmyCustomerGroupsBatchResponseSchema } from './customer-groups-batch-public-contract.ts';
import { mapSymmyGroupCustomersBatchRequest } from './group-customers-batch-request-contract.ts';
import type { SymmyGroupCustomersBatchPayloadSchema } from './group-customers-batch-request-contract.ts';
import { mapSymmyStockBatchRequest, SymmyStockBatchResponseSchema } from './stock-batch-public-contract.ts';
import type { SymmyStockBatchRequest } from './stock-batch-request-contract.ts';
import { mapSymmyPriceListsBatchRequest } from './price-lists-batch-upsert-public-contract.ts';
import { mapSymmyPriceListPricesBatchRequest } from './price-lists-prices-batch-public-contract.ts';
import { mapSymmyProductsBatchRequest } from './products-batch-public-contract.ts';
import { mapSymmyCustomersProjection, SymmyCustomersResponseSchema } from './customers-public-contract.ts';
import {
  mapSymmyProductsProjection,
  selectSymmyProductFields,
  SymmyProductsResponseSchema,
  SymmyProductsSuccessSchema,
} from './products-public-contract.ts';
import { mapSymmyPriceListsProjection, SymmyPriceListsResponseSchema } from './price-lists-public-contract.ts';
import {
  mapSymmyRegionsProjection,
  selectSymmyRegionFields,
  SymmyRegionsResponseSchema,
  SymmyRegionsSuccessSchema,
} from './regions-public-contract.ts';
import type {
  SymmyInternalCustomersProjectionSchema,
  SymmyInternalPriceListsProjectionSchema,
  SymmyInternalProductsProjectionSchema,
} from './read-projection-contracts.ts';

import { SymmyRouteNotFoundProblemSchema, symmyRouteNotFoundProblem } from './defect-boundary.ts';

export const SymmyHostMount = Context.Reference<boolean>('@app/shell-super-app/api/symmy/transport/SymmyHostMount', {
  defaultValue: () => false,
});

type RouteKeyWith<Fields> = {
  [Key in SymmyRouteKey]: (typeof SYMMY_ROUTES)[Key] extends Fields ? Key : never;
}[SymmyRouteKey];
type Reads = RouteKeyWith<{ readonly mode: 'business_read' }>;
type JobWrites = RouteKeyWith<{ readonly mode: 'durable_job' }> | keyof typeof SYMMY_FIXTURE_ROUTES;
type SelectedWrites = RouteKeyWith<{ readonly selector: 'code' }>;

interface FixtureRead {
  /**
   * `q` is the free-text filter of the regions, products and customers reads only, and `fields` is the part
   * selection of the customers read: the customers read must not call the owners of an unselected part.
   * Every other read route rejects both at the decoder.
   */
  readonly query?: typeof SymmyInternalReadQuerySchema.Type & {
    readonly fields?: readonly SymmyCustomerFieldName[] | undefined;
    readonly q?: string;
  };
  readonly route: Reads;
}
interface RegionsRead extends FixtureRead {
  readonly fields: readonly SymmyRegionFieldName[] | undefined;
  readonly query: NonNullable<FixtureRead['query']>;
  readonly route: 'adminRegions';
}
interface ProductsRead extends FixtureRead {
  readonly fields: readonly SymmyProductFieldName[] | undefined;
  readonly query: NonNullable<FixtureRead['query']>;
  readonly route: 'adminProducts';
}
interface FixturePoll {
  readonly id: typeof SymmyFixtureJobIdSchema.Type;
  readonly route: 'job';
}
/** The public customer groups. Every group request is a real import, so its replay key is required (428). */
interface GroupApply {
  readonly customerGroups: SymmyCustomerGroupRows;
  readonly idempotencyKey?: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly route: 'customerGroupsBatch';
}
/** The public stock rows. Every stock request is a real import, so its replay key is required (428). */
interface StockApply {
  readonly idempotencyKey?: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly route: 'inventoryStockBatch';
  readonly stock: SymmyStockRows;
}
type FixtureApply = GroupApply | StockApply;
/** The public price lists. The owner admission builds the plan; the dispatch reads the catalog head it fences on. */
interface PriceListsSubmit {
  readonly idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly priceLists: SymmyPriceListRows;
  readonly route: 'priceListsBatchUpsert';
}
/** The public price batch. The owner admission builds the plan; the dispatch reads what it fences REVISE items on. */
interface PriceBatchSubmit {
  readonly idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly priceBatch: SymmyPriceBatch;
  readonly route: 'priceListPricesBatch';
}
/** The public products. The owner admission builds the plan; the dispatch reads the price lists the codes name. */
interface ProductsSubmit {
  readonly idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly products: SymmyProductRows;
  readonly route: 'productsBatch';
}
/** The public customers. The owner admission builds the plan from the route enrollment and its selling legal entity. */
interface CustomersSubmit {
  readonly customers: SymmyCustomerRows;
  readonly idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly route: 'customersBatch';
}
/**
 * The customers of the group the path code selects. The code selects the enrolled route that binds the group; the
 * owner admission builds the plan from that route and reserves the order of each customer's memberships.
 */
interface GroupCustomersSubmit {
  readonly code: string;
  readonly groupCustomers: SymmyGroupCustomerRows;
  readonly idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly route: SelectedWrites;
}
/** An internal plan on the selected customer group route. The owner admission orders each membership it states. */
type GroupPlanSubmit = typeof SymmyInternalPlanPayloadSchema.Type & {
  readonly code: string;
  readonly idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly route: SelectedWrites;
};
/** The operator fixture routes: a registered fixture identity, never a plan. */
type PolicyFixtureSubmit = typeof SymmyFixtureSubmitPayloadSchema.Type & {
  readonly idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly route: Exclude<
    JobWrites,
    SelectedWrites | 'customersBatch' | 'priceListsBatchUpsert' | 'priceListPricesBatch' | 'productsBatch'
  >;
};
type FixtureSubmit =
  | PolicyFixtureSubmit
  | GroupCustomersSubmit
  | GroupPlanSubmit
  | CustomersSubmit
  | PriceBatchSubmit
  | PriceListsSubmit
  | ProductsSubmit;
export type SymmyIngressRequest = FixtureRead | FixturePoll | FixtureApply | FixtureSubmit;

export interface SymmyIngressAdmission {
  /** Request-local issuer capability. A fresh credential is verified for every receiving attempt. */
  readonly acquireOwnerAssertion?: (input: {
    readonly audience: string;
    readonly legalEntityId?: string;
  }) => Effect.Effect<SymmyOwnerAssertion, SymmyIngressProblem>;
  readonly acquireRouteAssertion?: (input: {
    readonly code?: string;
    readonly routeKey: Exclude<SymmyRouteKey, 'job'> | keyof typeof SYMMY_FIXTURE_ROUTES;
  }) => Effect.Effect<
    SymmyOwnerAssertion & { readonly route: typeof SymmyRouteContextResponseSchema.Type },
    SymmyIngressProblem
  >;
  readonly apiBaseUrl: string;
  readonly assertion: Redacted.Redacted;
  readonly compositionRevision: string;
}

export interface SymmyOwnerAssertion {
  readonly apiBaseUrl: string;
  readonly assertion: Redacted.Redacted;
  readonly compositionRevision: string;
}

interface FixtureInput<Request extends SymmyIngressRequest> {
  readonly admission: SymmyIngressAdmission;
  readonly request: Request;
}
type FixtureItems = EffectArray.NonEmptyReadonlyArray<SymmyItemOutcome>;
type FixtureItemResult = (typeof SymmyFixtureItemResultsSchema.Type)['items'][number];
type FixtureJobState =
  | { readonly items?: readonly SymmyItemOutcome[]; readonly phase: 'admitted' }
  | { readonly items?: readonly SymmyItemOutcome[]; readonly phase: 'running' }
  | { readonly items: readonly SymmyItemOutcome[]; readonly phase: 'blocked' }
  | { readonly items: FixtureItems; readonly phase: 'completed' }
  | { readonly items: FixtureItems; readonly phase: 'indeterminate' };
type FixtureDispatch<Request extends SymmyIngressRequest, Result, Problem = SymmyIngressProblem> = (
  input: FixtureInput<Request>,
) => Effect.Effect<Result, Problem>;

export interface SymmyIngressDispatch {
  readonly apply: FixtureDispatch<
    FixtureApply,
    FixtureItems,
    SymmyIngressProblem | typeof symmyIdempotencyRequiredProblem | typeof symmyFixtureIntentConflictProblem
  >;
  readonly poll: FixtureDispatch<
    FixturePoll,
    FixtureJobState,
    SymmyIngressProblem | typeof symmyFixtureJobNotFoundProblem
  >;
  readonly read: FixtureDispatch<
    FixtureRead,
    | readonly string[]
    | typeof SymmyInternalRegionsProjectionSchema.Type
    | typeof SymmyInternalProductsProjectionSchema.Type
    | typeof SymmyInternalPriceListsProjectionSchema.Type
    | typeof SymmyInternalCustomersProjectionSchema.Type
  >;
  readonly submit: FixtureDispatch<
    FixtureSubmit,
    typeof SymmyFixtureJobIdSchema.Type,
    SymmyIngressProblem | typeof symmyFixtureIntentConflictProblem
  >;
}

export class SymmyIngress extends Context.Service<
  SymmyIngress,
  {
    readonly admit: (
      rawKey: string,
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<SymmyIngressAdmission, SymmyIngressProblem, HttpServerRequest.HttpServerRequest>;
    readonly dispatch: SymmyIngressDispatch;
  }
>()('@app/shell-super-app/api/symmy/transport/SymmyIngress') {}

const authenticationRequired = GatewayAuthenticationRequiredProblemSchema.make({
  detail: 'A valid API key is required.',
  status: GatewayAuthenticationRequiredProblemSchema.fields.status.literal,
  title: 'Gateway authentication required',
  type: 'https://ontos.dev/problems/gateway-authentication-required',
});

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', 'no-store')),
);
const apiKeyChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'ApiKey realm="ontos-gateway"')),
);
const requireAuthentication = apiKeyChallenge.pipe(Effect.andThen(Effect.fail(authenticationRequired)));

const respondNotFound = HttpServerResponse.schemaJson(SymmyRouteNotFoundProblemSchema)(symmyRouteNotFoundProblem, {
  contentType: problemDetailsContentType,
  headers: { 'cache-control': 'no-store' },
  status: symmyRouteNotFoundProblem.status,
}).pipe(Effect.orDie);

const respondMethodNotAllowed = (allowed: HttpMethod.HttpMethod) =>
  HttpServerResponse.schemaJson(SymmyMethodNotAllowedProblemSchema)(symmyMethodNotAllowedProblem, {
    contentType: problemDetailsContentType,
    headers: { allow: allowed, 'cache-control': 'no-store' },
    status: symmyMethodNotAllowedProblem.status,
  }).pipe(Effect.orDie);

const routePaths = Object.values({ ...SYMMY_ROUTES, ...SYMMY_FIXTURE_ROUTES }).map(({ method, path }) => ({
  method,
  segments: path.split('/'),
}));

const rejectedRoute = Effect.fn('SymmyIngress.rejectRoute')(function* rejectSymmyRoute(
  request: HttpServerRequest.HttpServerRequest,
) {
  if (!(yield* SymmyHostMount)) {
    return yield* respondNotFound;
  }
  const segments = Option.getOrUndefined(HttpServerRequest.toURL(request))?.pathname.split('/');
  const route =
    segments === undefined
      ? undefined
      : routePaths.find(
          ({ segments: template }) =>
            template.length === segments.length &&
            template.every(
              (segment, index) => segment === segments[index] || segment === '{code}' || segment === '{id}',
            ),
        );
  return yield* route === undefined || route.method === request.method
    ? respondNotFound
    : respondMethodNotAllowed(route.method);
});

const isSymmyPath = (path: string): boolean => path === SYMMY_REST_PREFIX || path.startsWith(`${SYMMY_REST_PREFIX}/`);

const queryRepeatsCredential = Effect.fn('SymmyIngress.queryRepeatsCredential')(function* queryContainsCredential(
  read: FixtureRead,
  raw: string,
) {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toType(SymmyInternalReadQuerySchema)))(
    read.query ?? {},
  ).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)));
  return encoded.includes(raw) || (read.query?.q ?? '').includes(raw);
});

const repeatsCredential = Effect.fn('SymmyIngress.repeatsCredential')(function* credentialInRequest(
  request: SymmyIngressRequest,
  credential: Redacted.Redacted,
) {
  const raw = Redacted.value(credential);
  if (
    ('fixtureId' in request && request.fixtureId.includes(raw)) ||
    ('idempotencyKey' in request && request.idempotencyKey !== undefined && request.idempotencyKey.includes(raw)) ||
    ('code' in request && request.code.includes(raw)) ||
    ('id' in request && request.id.includes(raw))
  ) {
    return true;
  }
  if ('stock' in request) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyStockRowsSchema))(request.stock).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
    );
    return encoded.includes(raw);
  }
  if ('customers' in request) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyCustomerRowsSchema))(request.customers).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
    );
    return encoded.includes(raw);
  }
  if ('customerGroups' in request) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyCustomerGroupRowsSchema))(
      request.customerGroups,
    ).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)));
    return encoded.includes(raw);
  }
  if ('groupCustomers' in request) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyGroupCustomerRowsSchema))(
      request.groupCustomers,
    ).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)));
    return encoded.includes(raw);
  }
  if ('plan' in request) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyInternalPlanPayloadSchema.fields.plan))(
      request.plan,
    ).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)));
    return encoded.includes(raw);
  }
  if ('products' in request) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyProductRowsSchema))(request.products).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
    );
    return encoded.includes(raw);
  }
  if ('priceBatch' in request) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyPriceBatchSchema))(request.priceBatch).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
    );
    return encoded.includes(raw);
  }
  if ('priceLists' in request) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyPriceListRowsSchema))(
      request.priceLists,
    ).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)));
    return encoded.includes(raw);
  }
  return yield* Match.value(request).pipe(
    Match.whenOr(
      { route: 'adminCustomers' },
      { route: 'adminProducts' },
      { route: 'adminRegions' },
      { route: 'priceLists' },
      (read) => queryRepeatsCredential(read, raw),
    ),
    Match.orElse(() => Effect.succeed(false)),
  );
});

/** Modern strips the active BFF mount. Restore only its trusted, original Symmy path before routing. */
export const SymmyHostMountLive = HttpRouter.middleware(
  Effect.fn('SymmyIngress.restoreMount')(function* restoreSymmyMount(
    next: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
  ) {
    const originalPath = Option.getOrUndefined(yield* Effect.option(Effect.try(() => useEffectContext().path)));
    const request = yield* HttpServerRequest.HttpServerRequest;
    const mountedUrl = Option.getOrUndefined(HttpServerRequest.toURL(request));
    if (originalPath !== undefined && isSymmyPath(originalPath) && mountedUrl !== undefined) {
      if (
        originalPath.includes('//') ||
        originalPath.endsWith('/') ||
        originalPath.includes('%') ||
        originalPath.includes(';')
      ) {
        return yield* respondNotFound;
      }
      return yield* next.pipe(
        Effect.updateService(SymmyHostMount, () => true),
        Effect.updateService(HttpServerRequest.HttpServerRequest, (mounted) =>
          mounted.modify({ url: originalPath + mountedUrl.search }),
        ),
      );
    }
    if (mountedUrl !== undefined && isSymmyPath(mountedUrl.pathname)) {
      return yield* respondNotFound;
    }
    return yield* next;
  }),
  { global: true },
);

const handle = <Request extends SymmyIngressRequest, Result, DispatchProblem>(
  success: Schema.Codec<Result, unknown>,
  dispatch: (
    ingress: typeof SymmyIngress.Service,
    input: FixtureInput<Request>,
  ) => Effect.Effect<Result, DispatchProblem>,
) => {
  const validateResult = Schema.decodeUnknownEffect(Schema.toType(success));
  return Effect.fn('SymmyIngress.handle')(function* handleSymmyIngress(
    rawKey: string | undefined,
    request: Request,
    httpRequest: HttpServerRequest.HttpServerRequest,
  ) {
    yield* noStore;
    if (rawKey === undefined || rawKey.trim().length === 0) {
      return yield* requireAuthentication;
    }
    if (yield* repeatsCredential(request, Redacted.make(rawKey.trim()))) {
      return yield* Effect.fail(symmyInvalidProblem);
    }
    const ingress = yield* SymmyIngress;
    const admission = yield* ingress
      .admit(rawKey, httpRequest)
      .pipe(Effect.catchTag('GatewayAuthenticationRequiredProblem', () => requireAuthentication));
    const result = yield* dispatch(ingress, { admission, request }).pipe(
      Effect.tapError((problem) =>
        Predicate.isTagged(problem, 'GatewayAuthenticationRequiredProblem') ? apiKeyChallenge : Effect.void,
      ),
    );
    // Keep response defects out of the HttpApi request-schema error mapper.
    return yield* validateResult(result).pipe(
      Effect.catchTag('SchemaError', () => Effect.die('Invalid Symmy fixture response')),
    );
  });
};

const projectItems = <Items extends readonly SymmyItemOutcome[]>(items: Items) =>
  EffectArray.map<Items, FixtureItemResult>((item) => ({
    effects: item.effects,
    itemId: item.itemId,
    outcome: summarizeSymmyItemOutcome(item),
  }))(items);

const validateCustomersBody = Schema.decodeUnknownEffect(Schema.toType(SymmyCustomersResponseSchema));
/** The customers read answers only the public body. Anything but a customers projection is unavailable, never an empty list. */
const handleCustomersRead = handle(SymmyCustomersResponseSchema, (ingress, input: FixtureInput<FixtureRead>) =>
  ingress.dispatch
    .read(input)
    .pipe(
      Effect.flatMap((result) =>
        'projection' in result && result.projection === 'customers'
          ? validateCustomersBody(mapSymmyCustomersProjection(result)).pipe(
              Effect.catchTag('SchemaError', () => Effect.die('Invalid Symmy customers response')),
            )
          : Effect.fail(symmyUnavailableProblem),
      ),
    ),
);
const validateProductsBody = Schema.decodeUnknownEffect(Schema.toType(SymmyProductsResponseSchema));
/** The products read answers only the public body. Anything but a products projection is unavailable, never an empty list. */
const handleProductsRead = handle(SymmyProductsSuccessSchema, (ingress, input: FixtureInput<ProductsRead>) =>
  ingress.dispatch
    .read({ admission: input.admission, request: { query: input.request.query, route: 'adminProducts' } })
    .pipe(
      Effect.flatMap((result) =>
        'projection' in result && result.projection === 'products'
          ? validateProductsBody(mapSymmyProductsProjection(result)).pipe(
              Effect.catchTag('SchemaError', () => Effect.die('Invalid Symmy products response')),
            )
          : Effect.fail(symmyUnavailableProblem),
      ),
      Effect.map((body) =>
        input.request.fields === undefined ? body : selectSymmyProductFields(body, input.request.fields),
      ),
    ),
);
const validateRegionsBody = Schema.decodeUnknownEffect(Schema.toType(SymmyRegionsResponseSchema));
/** The regions read answers only the public body. Anything but a regions projection is unavailable, never an empty list. */
const handleRegionsRead = handle(SymmyRegionsSuccessSchema, (ingress, input: FixtureInput<RegionsRead>) =>
  ingress.dispatch
    .read({ admission: input.admission, request: { query: input.request.query, route: 'adminRegions' } })
    .pipe(
      Effect.flatMap((result) =>
        'projection' in result && result.projection === 'regions'
          ? validateRegionsBody(mapSymmyRegionsProjection(result)).pipe(
              Effect.catchTag('SchemaError', () => Effect.die('Invalid Symmy regions response')),
            )
          : Effect.fail(symmyUnavailableProblem),
      ),
      Effect.map((body) =>
        input.request.fields === undefined ? body : selectSymmyRegionFields(body, input.request.fields),
      ),
    ),
);
/** The price lists read answers only the public body. Anything but a price list projection is unavailable. */
const handlePriceListsRead = handle(SymmyPriceListsResponseSchema, (ingress, input: FixtureInput<FixtureRead>) =>
  ingress.dispatch
    .read(input)
    .pipe(
      Effect.flatMap((result) =>
        'projection' in result && result.projection === 'price_lists'
          ? Effect.succeed(mapSymmyPriceListsProjection(result))
          : Effect.fail(symmyUnavailableProblem),
      ),
    ),
);
/** One result per submitted group, in request order, each carrying the code of the group it answers. */
const handleGroupApply = handle(SymmyCustomerGroupsBatchResponseSchema, (ingress, input: FixtureInput<GroupApply>) =>
  (input.request.idempotencyKey === undefined
    ? Effect.fail(symmyIdempotencyRequiredProblem)
    : ingress.dispatch.apply(input)
  ).pipe(
    Effect.flatMap((items) =>
      items.length === input.request.customerGroups.length
        ? Effect.succeed({
            items: EffectArray.zipWith(projectItems(items), input.request.customerGroups, (item, group) => ({
              ...item,
              code: group.code,
            })),
          })
        : Effect.die('Invalid Symmy customer groups response'),
    ),
  ),
);
/** One result per submitted row, in request order, each carrying the keys of the row it answers. */
const handleStockApply = handle(SymmyStockBatchResponseSchema, (ingress, input: FixtureInput<StockApply>) =>
  (input.request.idempotencyKey === undefined
    ? Effect.fail(symmyIdempotencyRequiredProblem)
    : ingress.dispatch.apply(input)
  ).pipe(
    Effect.flatMap((items) =>
      items.length === input.request.stock.length
        ? Effect.succeed({
            items: EffectArray.zipWith(projectItems(items), input.request.stock, (item, row) => ({
              ...item,
              itemKey: row.itemKey,
              locationKey: row.locationKey,
            })),
          })
        : Effect.die('Invalid Symmy stock response'),
    ),
  ),
);
const handleSubmit = handle(SymmyFixtureAdmissionSchema, (ingress, input: FixtureInput<FixtureSubmit>) =>
  ingress.dispatch.submit(input).pipe(Effect.map((jobId) => ({ jobId, status: 'queued' as const }))),
);
const handlePoll = handle(SymmyFixtureJobStatusSchema, (ingress, input: FixtureInput<FixturePoll>) =>
  ingress.dispatch.poll(input).pipe(
    Effect.map((state) => {
      const jobId = input.request.id;
      if (state.phase === 'admitted' || state.phase === 'running' || state.phase === 'blocked') {
        const status = state.phase === 'admitted' ? ('queued' as const) : state.phase;
        return state.items === undefined ? { jobId, status } : { items: projectItems(state.items), jobId, status };
      }
      const items = projectItems(state.items);
      if (
        state.phase === 'indeterminate' ||
        items.some(({ effects }) => effects.some(({ status }) => status === 'indeterminate'))
      ) {
        return { items, jobId, status: 'indeterminate' as const };
      }
      if (items.every(({ outcome }) => outcome === 'accepted')) {
        return { items, jobId, status: 'completed_all' as const };
      }
      const hasAcceptedEffect = items.some(({ outcome }) => outcome !== 'not_accepted');
      return { items, jobId, status: hasAcceptedEffect ? ('completed_partial' as const) : ('completed_none' as const) };
    }),
  ),
);

const groupRequest = (
  customerGroups: SymmyCustomerGroupRows,
  idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type | undefined,
): GroupApply =>
  idempotencyKey === undefined
    ? { customerGroups, route: 'customerGroupsBatch' }
    : { customerGroups, idempotencyKey, route: 'customerGroupsBatch' };

/** The customers of the selected group, or an internal plan. */
const groupCustomersRequest = (
  code: string,
  payload: typeof SymmyGroupCustomersBatchPayloadSchema.Type,
  idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type,
): GroupCustomersSubmit | GroupPlanSubmit =>
  Schema.is(Schema.toType(SymmyInternalPlanPayloadSchema))(payload)
    ? { ...payload, code, idempotencyKey, route: 'customerGroupCustomersBatch' }
    : {
        code,
        groupCustomers: mapSymmyGroupCustomersBatchRequest(payload),
        idempotencyKey,
        route: 'customerGroupCustomersBatch',
      };

const stockRequest = (
  payload: SymmyStockBatchRequest,
  idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type | undefined,
): StockApply => {
  const stock = mapSymmyStockBatchRequest(payload);
  return idempotencyKey === undefined
    ? { route: 'inventoryStockBatch', stock }
    : { idempotencyKey, route: 'inventoryStockBatch', stock };
};

export const SymmyIngressHandlersLive = HttpApiBuilder.group(ShellAuthenticationApi, 'symmy', (group) =>
  group
    .handle('adminCustomers', ({ headers, query: { fields, ...read }, request }) =>
      handleCustomersRead(
        headers['x-api-key'],
        {
          query: { ...read, contractVersion: 'INTERNAL_C14', fields: fields?.filter(isSymmyCustomerFieldName) },
          route: 'adminCustomers',
        },
        request,
      ),
    )
    .handle('adminProducts', ({ headers, query: { fields, ...read }, request }) =>
      handleProductsRead(
        headers['x-api-key'],
        {
          fields: fields?.filter(isSymmyProductFieldName),
          query: { ...read, contractVersion: 'INTERNAL_C14' },
          route: 'adminProducts',
        },
        request,
      ),
    )
    .handle('adminRegions', ({ headers, query: { fields, ...read }, request }) =>
      handleRegionsRead(
        headers['x-api-key'],
        {
          fields: fields?.filter(isSymmyRegionFieldName),
          query: { ...read, contractVersion: 'INTERNAL_C14' },
          route: 'adminRegions',
        },
        request,
      ),
    )
    .handle('customerGroupCustomersBatch', ({ headers, params, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        groupCustomersRequest(params.code, payload, headers['idempotency-key']),
        request,
      ),
    )
    .handle('customerGroupsBatch', ({ headers, payload, request }) =>
      handleGroupApply(headers['x-api-key'], groupRequest(payload.customerGroups, headers['idempotency-key']), request),
    )
    .handle('customersBatch', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        {
          customers: mapSymmyCustomersBatchRequest(payload),
          idempotencyKey: headers['idempotency-key'],
          route: 'customersBatch',
        },
        request,
      ),
    )
    .handle('inventoryStockBatch', ({ headers, payload, request }) =>
      handleStockApply(headers['x-api-key'], stockRequest(payload, headers['idempotency-key']), request),
    )
    .handle('job', ({ headers, params, request }) =>
      handlePoll(headers['x-api-key'], { id: params.id, route: 'job' }, request),
    )
    .handle('priceListPricesBatch', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        {
          idempotencyKey: headers['idempotency-key'],
          priceBatch: mapSymmyPriceListPricesBatchRequest(payload),
          route: 'priceListPricesBatch',
        },
        request,
      ),
    )
    .handle('priceLists', ({ headers, query, request }) =>
      handlePriceListsRead(
        headers['x-api-key'],
        { query: { ...query, contractVersion: 'INTERNAL_C14' }, route: 'priceLists' },
        request,
      ),
    )
    .handle('priceListsBatchUpsert', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        {
          idempotencyKey: headers['idempotency-key'],
          priceLists: mapSymmyPriceListsBatchRequest(payload),
          route: 'priceListsBatchUpsert',
        },
        request,
      ),
    )
    .handle('assortmentRulesFixtureBatch', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        { ...payload, idempotencyKey: headers['idempotency-key'], route: 'assortmentRulesFixtureBatch' },
        request,
      ),
    )
    .handle('sellerVatDeclarationsFixtureBatch', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        { ...payload, idempotencyKey: headers['idempotency-key'], route: 'sellerVatDeclarationsFixtureBatch' },
        request,
      ),
    )
    .handle('productsBatch', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        {
          idempotencyKey: headers['idempotency-key'],
          products: mapSymmyProductsBatchRequest(payload),
          route: 'productsBatch',
        },
        request,
      ),
    ),
);
export const SymmyIngressSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(SymmySchemaError, () =>
  Effect.fail(symmyInvalidProblem),
);

// The fallback depends on the trusted host mount and emits only typed route errors.
export const SymmyIngressTransportLive = HttpRouter.add('*', '/api/symmy/v1/*', (request) => rejectedRoute(request));
