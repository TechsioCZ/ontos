import { GatewayAuthenticationRequiredProblemSchema } from '@app/shared-contracts';
import { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import { summarizeSymmyItemOutcome, SYMMY_REST_PREFIX, SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import type { SymmyItemOutcome, SymmyRouteKey } from '@app/shared-contracts/symmy';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
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
  SymmyFixtureAdmissionSchema,
  SymmyFixtureItemResultsSchema,
  SymmyFixtureJobStatusSchema,
  SymmyFixtureReadSchema,
  SymmyMethodNotAllowedProblemSchema,
  SymmySchemaError,
  symmyMethodNotAllowedProblem,
  symmyIdempotencyRequiredProblem,
  SymmyInternalPlanPayloadSchema,
  SymmyInternalReadQuerySchema,
} from '../../shared/symmy/contract.ts';
import type {
  SymmyClientIdempotencyKeySchema,
  symmyFixtureIntentConflictProblem,
  symmyFixtureJobNotFoundProblem,
  SymmyFixtureJobIdSchema,
  SymmyIngressProblem,
  SymmyInternalWritePayloadSchema,
} from '../../shared/symmy/contract.ts';
import { SymmyInternalRegionsProjectionSchema } from '../../shared/symmy/regions-projection-contract.ts';
import {
  SymmyInternalProductsProjectionSchema,
  SymmyInternalPriceListsProjectionSchema,
  SymmyInternalCustomersProjectionSchema,
} from '../../shared/symmy/read-projection-contracts.ts';

import { SymmyRouteNotFoundProblemSchema, symmyRouteNotFoundProblem } from '../../shared/symmy/defect-boundary.ts';

export const SymmyHostMount = Context.Reference<boolean>('@app/shell-super-app/api/symmy/transport/SymmyHostMount', {
  defaultValue: () => false,
});

type RouteKeyWith<Fields> = {
  [Key in SymmyRouteKey]: (typeof SYMMY_ROUTES)[Key] extends Fields ? Key : never;
}[SymmyRouteKey];
type Reads = RouteKeyWith<{ readonly mode: 'business_read' }>;
type ItemWrites = RouteKeyWith<{ readonly mode: 'item_results' }>;
type JobWrites = RouteKeyWith<{ readonly mode: 'durable_job' }>;
type SelectedWrites = RouteKeyWith<{ readonly selector: 'code' }>;

interface FixtureRead {
  readonly query?: typeof SymmyInternalReadQuerySchema.Type;
  readonly route: Reads;
}
interface FixturePoll {
  readonly id: typeof SymmyFixtureJobIdSchema.Type;
  readonly route: 'job';
}
type InternalWritePayload = typeof SymmyInternalWritePayloadSchema.Type;
type FixtureApply = InternalWritePayload & {
  readonly idempotencyKey?: typeof SymmyClientIdempotencyKeySchema.Type;
  readonly route: ItemWrites;
};
type FixtureSubmit = InternalWritePayload & {
  readonly idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type;
} & (
    | { readonly code: string; readonly route: SelectedWrites }
    | { readonly route: Exclude<JobWrites, SelectedWrites> }
  );
export type SymmyIngressRequest = FixtureRead | FixturePoll | FixtureApply | FixtureSubmit;

export interface SymmyIngressAdmission {
  /** Request-local issuer capability. A fresh credential is verified for every receiving attempt. */
  readonly acquireOwnerAssertion?: (input: {
    readonly audience: string;
    readonly legalEntityId?: string;
  }) => Effect.Effect<SymmyOwnerAssertion, SymmyIngressProblem>;
  readonly acquireRouteAssertion?: (input: {
    readonly code?: string;
    readonly routeKey: Exclude<SymmyRouteKey, 'job'>;
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

const routePaths = Object.values(SYMMY_ROUTES).map(({ method, path }) => ({ method, segments: path.split('/') }));

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
  return encoded.includes(raw);
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
  if (Schema.is(Schema.toType(SymmyInternalPlanPayloadSchema))(request)) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyInternalExecutionPlanSchema))(
      request.plan,
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

const makeReadHandler = <Result>(success: Schema.Codec<Result, unknown>) =>
  handle(success, (ingress, input: FixtureInput<FixtureRead>) =>
    ingress.dispatch.read(input).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(Schema.toType(success))('projection' in result ? result : { references: result }),
      ),
      Effect.catchTag('SchemaError', () => Effect.die('Invalid Symmy fixture response')),
    ),
  );
const handleCustomersRead = makeReadHandler(
  Schema.Union([SymmyFixtureReadSchema, SymmyInternalCustomersProjectionSchema]),
);
const handleProductsRead = makeReadHandler(
  Schema.Union([SymmyFixtureReadSchema, SymmyInternalProductsProjectionSchema]),
);
const handleRegionsRead = makeReadHandler(Schema.Union([SymmyFixtureReadSchema, SymmyInternalRegionsProjectionSchema]));
const handlePriceListsRead = makeReadHandler(
  Schema.Union([SymmyFixtureReadSchema, SymmyInternalPriceListsProjectionSchema]),
);
const handleApply = handle(SymmyFixtureItemResultsSchema, (ingress, input: FixtureInput<FixtureApply>) =>
  (Schema.is(Schema.toType(SymmyInternalPlanPayloadSchema))(input.request) && input.request.idempotencyKey === undefined
    ? Effect.fail(symmyIdempotencyRequiredProblem)
    : ingress.dispatch.apply(input)
  ).pipe(Effect.map((items) => ({ items: projectItems(items) }))),
);
const handleSubmit = handle(SymmyFixtureAdmissionSchema, (ingress, input: FixtureInput<FixtureSubmit>) =>
  ingress.dispatch.submit(input).pipe(Effect.map((jobId) => ({ jobId, status: 'admitted' as const }))),
);
const handlePoll = handle(SymmyFixtureJobStatusSchema, (ingress, input: FixtureInput<FixturePoll>) =>
  ingress.dispatch.poll(input).pipe(
    Effect.map((state) => {
      const jobId = input.request.id;
      if (state.phase === 'admitted' || state.phase === 'running' || state.phase === 'blocked') {
        return state.items === undefined
          ? { jobId, status: state.phase }
          : { items: projectItems(state.items), jobId, status: state.phase };
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

const syncRequest = (
  route: ItemWrites,
  payload: InternalWritePayload,
  idempotencyKey: typeof SymmyClientIdempotencyKeySchema.Type | undefined,
): FixtureApply => (idempotencyKey === undefined ? { ...payload, route } : { ...payload, idempotencyKey, route });

export const SymmyIngressHandlersLive = HttpApiBuilder.group(ShellAuthenticationApi, 'symmy', (group) =>
  group
    .handle('adminCustomers', ({ headers, query, request }) =>
      handleCustomersRead(headers['x-api-key'], { query, route: 'adminCustomers' }, request),
    )
    .handle('adminProducts', ({ headers, query, request }) =>
      handleProductsRead(headers['x-api-key'], { query, route: 'adminProducts' }, request),
    )
    .handle('adminRegions', ({ headers, query, request }) =>
      handleRegionsRead(headers['x-api-key'], { query, route: 'adminRegions' }, request),
    )
    .handle('customerGroupCustomersBatch', ({ headers, params, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        {
          code: params.code,
          ...payload,
          idempotencyKey: headers['idempotency-key'],
          route: 'customerGroupCustomersBatch',
        },
        request,
      ),
    )
    .handle('customerGroupsBatch', ({ headers, payload, request }) =>
      handleApply(
        headers['x-api-key'],
        syncRequest('customerGroupsBatch', payload, headers['idempotency-key']),
        request,
      ),
    )
    .handle('customersBatch', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        { ...payload, idempotencyKey: headers['idempotency-key'], route: 'customersBatch' },
        request,
      ),
    )
    .handle('inventoryStockBatch', ({ headers, payload, request }) =>
      handleApply(
        headers['x-api-key'],
        syncRequest('inventoryStockBatch', payload, headers['idempotency-key']),
        request,
      ),
    )
    .handle('job', ({ headers, params, request }) =>
      handlePoll(headers['x-api-key'], { id: params.id, route: 'job' }, request),
    )
    .handle('priceListPricesBatch', ({ headers, params, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        {
          code: params.code,
          ...payload,
          idempotencyKey: headers['idempotency-key'],
          route: 'priceListPricesBatch',
        },
        request,
      ),
    )
    .handle('priceLists', ({ headers, query, request }) =>
      handlePriceListsRead(headers['x-api-key'], { query, route: 'priceLists' }, request),
    )
    .handle('priceListsBatchUpsert', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        { ...payload, idempotencyKey: headers['idempotency-key'], route: 'priceListsBatchUpsert' },
        request,
      ),
    )
    .handle('productsBatch', ({ headers, payload, request }) =>
      handleSubmit(
        headers['x-api-key'],
        { ...payload, idempotencyKey: headers['idempotency-key'], route: 'productsBatch' },
        request,
      ),
    ),
);
export const SymmyIngressSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(SymmySchemaError, () =>
  Effect.fail(symmyInvalidProblem),
);

// The fallback depends on the trusted host mount and emits only typed route errors.
export const SymmyIngressTransportLive = HttpRouter.add('*', '/api/symmy/v1/*', (request) => rejectedRoute(request));
