import { SYMMY_FIXTURE_ROUTES } from '@app/shared-contracts/symmy';
import { GatewayAuthenticationRequiredProblemSchema, GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import { executeAdmitSymmyJobWithAuthorization } from '@app/symmy-integration/api/admit-symmy-job-action/client';
import { executeAdmitSymmySyncWithAuthorization } from '@app/symmy-integration/api/admit-symmy-sync-action/client';
import { AdmitSymmySyncPayloadSchema } from '@app/symmy-integration/api/admit-symmy-sync-action';
import { executeSymmyJobStatusWithAuthorization } from '@app/symmy-integration/api/symmy-job-status/client';
import { executeSymmyRouteContextWithAuthorization } from '@app/symmy-integration/api/symmy-route-context/client';
import { Array as EffectArray, Config, Context, Crypto, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';

import { resolveSymmyOwnerReleaseBase } from './owner-release-transport.ts';

import {
  symmyFixtureIntentConflictProblem,
  SymmyFixtureJobIdSchema,
  symmyFixtureJobNotFoundProblem,
  symmyUnavailableProblem,
  symmyInvalidProblem,
  symmyUnsupportedProblem,
  SymmyInternalPlanPayloadSchema,
} from './contract.ts';
import type { SymmyIngressDispatch, SymmyIngressAdmission, SymmyOwnerAssertion } from './transport.ts';
import { readSymmyPriceBatchFacts } from './price-batch-facts.ts';
import { readSymmyProductPriceGroupFacts } from './product-batch-facts.ts';
import {
  acquireSymmyReadAssertion,
  mapSymmyOwnerReadProblem,
  projectSymmySourcePriceLists,
  projectSymmySourceProducts,
  projectSymmySourceCustomers,
  readSymmyPriceGroupCatalogHead,
} from './source-read-projections.ts';
import {
  projectSymmyRegionsWithCrypto,
  SymmyRegionsProjectionConfigurationSchema,
  SymmyRegionsProjectionScopeSchema,
} from './regions-projection.ts';
import type { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import { SymmyRouteContextRequestSchema } from '@app/symmy-integration/api/symmy-route-context';
import {
  SymmyEncodedSourceCodeSchema,
  decodeSymmySourceSelector,
  verifySymmySourceSelector,
} from '@app/symmy-integration/symmy-source-selector';
import type {
  SymmyDecodedSourceSelector,
  SymmySourceSelectorError,
} from '@app/symmy-integration/symmy-source-selector';

export { forwardSymmyOwnerRelease } from './owner-release-transport.ts';

const symmyAudience = 'symmy-integration';

export class SymmyGovernedDispatch extends Context.Service<SymmyGovernedDispatch, SymmyIngressDispatch>()(
  '@app/shell-super-app/api/symmy/governed-dispatch/SymmyGovernedDispatch',
) {}

const authenticationRequired = GatewayAuthenticationRequiredProblemSchema.make({
  detail: 'The integration request needs a fresh authenticated invocation.',
  status: GatewayAuthenticationRequiredProblemSchema.fields.status.literal,
  title: 'Gateway authentication required',
  type: 'https://ontos.dev/problems/gateway-authentication-required',
});

const forbidden = GatewayForbiddenProblemSchema.make({
  detail: 'The current principal cannot use this integration operation.',
  status: GatewayForbiddenProblemSchema.fields.status.literal,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});

const unavailable = () => Effect.fail(symmyUnavailableProblem);
const selectorProblem = (error: SymmySourceSelectorError) =>
  Match.value(error.reason).pipe(
    Match.when('invalid_selector', () => symmyInvalidProblem),
    Match.when('source_scope_mismatch', () => forbidden),
    Match.exhaustive,
  );
type QualifiedSourceSelector = Extract<SymmyDecodedSourceSelector, { readonly _tag: 'Qualified' }>;
const verifyQualifiedSource = Effect.fn('SymmyGovernedDispatch.verifyQualifiedSource')(function* verifyQualified(
  selector: QualifiedSourceSelector,
  route: typeof SymmyRouteContextResponseSchema.Type,
) {
  const enrolled = route.selector;
  if (enrolled === undefined || enrolled.target === undefined) {
    return yield* unavailable();
  }
  if (enrolled.kind !== 'CUSTOMER_GROUP') {
    return yield* Effect.fail(forbidden);
  }
  yield* verifySymmySourceSelector(
    selector,
    {
      issuerId: enrolled.source.issuerId,
      routeId: enrolled.source.route.integrationRouteId,
      selectorKind: enrolled.kind,
      sourceNamespace: enrolled.source.sourceNamespace,
      tenantId: enrolled.source.route.tenantId,
    },
    enrolled.source.sourceRecordId,
    enrolled.target.resourceId,
  ).pipe(Effect.mapError(selectorProblem));
  return route.resolvedCode ?? (yield* unavailable());
});
const verifySelectedSource = (
  selector: SymmyDecodedSourceSelector,
  route: typeof SymmyRouteContextResponseSchema.Type,
) =>
  Match.value(selector).pipe(
    Match.tag('Legacy', ({ code }) => Effect.succeed(code)),
    Match.tag('Qualified', (qualified) => verifyQualifiedSource(qualified, route)),
    Match.exhaustive,
  );

const resolveRelayBase = (path: string) => resolveSymmyOwnerReleaseBase(path, symmyAudience);

const priceGroupModule = 'pricing.price-group-catalog';
const requireReadOperation = (
  route: typeof SymmyRouteContextResponseSchema.Type,
  moduleId: string,
  entrypointKey: string,
) =>
  route.allowedOwnerOperations.some(
    (operation) =>
      operation.moduleId === moduleId && operation.entrypointKey === entrypointKey && operation.schemaVersion === '1',
  )
    ? Effect.void
    : Effect.fail(forbidden);

const acquireScopedRouteContext = Effect.fn('SymmyGovernedDispatch.acquireScopedRouteContext')(function* scopedContext(
  admission: SymmyIngressAdmission,
  input: typeof SymmyRouteContextRequestSchema.Encoded,
  newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>,
) {
  const payload = yield* Schema.decodeUnknownEffect(SymmyRouteContextRequestSchema)(input).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
  );

  if (admission.acquireRouteAssertion !== undefined) {
    const current = yield* admission.acquireRouteAssertion(payload);
    if (current.compositionRevision !== admission.compositionRevision) {
      return yield* unavailable();
    }
    const baseUrl = yield* resolveRelayBase(current.apiBaseUrl);
    const scoped: SymmyOwnerAssertion = {
      apiBaseUrl: baseUrl.toString(),
      assertion: current.assertion,
      compositionRevision: current.compositionRevision,
    };
    return { route: current.route, scoped: Option.some(scoped) };
  }
  const baseUrl = yield* resolveRelayBase(admission.apiBaseUrl);
  const route = yield* executeSymmyRouteContextWithAuthorization(
    payload,
    `Bearer ${Redacted.value(admission.assertion)}`,
    yield* newRequestIdentifier,
    { baseUrl, compositionRevision: admission.compositionRevision },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  return { route, scoped: Option.none<SymmyOwnerAssertion>() };
});

/** The stock route sends only its rows; the group route sends a fixture identity or a versioned plan. */
const syncAdmissionSource = (request: Parameters<SymmyIngressDispatch['apply']>[0]['request']) => {
  if ('stock' in request) {
    return { stock: request.stock };
  }
  return 'fixtureId' in request
    ? { fixtureId: request.fixtureId }
    : { contractVersion: request.contractVersion, plan: request.plan };
};

/**
 * What a durable job carries besides its key and route. The price lists carry the catalog head read now, as the
 * route enrolls that read: the owner admission fences the first created list on it and ignores it on a replay.
 * The price batch is authorized here (403 for a list the key may not write to) and carries what the owner holds
 * about each REVISE price, which the owner admission uses on the first admission only. The products carry the price
 * list each price group code names, read the same way. The customers carry nothing more: the route enrollment and
 * the route scope the owner admission reads give it the source and the selling legal entity.
 */
const submitSource = Effect.fn('SymmyGovernedDispatch.submitSource')(function* submitSource(
  request: Parameters<SymmyIngressDispatch['submit']>[0]['request'],
  selected: { readonly route: typeof SymmyRouteContextResponseSchema.Type } | undefined,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>,
) {
  if ('customers' in request) {
    return { customers: request.customers };
  }
  if ('products' in request) {
    if (selected === undefined) {
      return yield* unavailable();
    }
    return {
      priceGroupFacts: yield* readSymmyProductPriceGroupFacts(
        { admission, products: request.products, routeScope: selected.route },
        newRequestIdentifier,
      ),
      products: request.products,
    };
  }
  if ('priceBatch' in request) {
    if (selected === undefined) {
      return yield* unavailable();
    }
    // The owner price reads need a read scope, which only the price list read route proves. The prices route
    // borrows it, exactly as GET /price-lists reads the same schedule and source prices.
    const priceReadScope = acquireScopedRouteContext(admission, { routeKey: 'priceLists' }, newRequestIdentifier).pipe(
      Effect.map(({ route }) => route),
    );
    return {
      priceBatch: request.priceBatch,
      reviseFacts: yield* readSymmyPriceBatchFacts(
        { admission, batch: request.priceBatch, priceReadScope, routeScope: selected.route },
        newRequestIdentifier,
      ),
    };
  }
  if ('priceLists' in request) {
    if (selected === undefined) {
      return yield* unavailable();
    }
    yield* requireReadOperation(
      selected.route,
      priceGroupModule,
      'pricing.price-group-catalog.api.price-group-catalog-head',
    );
    return {
      catalogHead: yield* readSymmyPriceGroupCatalogHead(admission, newRequestIdentifier),
      priceLists: request.priceLists,
    };
  }
  return 'fixtureId' in request
    ? { fixtureId: request.fixtureId }
    : { contractVersion: request.contractVersion, plan: request.plan };
});

const resolveRoute = Effect.fn('SymmyGovernedDispatch.routeContext')(function* routeContext(
  admission: SymmyIngressAdmission,
  request: Exclude<
    | Parameters<SymmyIngressDispatch['submit']>[0]['request']
    | Parameters<SymmyIngressDispatch['apply']>[0]['request']
    | Parameters<SymmyIngressDispatch['read']>[0]['request'],
    { readonly route: 'job' }
  >,
  newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>,
) {
  const selector =
    'code' in request
      ? yield* decodeSymmySourceSelector(request.code).pipe(Effect.mapError(selectorProblem))
      : undefined;
  const input = selector === undefined ? { routeKey: request.route } : { code: selector.code, routeKey: request.route };
  if ('idempotencyKey' in request && request.idempotencyKey !== undefined) {
    Object.assign(input, { replayIdempotencyKey: request.idempotencyKey });
  }
  const prepared = yield* acquireScopedRouteContext(admission, input, newRequestIdentifier);
  const selectedCode =
    selector !== undefined && 'code' in request
      ? Option.some(yield* verifySelectedSource(selector, prepared.route))
      : Option.none<string>();
  return { ...prepared, selectedCode };
});

export const makeSymmyGovernedDispatch = (
  newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>,
  projectRegions?: (
    input: Parameters<typeof projectSymmyRegionsWithCrypto>[0],
    acquire: Parameters<typeof projectSymmyRegionsWithCrypto>[1],
  ) => ReturnType<typeof projectSymmyRegionsWithCrypto>,
): SymmyIngressDispatch => ({
  apply: Effect.fn('SymmyGovernedDispatch.apply')(function* apply({
    admission,
    request,
  }: Parameters<SymmyIngressDispatch['apply']>[0]) {
    const prepared = yield* resolveRoute(admission, request, newRequestIdentifier);
    const scoped = Option.isSome(prepared.scoped)
      ? prepared.scoped.value
      : yield* acquireSymmyReadAssertion(admission, symmyAudience, prepared.route.legalEntityId);
    const source = syncAdmissionSource(request);
    const payload = yield* Schema.decodeUnknownEffect(AdmitSymmySyncPayloadSchema)({
      ...source,
      idempotencyKey: request.idempotencyKey ?? (yield* newRequestIdentifier),
      routeKey: request.route,
    }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)));
    const response = yield* executeAdmitSymmySyncWithAuthorization(
      payload,
      `Bearer ${Redacted.value(scoped.assertion)}`,
      yield* newRequestIdentifier,
      {
        baseUrl: new URL(scoped.apiBaseUrl),
        compositionRevision: admission.compositionRevision,
        idempotencyKey: yield* newRequestIdentifier,
      },
    ).pipe(
      Effect.mapError((error) =>
        Match.value(error._tag).pipe(
          Match.when('AdmitSymmySyncActionAuthenticationProblem', () => authenticationRequired),
          Match.when('AdmitSymmySyncActionForbiddenProblem', () => forbidden),
          Match.when('AdmitSymmySyncActionConflictProblem', () => symmyFixtureIntentConflictProblem),
          Match.when('AdmitSymmySyncActionInvalidProblem', () => symmyInvalidProblem),
          Match.orElse(() => symmyUnavailableProblem),
        ),
      ),
    );
    return response.items;
  }),
  poll: Effect.fn('SymmyGovernedDispatch.poll')(function* poll({
    admission,
    request,
  }: Parameters<SymmyIngressDispatch['poll']>[0]) {
    const baseUrl = yield* resolveRelayBase(admission.apiBaseUrl);
    const requestIdentifier = yield* newRequestIdentifier;
    const result = yield* executeSymmyJobStatusWithAuthorization(
      { jobId: request.id },
      `Bearer ${Redacted.value(admission.assertion)}`,
      requestIdentifier,
      { baseUrl, compositionRevision: admission.compositionRevision },
    ).pipe(
      Effect.mapError((error) =>
        Match.value(error._tag).pipe(
          Match.when('SymmyJobStatusAuthenticationProblem', () => authenticationRequired),
          Match.when('SymmyJobStatusForbiddenProblem', () => forbidden),
          Match.when('SymmyJobStatusNotFoundProblem', () => symmyFixtureJobNotFoundProblem),
          Match.orElse(() => symmyUnavailableProblem),
        ),
      ),
    );
    if (result.jobId !== request.id) {
      return yield* unavailable();
    }
    if (result.phase === 'admitted' || result.phase === 'running') {
      return 'items' in result ? { items: result.items, phase: result.phase } : { phase: result.phase };
    }
    if (result.phase === 'blocked') {
      return { items: result.items, phase: result.phase };
    }
    if (!EffectArray.isReadonlyArrayNonEmpty(result.items)) {
      return yield* unavailable();
    }
    return { items: result.items, phase: result.phase === 'indeterminate' ? 'indeterminate' : 'completed' };
  }),
  read: Effect.fn('SymmyGovernedDispatch.read')(function* read({
    admission,
    request,
  }: Parameters<SymmyIngressDispatch['read']>[0]) {
    const query = request.query ?? {};
    if (query.sourceRecordId !== undefined) {
      return yield* Effect.fail(symmyInvalidProblem);
    }
    if (query.contractVersion !== 'INTERNAL_C14') {
      return yield* unavailable();
    }
    const { route } = yield* resolveRoute(admission, request, newRequestIdentifier);
    if (request.route === 'adminCustomers') {
      yield* requireReadOperation(
        route,
        'commerce.customer-context',
        'commerce.customer-context.api.customer-profile-source',
      );
      return yield* projectSymmySourceCustomers(route, query, admission, newRequestIdentifier);
    }
    if (request.route === 'adminProducts') {
      yield* requireReadOperation(route, 'commerce.catalog', 'commerce.catalog.api.catalog-source-product-page');
      return yield* projectSymmySourceProducts(route, query, admission, newRequestIdentifier);
    }
    if (request.route === 'priceLists') {
      yield* requireReadOperation(
        route,
        priceGroupModule,
        'pricing.price-group-catalog.api.price-group-source-associations',
      );
      yield* requireReadOperation(route, priceGroupModule, 'pricing.price-group-catalog.api.price-group-definition');
      return yield* projectSymmySourcePriceLists(route, query, admission, newRequestIdentifier);
    }
    if (request.route === 'adminRegions') {
      if (projectRegions === undefined) {
        return yield* unavailable();
      }
      if (
        query.code !== undefined ||
        query.afterRecordId !== undefined ||
        query.priceLimit !== undefined ||
        query.priceOffset !== undefined
      ) {
        return yield* Effect.fail(symmyInvalidProblem);
      }
      if (route.legalEntityId === undefined) {
        return yield* Effect.fail(symmyUnsupportedProblem('projection_not_configured'));
      }
      yield* requireReadOperation(
        route,
        'commerce.market-catalog',
        'commerce.market-catalog.api.current-market-catalog',
      );
      yield* requireReadOperation(route, 'commerce.pricing', 'commerce.pricing.api.current-supported-currencies');
      const configuration = yield* Config.schema(
        Schema.fromJsonString(SymmyRegionsProjectionConfigurationSchema),
        'ONTOS_SYMMY_REGIONS_PROJECTION',
      ).pipe(Effect.catchTag('ConfigError', () => Effect.fail(symmyUnsupportedProblem('projection_not_configured'))));
      const scope = yield* Schema.decodeUnknownEffect(SymmyRegionsProjectionScopeSchema)({
        issuerId: route.issuerId,
        legalEntityId: route.legalEntityId,
        route: { integrationRouteId: route.routeId, tenantId: route.tenantId },
        sourceNamespace: route.sourceNamespace,
      }).pipe(Effect.catchTag('SchemaError', unavailable));
      return yield* projectRegions(
        {
          compositionRevision: admission.compositionRevision,
          configuration,
          page: { limit: query.limit ?? 50, offset: query.offset ?? 0, q: query.q },
          scope,
        },
        ({ audience, legalEntityId }) => acquireSymmyReadAssertion(admission, audience, legalEntityId),
      ).pipe(
        Effect.catchTag('SymmyRegionsProjectionError', (error) =>
          Effect.fail(
            Match.value(error.reason).pipe(
              Match.when('owner_authentication_required', () => authenticationRequired),
              Match.when('owner_forbidden', () => forbidden),
              Match.whenOr('currency_absent', 'unsupported_jurisdiction', 'market_missing', () =>
                symmyUnsupportedProblem('owner_field_not_supported'),
              ),
              Match.whenOr('configuration_invalid', 'source_scope_mismatch', () =>
                symmyUnsupportedProblem('projection_not_configured'),
              ),
              Match.orElse(() => symmyUnavailableProblem),
            ),
          ),
        ),
      );
    }
    return yield* unavailable();
  }),
  submit: Effect.fn('SymmyGovernedDispatch.submit')(function* submit({
    admission,
    request,
  }: Parameters<SymmyIngressDispatch['submit']>[0]) {
    const needsRoute =
      Object.hasOwn(SYMMY_FIXTURE_ROUTES, request.route) ||
      'priceLists' in request ||
      'priceBatch' in request ||
      'customers' in request ||
      'products' in request ||
      Schema.is(Schema.toType(SymmyInternalPlanPayloadSchema))(request) ||
      ('code' in request && Schema.is(SymmyEncodedSourceCodeSchema)(request.code));
    const selected = needsRoute ? yield* resolveRoute(admission, request, newRequestIdentifier) : undefined;
    const scopedAdmission = yield* selected === undefined
      ? Effect.succeed(admission)
      : Option.match(selected.scoped, {
          onNone: () => acquireSymmyReadAssertion(admission, symmyAudience, selected.route.legalEntityId),
          onSome: Effect.succeed,
        });
    const baseUrl =
      selected === undefined
        ? yield* resolveRelayBase(scopedAdmission.apiBaseUrl)
        : new URL(scopedAdmission.apiBaseUrl);
    const requestIdentifier = yield* newRequestIdentifier;
    const transportKey = yield* newRequestIdentifier;
    const { idempotencyKey, route } = request;
    const basePayload = {
      ...(yield* submitSource(request, selected, admission, newRequestIdentifier)),
      idempotencyKey,
      routeKey: route,
    };
    const selectedCode = selected === undefined ? Option.none<string>() : selected.selectedCode;
    const payload =
      'code' in request ? { ...basePayload, code: Option.getOrElse(selectedCode, () => request.code) } : basePayload;
    const { jobId } = yield* executeAdmitSymmyJobWithAuthorization(
      payload,
      `Bearer ${Redacted.value(scopedAdmission.assertion)}`,
      requestIdentifier,
      { baseUrl, compositionRevision: admission.compositionRevision, idempotencyKey: transportKey },
    ).pipe(
      Effect.mapError((error) =>
        Match.value(error._tag).pipe(
          Match.when('AdmitSymmyJobActionAuthenticationProblem', () => authenticationRequired),
          Match.whenOr('AdmitSymmyJobActionForbiddenProblem', 'AdmitSymmyJobRouteDeniedProblem', () => forbidden),
          Match.when('AdmitSymmyJobIntentConflictProblem', () => symmyFixtureIntentConflictProblem),
          Match.orElse(() => symmyUnavailableProblem),
        ),
      ),
    );
    return yield* Schema.decodeUnknownEffect(SymmyFixtureJobIdSchema)(jobId).pipe(
      Effect.catchTag('SchemaError', unavailable),
    );
  }),
});

export const SymmyGovernedDispatchLive = Layer.effect(
  SymmyGovernedDispatch,
  Effect.gen(function* symmyGovernedDispatchLayer() {
    const crypto = yield* Crypto.Crypto;
    return makeSymmyGovernedDispatch(
      crypto.randomUUIDv4().pipe(Effect.catchTag('PlatformError', unavailable)),
      (input, acquire) => projectSymmyRegionsWithCrypto(input, acquire, crypto),
    );
  }),
);
