import { ActiveApplicationCompositionUnavailableError } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { moduleReleaseApiBaseUrl } from '@app/core-runtime/unit-service-fetch';
import { GatewayAuthenticationRequiredProblemSchema, GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import { decodeSymmyItemOutcome, SYMMY_REST_PREFIX, SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { dispatchEffectBffRequest, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Cause, Effect, Layer, Logger, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  PriceGroupDefinitionRequestSchema,
  PriceGroupDefinitionResponseSchema,
} from '@app/price-group-catalog/api/client';
import { PriceGroupSourceAssociationsRequestSchema } from '@app/price-group-catalog/apis/price-group-source-associations';
import {
  SymmyRouteContextRequestSchema,
  SymmyRouteContextResponseSchema,
} from '@app/symmy-integration/api/symmy-route-context';
import { AdmitSymmyJobPayloadSchema } from '@app/symmy-integration/api/admit-symmy-job-action';
import { expect, it } from 'effect-rstest';

import { SymmyIngressDefectLive } from '../../api/index.ts';
import {
  SymmyFixtureJobIdSchema,
  symmyFixtureJobNotFoundProblem,
  symmyUnavailableProblem,
} from '../../shared/symmy/contract.ts';
import { forwardSymmyOwnerRelease, makeSymmyGovernedDispatch } from '../../api/symmy/governed-dispatch.ts';
import {
  SymmyHostMountLive,
  SymmyIngress,
  SymmyIngressHandlersLive,
  SymmyIngressTransportLive,
  SymmyIngressSchemaErrorLive,
} from '../../api/symmy/transport.ts';
import type { SymmyIngressAdmission, SymmyIngressRequest } from '../../api/symmy/transport.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import { encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import { SymmyInternalPriceListsProjectionSchema } from '../../shared/symmy/read-projection-contracts.ts';

const host = 'https://shell.example.test';
const shellPrefix = '/shell-super-app-api';
const fixtureId = 'internal-c14-fixture';
const groupCode = 'fixture-group';
const jobId = '10000000-0000-4000-8000-000000000001';
const idempotencyKey = 'fixture-job-attempt';
const validKey = 'fedcba9876543210fedcba9876543210';
const wrongKindKey = 'synthetic-other-kind-key';
const revision = 'fixture-approved-revision';
const apiBaseUrl = moduleReleaseApiBaseUrl('symmy-integration', 'fixture-build');
const releasePath = '/module-api/symmy-integration/fixture-build/symmy-integration-api';

const invalid = GatewayAuthenticationRequiredProblemSchema.make({
  detail: 'A valid API key is required.',
  status: 401,
  title: 'Gateway authentication required',
  type: 'https://ontos.dev/problems/gateway-authentication-required',
});
const forbidden = GatewayForbiddenProblemSchema.make({
  detail: 'The authenticated principal cannot use the requested gateway context.',
  status: 403,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});

const fixtureApi = HttpApi.make(ShellAuthenticationApi.identifier)
  .add(ShellAuthenticationApi.groups.symmy)
  .add(
    HttpApiGroup.make('normalShell').add(
      HttpApiEndpoint.post('auth', '/auth/api-key/gateway-context', {
        success: Schema.Struct({ ok: Schema.Literal(true) }),
      }),
    ),
  );

const start = ({
  acquireOwnerAssertion,
  acquireRouteAssertion,
  defect,
  dispatch,
  observe,
  ownerFetch = globalThis.fetch,
}: {
  readonly acquireOwnerAssertion?: NonNullable<SymmyIngressAdmission['acquireOwnerAssertion']>;
  readonly acquireRouteAssertion?: NonNullable<SymmyIngressAdmission['acquireRouteAssertion']>;
  readonly defect?: Cause.Cause<never>;
  readonly dispatch?: typeof SymmyIngress.Service.dispatch;
  readonly observe?: (request: SymmyIngressRequest) => void;
  readonly ownerFetch?: typeof fetch;
} = {}) => {
  const authAttempts: string[] = [];
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.layer([
    Logger.make((options) => {
      logs.push(Logger.formatStructured.log(options));
    }),
  ]);
  let shellCalls = 0;
  let assertions = 0;
  const observeFixture = <Result, Problem>(
    input: { readonly admission: SymmyIngressAdmission; readonly request: SymmyIngressRequest },
    result: Effect.Effect<Result, Problem> | undefined,
  ) =>
    Effect.gen(function* observeFixtureDispatch() {
      const { admission, request } = input;
      expect(admission.compositionRevision).toBe(revision);
      expect(Redacted.value(admission.assertion)).toBe(`synthetic-assertion-${assertions}`);
      expect(admission).not.toHaveProperty('rawKey');
      observe?.(request);
      if (defect !== undefined) {
        return yield* Effect.failCause(defect);
      }
      return yield* result ?? Effect.fail(symmyUnavailableProblem);
    });
  const ingress = Layer.succeed(SymmyIngress, {
    admit: (key) =>
      Effect.gen(function* authorizeFixture() {
        authAttempts.push(key);
        if (key === wrongKindKey) {
          return yield* Effect.fail(forbidden);
        }
        if (key !== validKey) {
          return yield* Effect.fail(invalid);
        }
        assertions += 1;
        const admission = {
          apiBaseUrl,
          assertion: Redacted.make(`synthetic-assertion-${assertions}`),
          compositionRevision: revision,
        };
        const withOwner = acquireOwnerAssertion === undefined ? admission : { ...admission, acquireOwnerAssertion };
        return acquireRouteAssertion === undefined ? withOwner : { ...withOwner, acquireRouteAssertion };
      }),
    dispatch: {
      apply: (input) => observeFixture(input, dispatch?.apply(input)),
      poll: (input) => observeFixture(input, dispatch?.poll(input)),
      read: (input) => observeFixture(input, dispatch?.read(input)),
      submit: (input) => observeFixture(input, dispatch?.submit(input)),
    },
  });
  const symmy = SymmyIngressHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        ingress,
        SymmyIngressSchemaErrorLive,
        SymmyIngressDefectLive,
        logger,
        Layer.succeed(FetchHttpClient.Fetch, ownerFetch),
      ),
    ),
  );
  const normalShell = HttpApiBuilder.group(fixtureApi, 'normalShell', (group) =>
    group.handle('auth', () =>
      Effect.sync(() => {
        shellCalls += 1;
        return { ok: true } as const;
      }),
    ),
  );
  const runtime = assembleEffectBffRuntime({
    api: fixtureApi,
    handlers: Layer.mergeAll(normalShell, symmy),
    transport: SymmyIngressTransportLive.pipe(Layer.provide(SymmyHostMountLive)),
  }).createHandler({
    dataPlatform: { batch: { enabled: false }, enabled: false },
    openapi: { path: '/openapi.json' },
  });
  return {
    assertions: () => assertions,
    authAttempts,
    dispose: runtime.dispose,
    logs,
    request: (path: string, init: RequestInit, prefix = SYMMY_REST_PREFIX) =>
      dispatchEffectBffRequest((request) => runtime.handler(request), new Request(host + path, init), { prefix }),
    shellCalls: () => shellCalls,
  };
};

const fixtureJson = { body: '{"fixtureId":"internal-c14-fixture"}', headers: { 'content-type': 'application/json' } };

const internalProductInput = {
  contractVersion: 'INTERNAL_C14',
  plan: {
    items: [
      {
        effects: [
          {
            effectKey: 'create-product',
            intent: { _tag: 'CatalogCreateProduct', payload: { name: 'Internal source product' } },
            operation: {
              entrypointKey: 'commerce.catalog.create-product',
              moduleId: 'commerce.catalog',
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'product-record',
        source: {
          entityKind: 'PRODUCT',
          issuerId: 'internal-issuer',
          sourceNamespace: 'internal-products',
          sourceRecordId: 'opaque-source-product',
        },
        sourceOccurrenceId: 'internal-product-occurrence',
      },
    ],
  },
} as const;

it.effect('accepts a versioned typed business input and preserves its source identity and owner intent', () =>
  Effect.gen(function* versionedBusinessRequest() {
    const forwarded: SymmyIngressRequest[] = [];
    const admittedJobId = yield* Schema.decodeUnknownEffect(SymmyFixtureJobIdSchema)(jobId);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.succeed(admittedJobId),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.productsBatch.path, {
        body: JSON.stringify(internalProductInput),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(202);
    expect(yield* Effect.promise(() => response.json())).toEqual({ jobId, status: 'admitted' });
    expect(forwarded).toEqual([{ ...internalProductInput, idempotencyKey, route: 'productsBatch' }]);
  }),
);

it.effect('rejects untyped owner intents, authority overrides and credentials nested in business values', () =>
  Effect.gen(function* versionedInputBoundaries() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start()),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const submit = (payload: Schema.Json) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.productsBatch.path, {
          body: JSON.stringify(payload),
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
          method: 'POST',
        }),
      );
    for (const unsupportedTag of ['TaxDefineRate', 'AssortmentImport']) {
      const [original] = internalProductInput.plan.items;
      const unsupported = {
        ...internalProductInput,
        plan: {
          items: [
            {
              ...original,
              effects: [
                {
                  ...original.effects[0],
                  intent: { _tag: unsupportedTag, payload: {} },
                },
              ],
            },
          ],
        },
      };
      expect((yield* submit(unsupported)).status).toBe(400);
    }
    expect((yield* submit({ ...internalProductInput, tenantId: '90000000-0000-4000-8000-000000000001' })).status).toBe(
      400,
    );
    const [original] = internalProductInput.plan.items;
    const reflected = {
      ...internalProductInput,
      plan: {
        items: [
          {
            ...original,
            effects: [
              {
                ...original.effects[0],
                intent: { _tag: 'CatalogCreateProduct', payload: { name: `Private ${validKey}` } },
              },
            ],
          },
        ],
      },
    };
    const response = yield* submit(reflected);
    expect(response.status).toBe(400);
    expect(yield* Effect.promise(() => response.text())).not.toContain(validKey);
    expect(server.authAttempts).toEqual([]);
  }),
);

it.effect('requires a replay key for versioned synchronous writes before any owner dispatch', () =>
  Effect.gen(function* synchronousReplayIdentity() {
    let calls = 0;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          observe: () => {
            calls += 1;
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.customerGroupsBatch.path, {
        body: JSON.stringify(internalProductInput),
        headers: { 'content-type': 'application/json', 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(428);
    expect(yield* Effect.promise(() => response.json())).not.toHaveProperty('jobId');
    expect(calls).toBe(0);
  }),
);

const internalRoute = {
  allowedOwnerOperations: [
    { entrypointKey: 'commerce.catalog.api.catalog-source-products', moduleId: 'commerce.catalog', schemaVersion: '1' },
  ],
  issuerId: 'internal-issuer',
  legalEntityId: '80000000-0000-4000-8000-000000000001',
  mappingVersion: 'internal-map-v1',
  routeId: '70000000-0000-4000-8000-000000000001',
  routeRevision: 'internal-route-v1',
  sourceEntityKind: 'PRODUCT',
  sourceMappingVersion: 'internal-map-v1',
  sourceNamespace: 'internal-products',
  sourceRouteId: '70000000-0000-4000-8000-000000000001',
  sourceRouteRevision: 'internal-route-v1',
  tenantId: '60000000-0000-4000-8000-000000000001',
};

const nativePriceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId: internalRoute.tenantId,
} as const;
const nativeGroupDefinition = (observedAt: string) => {
  const at = '1970-01-01T00:00:00.000Z';
  const period = { effectiveFrom: at, effectiveTo: null };
  const provenance = {
    actionInvocationId: '50000000-0000-4000-8000-000000000002',
    actorPrincipalId: '50000000-0000-4000-8000-000000000003',
    reason: 'Internal native owner fixture',
    trustedAt: at,
  };
  const definitionRevisionId = '50000000-0000-4000-8000-000000000004';
  const meaningFingerprint = 'b'.repeat(64);
  const result = Schema.decodeUnknownSync(PriceGroupDefinitionResponseSchema)({
    currentEvidence: {
      catalogRevision: 1,
      definitionEffectivePeriod: period,
      definitionRevisionId,
      definitionRevisionNumber: 1,
      meaningFingerprint,
      observedAt,
      priceGroupRef: nativePriceGroupRef,
    },
    definition: {
      acceptedCatalogRevision: 1,
      classificationPurpose: 'Explicit source group classification',
      compatibilityContracts: [{ contractId: 'symmy.internal.fixture', version: 1 }],
      created: provenance,
      definitionRevisionId,
      description: 'Native description',
      displayName: 'Native source group',
      effectivePeriod: period,
      meaningFingerprint,
      previousDefinitionRevisionId: null,
      priceGroupRef: nativePriceGroupRef,
      revisionNumber: 1,
      semanticContinuity: null,
    },
    identity: {
      businessCode: 'PG_INTERNAL',
      created: provenance,
      createdAtCatalogRevision: 1,
      lifecycle: { activeFrom: at, retiredAt: null, state: 'ACTIVE' },
      meaningFingerprint,
      priceGroupRef: nativePriceGroupRef,
    },
    observedAt,
    selection: 'CURRENT',
  });
  return Schema.encodeSync(PriceGroupDefinitionResponseSchema)(result);
};

it.effect('uses a privately acquired route assertion without falling back to human Legal Entity selection', () =>
  Effect.gen(function* sealedRouteIssuerCapability() {
    const rawCode = 'CZ wholesale';
    const source = {
      entityKind: 'PRICE_LIST',
      issuerId: internalRoute.issuerId,
      route: { integrationRouteId: internalRoute.sourceRouteId, tenantId: internalRoute.tenantId },
      sourceNamespace: 'source-price-group-namespace',
      sourceRecordId: rawCode,
    };
    const route = yield* Schema.decodeUnknownEffect(SymmyRouteContextResponseSchema)({
      ...internalRoute,
      resolvedCode: rawCode,
      selector: { kind: 'PRICE_GROUP', source, target: nativePriceGroupRef },
      sourceNamespace: 'distinct-price-row-namespace',
    });
    const code = encodeSymmySourceSelector(
      {
        issuerId: source.issuerId,
        routeId: source.route.integrationRouteId,
        selectorKind: 'PRICE_GROUP',
        sourceNamespace: source.sourceNamespace,
        tenantId: source.route.tenantId,
      },
      rawCode,
      nativePriceGroupRef.resourceId,
    );
    const scopes: Parameters<NonNullable<SymmyIngressAdmission['acquireRouteAssertion']>>[0][] = [];
    const nativeCalls: string[] = [];
    let genericSelections = 0;
    const ownerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      nativeCalls.push(new URL(request.url).pathname);
      expect(request.headers.get('authorization')).toBe('Bearer sealed-sle-assertion');
      expect(Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(await request.json()).code).toBe(rawCode);
      return Response.json({ jobId, phase: 'admitted' });
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: () => {
            genericSelections += 1;
            return Effect.fail(forbidden);
          },
          acquireRouteAssertion: (input) =>
            Effect.sync(() => {
              scopes.push(input);
              return {
                apiBaseUrl,
                assertion: Redacted.make('sealed-sle-assertion'),
                compositionRevision: revision,
                route,
              };
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('sealed-route-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.priceListPricesBatch.path.replace('{code}', code), {
        ...fixtureJson,
        headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(202);
    expect(scopes).toEqual([{ code, routeKey: 'priceListPricesBatch' }]);
    expect(genericSelections).toBe(0);
    expect(nativeCalls).toEqual([`${releasePath}/symmy-integration/actions/admit-symmy-job`]);
  }),
);

it.effect(
  'round-trips opaque GET Price List IDs through a distinct selected POST route without changing the native source key',
  () =>
    Effect.gen(function* actualSelectedCodeRoundTrip() {
      let sequence = 0;
      for (const sourceRecordId of [
        'CZ wholesale',
        'CZ/wholesale',
        'Žluťoučký / 価格',
        'x'.repeat(300),
        '界'.repeat(300),
      ]) {
        sequence += 1;
        const roundtripKey = `roundtrip-${sequence}`;
        const registeredCode = `operator-code-${sequence}`;
        const logicalRouteId = '71000000-0000-4000-8000-000000000001';
        const priceGroupNamespace = 'internal-price-groups';
        const listRoute = {
          ...internalRoute,
          allowedOwnerOperations: [
            {
              entrypointKey: 'pricing.price-group-catalog.api.price-group-source-associations',
              moduleId: 'pricing.price-group-catalog',
              schemaVersion: '1',
            },
            {
              entrypointKey: 'pricing.price-group-catalog.api.price-group-definition',
              moduleId: 'pricing.price-group-catalog',
              schemaVersion: '1',
            },
          ],
          sourceEntityKind: 'PRICE_LIST',
          sourceNamespace: priceGroupNamespace,
          sourceRouteId: logicalRouteId,
        };
        const priceRoute = {
          ...internalRoute,
          resolvedCode: registeredCode,
          routeId: '72000000-0000-4000-8000-000000000001',
          selector: {
            kind: 'PRICE_GROUP',
            source: {
              entityKind: 'PRICE_LIST',
              issuerId: internalRoute.issuerId,
              route: { integrationRouteId: logicalRouteId, tenantId: internalRoute.tenantId },
              sourceNamespace: priceGroupNamespace,
              sourceRecordId,
            },
            target: nativePriceGroupRef,
          },
          sourceNamespace: 'separate-price-row-namespace',
          sourceRouteId: logicalRouteId,
        };
        const admittedCodes: string[] = [];
        const ownerFetch: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path.endsWith('/reads/symmy-route-context')) {
            const payload = Schema.decodeUnknownSync(SymmyRouteContextRequestSchema)(await request.json());
            return Response.json(payload.routeKey === 'priceLists' ? listRoute : priceRoute);
          }
          if (path.endsWith('/reads/price-group-source-associations')) {
            const payload = Schema.decodeUnknownSync(PriceGroupSourceAssociationsRequestSchema)(await request.json());
            expect(payload.routeId).toBe(logicalRouteId);
            if (payload.recordKey !== undefined) {
              expect(payload.recordKey).toBe(sourceRecordId);
            }
            return Response.json({
              associations: [
                {
                  priceGroupRef: nativePriceGroupRef,
                  sourceCorrelation: {
                    issuer: internalRoute.issuerId,
                    mappingVersion: internalRoute.sourceMappingVersion,
                    namespace: priceGroupNamespace,
                    recordKey: sourceRecordId,
                    routeId: logicalRouteId,
                  },
                },
              ],
              count: 1,
              limit: 1,
              offset: 0,
            });
          }
          if (path.endsWith('/reads/price-group-definition')) {
            const payload = Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)(await request.json());
            return Response.json(nativeGroupDefinition(payload.trustedOperationAt));
          }
          const payload = Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(await request.json());
          admittedCodes.push(payload.code ?? '');
          return Response.json({ jobId, phase: 'admitted' });
        };
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            start({
              acquireOwnerAssertion: ({ audience }) =>
                Effect.succeed({
                  apiBaseUrl: moduleReleaseApiBaseUrl(audience, 'fixture-build'),
                  assertion: Redacted.make('fresh-owned-route-assertion'),
                  compositionRevision: revision,
                }),
              dispatch: makeSymmyGovernedDispatch(Effect.succeed('roundtrip-correlation')),
              ownerFetch,
            }),
          ),
          (fixture) => Effect.promise(fixture.dispose),
        );
        const get = yield* Effect.promise(() =>
          server.request(`${SYMMY_ROUTES.priceLists.path}?contractVersion=INTERNAL_C14&limit=1`, {
            headers: { 'x-api-key': validKey },
            method: 'GET',
          }),
        );
        expect(get.status).toBe(200);
        const body = yield* Effect.promise(() => get.json());
        const projection = yield* Schema.decodeUnknownEffect(SymmyInternalPriceListsProjectionSchema)(body);
        const [item] = projection.price_lists;
        expect(item?.source_record_id).toBe(sourceRecordId);
        const filtered = yield* Effect.promise(() =>
          server.request(
            `${SYMMY_ROUTES.priceLists.path}?contractVersion=INTERNAL_C14&sourceRecordId=${encodeURIComponent(sourceRecordId)}&limit=1`,
            { headers: { 'x-api-key': validKey }, method: 'GET' },
          ),
        );
        expect(filtered.status).toBe(200);

        const code = yield* Effect.fromNullishOr(item?.id).pipe(Effect.orDie);
        const unsupportedAliasFilter = yield* Effect.promise(() =>
          server.request(`${SYMMY_ROUTES.priceLists.path}?contractVersion=INTERNAL_C14&code=${code}`, {
            headers: { 'x-api-key': validKey },
            method: 'GET',
          }),
        );
        expect(unsupportedAliasFilter.status).toBe(422);
        const conflictingFilters = yield* Effect.promise(() =>
          server.request(
            `${SYMMY_ROUTES.priceLists.path}?contractVersion=INTERNAL_C14&code=legacy&sourceRecordId=raw`,
            { headers: { 'x-api-key': validKey }, method: 'GET' },
          ),
        );
        expect(conflictingFilters.status).toBe(400);

        const post = yield* Effect.promise(() =>
          server.request(SYMMY_ROUTES.priceListPricesBatch.path.replace('{code}', code), {
            ...fixtureJson,
            headers: { ...fixtureJson.headers, 'idempotency-key': roundtripKey, 'x-api-key': validKey },
            method: 'POST',
          }),
        );
        expect(post.status).toBe(202);
        expect(admittedCodes).toEqual([registeredCode]);
      }
    }),
);

it.effect('rejects foreign qualified codes and forged target hints before admitting a selected owner effect', () =>
  Effect.gen(function* selectedAliasScopeBoundary() {
    const rawCode = 'CZ wholesale';
    const logicalRouteId = '71000000-0000-4000-8000-000000000001';
    const selectorScope = {
      issuerId: internalRoute.issuerId,
      routeId: logicalRouteId,
      selectorKind: 'PRICE_GROUP' as const,
      sourceNamespace: 'internal-price-groups',
      tenantId: internalRoute.tenantId,
    };
    let routeReads = 0;
    let writes = 0;
    const ownerFetch: typeof fetch = (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path.endsWith('/reads/symmy-route-context')) {
        routeReads += 1;
        return Promise.resolve(
          Response.json({
            ...internalRoute,
            resolvedCode: rawCode,
            selector: {
              kind: 'PRICE_GROUP',
              source: {
                entityKind: 'PRICE_LIST',
                issuerId: selectorScope.issuerId,
                route: { integrationRouteId: logicalRouteId, tenantId: internalRoute.tenantId },
                sourceNamespace: selectorScope.sourceNamespace,
                sourceRecordId: rawCode,
              },
              target: nativePriceGroupRef,
            },
          }),
        );
      }
      writes += 1;
      return Promise.resolve(Response.json({ jobId, phase: 'admitted' }));
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: () =>
            Effect.succeed({
              apiBaseUrl,
              assertion: Redacted.make('fresh-selector-assertion'),
              compositionRevision: revision,
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('selected-scope-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const submit = (code: string) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.priceListPricesBatch.path.replace('{code}', code), {
          ...fixtureJson,
          headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
          method: 'POST',
        }),
      );
    const foreign = encodeSymmySourceSelector(
      { ...selectorScope, issuerId: 'another-issuer' },
      rawCode,
      nativePriceGroupRef.resourceId,
    );
    expect((yield* submit(foreign)).status).toBe(403);
    const wrongKind = encodeSymmySourceSelector(
      { ...selectorScope, selectorKind: 'CUSTOMER_GROUP' },
      rawCode,
      nativePriceGroupRef.resourceId,
    );
    expect((yield* submit(wrongKind)).status).toBe(403);
    expect(routeReads).toBe(2);
    expect(writes).toBe(0);
    const before = server.authAttempts.length;
    expect(
      (yield* submit(encodeSymmySourceSelector(selectorScope, validKey, nativePriceGroupRef.resourceId))).status,
    ).toBe(403);
    expect(server.authAttempts).toHaveLength(before + 1);
    expect(
      (yield* submit(encodeSymmySourceSelector(selectorScope, rawCode, '30000000-0000-4000-8000-00000000000b'))).status,
    ).toBe(403);
    expect(routeReads).toBe(4);
    expect(writes).toBe(0);
  }),
);

it.effect('derives async scope from the governed route and obtains a fresh scoped admission assertion', () =>
  Effect.gen(function* governedBusinessAdmission() {
    const scopes: { readonly audience: string; readonly legalEntityId?: string }[] = [];
    const paths: string[] = [];
    const tokens: string[] = [];
    const bodies: Schema.Json[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      tokens.push(request.headers.get('authorization') ?? '');
      bodies.push(Schema.decodeUnknownSync(Schema.Json)(await request.json()));
      return Response.json(
        path.endsWith('/reads/symmy-route-context')
          ? { ...internalRoute, allowedOwnerOperations: [internalProductInput.plan.items[0].effects[0].operation] }
          : { jobId, phase: 'admitted' },
      );
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: (scope) =>
            Effect.sync(() => {
              scopes.push(scope);
              return {
                apiBaseUrl,
                assertion: Redacted.make('fresh-scoped-job-assertion'),
                compositionRevision: revision,
              };
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('internal-request-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.productsBatch.path, {
        body: JSON.stringify(internalProductInput),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(202);
    expect(scopes).toEqual([{ audience: 'symmy-integration', legalEntityId: internalRoute.legalEntityId }]);
    expect(paths).toEqual([
      `${releasePath}/reads/symmy-route-context`,
      `${releasePath}/symmy-integration/actions/admit-symmy-job`,
    ]);
    expect(tokens).toEqual(['Bearer synthetic-assertion-1', 'Bearer fresh-scoped-job-assertion']);
    expect(bodies).toEqual([
      { routeKey: 'productsBatch' },
      { ...internalProductInput, idempotencyKey, routeKey: 'productsBatch' },
    ]);
  }),
);

it.effect('runs the synchronous generated owner operation and returns results without a job response', () =>
  Effect.gen(function* governedSynchronousItems() {
    const item = yield* decodeSymmyItemOutcome({
      effects: [
        {
          effectId: '20000000-0000-4000-8000-000000000001',
          owner: 'commerce.customer-context',
          status: 'accepted_change',
        },
      ],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const paths: string[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      return Response.json(
        path.endsWith('/reads/symmy-route-context')
          ? {
              ...internalRoute,
              allowedOwnerOperations: [
                {
                  entrypointKey: 'commerce.customer-context.create-customer-group',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
              ],
              sourceEntityKind: 'CUSTOMER_GROUP',
              sourceNamespace: 'internal-groups',
            }
          : { items: [item] },
      );
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: () =>
            Effect.succeed({
              apiBaseUrl,
              assertion: Redacted.make('fresh-sync-assertion'),
              compositionRevision: revision,
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('internal-sync-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const groupInput = {
      contractVersion: 'INTERNAL_C14',
      plan: {
        items: [
          {
            effects: [
              {
                effectKey: 'group-create',
                intent: {
                  _tag: 'CustomerGroupCreate',
                  payload: {
                    businessCode: 'INTERNAL_GROUP',
                    description: 'Internal source grouping',
                    initialState: 'ACTIVE',
                    meaningKey: 'source-buyer-classification',
                    membershipCriteria: 'Explicit source group membership',
                    name: 'Internal buyers',
                    purpose: 'Buyer classification',
                    reason: 'Internal conformance fixture',
                  },
                },
                operation: {
                  entrypointKey: 'commerce.customer-context.create-customer-group',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
              },
            ],
            itemKey: 'group-record',
            source: {
              entityKind: 'CUSTOMER_GROUP',
              issuerId: 'internal-issuer',
              sourceNamespace: 'internal-groups',
              sourceRecordId: 'opaque-source-group',
            },
            sourceOccurrenceId: 'internal-group-occurrence',
          },
        ],
      },
    };
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.customerGroupsBatch.path, {
        body: JSON.stringify(groupInput),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ items: [{ ...item, outcome: 'accepted' }] });
    expect(paths).toEqual([
      `${releasePath}/reads/symmy-route-context`,
      `${releasePath}/symmy-integration/actions/admit-symmy-sync`,
    ]);
    expect(paths.some((path) => path.includes('admit-symmy-job'))).toBe(false);
  }),
);

it.effect('uses the authorized source Product read through the normal owner release with tenant-only scope', () =>
  Effect.gen(function* governedSourceProductRead() {
    const scopes: { readonly audience: string; readonly legalEntityId?: string }[] = [];
    const paths: string[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      paths.push(path);
      return Response.json(
        path.endsWith('/reads/symmy-route-context') ? internalRoute : { items: [], outcome: 'NOT_FOUND' },
      );
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: (scope) =>
            Effect.sync(() => {
              scopes.push(scope);
              return {
                apiBaseUrl: moduleReleaseApiBaseUrl('catalog', 'fixture-build'),
                assertion: Redacted.make('fresh-catalog-read-assertion'),
                compositionRevision: revision,
              };
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('internal-read-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(
        `${SYMMY_ROUTES.adminProducts.path}?contractVersion=INTERNAL_C14&code=opaque-source-product&limit=2`,
        { headers: { 'x-api-key': validKey }, method: 'GET' },
      ),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      contractVersion: 'INTERNAL_C14',
      limit: 2,
      products: [],
      projection: 'products',
    });
    expect(scopes).toEqual([{ audience: 'catalog' }]);
    expect(paths).toEqual([
      `${releasePath}/reads/symmy-route-context`,
      '/module-api/catalog/fixture-build/catalog-api/reads/catalog-source-products',
    ]);
  }),
);

it.effect('uses each approved route’s declared success status for internal fixtures', () =>
  Effect.gen(function* routesAllApprovedPaths() {
    const forwarded: SymmyIngressRequest[] = [];
    const admittedJobId = Schema.decodeUnknownSync(SymmyFixtureJobIdSchema)(jobId);
    const accepted = {
      effectId: '20000000-0000-4000-8000-000000000001',
      owner: 'test.catalog',
      status: 'accepted_change',
    };
    const notActivated = { owner: 'test.tax', reason: 'owner_not_activated', status: 'unsupported' };
    const indeterminate = {
      effectId: '20000000-0000-4000-8000-000000000002',
      owner: 'test.pricing',
      status: 'indeterminate',
    };
    const mixed = yield* decodeSymmyItemOutcome({
      effects: [accepted, notActivated, indeterminate],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const unavailable = yield* decodeSymmyItemOutcome({
      effects: [{ owner: 'test.inventory', status: 'unavailable' }],
      itemId: '30000000-0000-4000-8000-000000000002',
    });
    const items = [
      {
        ...mixed,
        effects: [{ ...mixed.effects[0], ownerPrivateDetail: 'private fixture data' }, ...mixed.effects.slice(1)],
        ownerPrivateDetail: 'private fixture data',
      },
      unavailable,
    ] as const;
    const expectedItems = [
      { ...mixed, outcome: 'partial' },
      { ...unavailable, outcome: 'not_accepted' },
    ];
    const references = ['40000000-0000-4000-8000-000000000001'];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.succeed(items),
            poll: ({ request }) =>
              request.id === admittedJobId
                ? Effect.succeed({ items, phase: 'completed' })
                : Effect.fail(symmyFixtureJobNotFoundProblem),
            read: ({ request }) => Effect.succeed(request.route === 'adminRegions' ? [] : references),
            submit: () => Effect.succeed(admittedJobId),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    for (const definition of Object.values(SYMMY_ROUTES)) {
      const path = definition.path.replace('{code}', groupCode).replace('{id}', jobId);
      const init =
        definition.method === 'POST'
          ? {
              ...fixtureJson,
              headers:
                definition.mode === 'durable_job'
                  ? { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey }
                  : { ...fixtureJson.headers, 'x-api-key': validKey },
              method: definition.method,
            }
          : { headers: { 'x-api-key': validKey }, method: definition.method };
      const response = yield* Effect.promise(() => server.request(path, init));
      expect(response.status).toBe(definition.successStatus);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = yield* Effect.promise(() => response.json());
      const expectedBodies = {
        business_read: { references: path === SYMMY_ROUTES.adminRegions.path ? [] : references },
        durable_job: { jobId, status: 'admitted' },
        item_results: { items: expectedItems },
        job_read: { items: expectedItems, jobId, status: 'indeterminate' },
      };
      expect(body).toEqual(expectedBodies[definition.mode]);
    }
    expect(server.authAttempts).toHaveLength(12);
    expect(server.assertions()).toBe(12);
    expect(forwarded).toEqual([
      { query: {}, route: 'adminCustomers' },
      { query: {}, route: 'adminProducts' },
      { query: {}, route: 'adminRegions' },
      { code: groupCode, fixtureId, idempotencyKey, route: 'customerGroupCustomersBatch' },
      { fixtureId, route: 'customerGroupsBatch' },
      { fixtureId, idempotencyKey, route: 'customersBatch' },
      { fixtureId, route: 'inventoryStockBatch' },
      { id: jobId, route: 'job' },
      { code: groupCode, fixtureId, idempotencyKey, route: 'priceListPricesBatch' },
      { query: {}, route: 'priceLists' },
      { fixtureId, idempotencyKey, route: 'priceListsBatchUpsert' },
      { fixtureId, idempotencyKey, route: 'productsBatch' },
    ]);
  }),
);

it.effect('rejects missing, invalid and wrong-kind API keys before dispatch', () =>
  Effect.gen(function* rejectsInvalidCredentials() {
    const forwarded: SymmyIngressRequest[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const get = (key?: string) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.adminProducts.path, {
          headers: key === undefined ? {} : { 'x-api-key': key },
          method: 'GET',
        }),
      );
    const missing = yield* get();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('ApiKey');
    expect((yield* get('wrong-key')).status).toBe(401);
    expect((yield* get(wrongKindKey)).status).toBe(403);
    expect(server.authAttempts).toEqual(['wrong-key', wrongKindKey]);
    expect(forwarded).toEqual([]);
  }),
);

it.effect('keeps job progress separate from whether completed items succeeded', () =>
  Effect.gen(function* distinguishesFixtureJobProgress() {
    const accepted = yield* decodeSymmyItemOutcome({
      effects: [
        {
          effectId: '20000000-0000-4000-8000-000000000001',
          originalStatus: 'accepted_no_change',
          owner: 'test.catalog',
          status: 'duplicate',
        },
      ],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const denied = yield* decodeSymmyItemOutcome({
      effects: [{ owner: 'test.catalog', status: 'denied' }],
      itemId: '30000000-0000-4000-8000-000000000002',
    });
    const cases = [
      { body: { status: 'admitted' }, id: jobId, state: { phase: 'admitted' } },
      {
        body: { status: 'running' },
        id: '10000000-0000-4000-8000-000000000002',
        state: { phase: 'running' },
      },
      {
        body: { items: [{ ...accepted, outcome: 'accepted' }], status: 'completed_all' },
        id: '10000000-0000-4000-8000-000000000003',
        state: { items: [accepted], phase: 'completed' },
      },
      {
        body: { items: [{ ...denied, outcome: 'not_accepted' }], status: 'completed_none' },
        id: '10000000-0000-4000-8000-000000000004',
        state: { items: [denied], phase: 'completed' },
      },
    ] as const;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: ({ request }) => {
              const job = cases.find(({ id }) => request.id === id);
              return job === undefined ? Effect.fail(symmyFixtureJobNotFoundProblem) : Effect.succeed(job.state);
            },
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    for (const { body, id } of cases) {
      const response = yield* Effect.promise(() =>
        server.request(SYMMY_ROUTES.job.path.replace('{id}', id), {
          headers: { 'x-api-key': validKey },
          method: 'GET',
        }),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ ...body, jobId: id });
    }
    const missingJobId = '10000000-0000-4000-8000-000000000005';
    const missing = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.job.path.replace('{id}', missingJobId), {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    const missingBody = yield* Effect.promise(() => missing.text());
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
    expect(missingBody).toContain('SymmyFixtureJobNotFoundProblem');
    expect(missingBody).not.toContain(missingJobId);
  }),
);

it.effect('does not dispatch wrong methods, unrecognized paths or cross-mounted endpoints', () =>
  Effect.gen(function* isolatesNativeMounts() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start()),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const wrongMethod = yield* Effect.promise(() => server.request(SYMMY_ROUTES.productsBatch.path, { method: 'GET' }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
    const extension = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.adminProducts.path, { method: 'PROPFIND' }),
    );
    expect(extension.status).toBe(405);
    expect(extension.headers.get('allow')).toBe('GET');
    const head = yield* Effect.promise(() => server.request(SYMMY_ROUTES.adminProducts.path, { method: 'HEAD' }));
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toBe('GET');
    const unknown = yield* Effect.promise(() =>
      server.request(`${SYMMY_REST_PREFIX}/admin/users/me`, { method: 'GET' }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/problem+json');
    const malformedPath = yield* Effect.promise(() =>
      server.request(`${SYMMY_REST_PREFIX}/admin//products`, { method: 'GET' }),
    );
    expect(malformedPath.status).toBe(404);
    const wrongMount = yield* Effect.promise(() =>
      server.request(`${shellPrefix}${SYMMY_ROUTES.adminProducts.path}`, { method: 'GET' }, shellPrefix),
    );
    expect(wrongMount.status).toBe(404);
    const encodedWrongMount = yield* Effect.promise(() =>
      server.request(`${shellPrefix}/%61pi/symmy/v1/admin/products`, { method: 'GET' }, shellPrefix),
    );
    expect(encodedWrongMount.status).toBe(404);
    const shellAlias = yield* Effect.promise(() =>
      server.request(`${SYMMY_REST_PREFIX}/auth/api-key/gateway-context`, { method: 'POST' }),
    );
    expect(shellAlias.status).toBe(404);
    expect(server.shellCalls()).toBe(0);
    const normalShell = yield* Effect.promise(() =>
      server.request(`${shellPrefix}/auth/api-key/gateway-context`, { method: 'POST' }, shellPrefix),
    );
    expect(normalShell.status).toBe(200);
    expect(server.shellCalls()).toBe(1);
    const aliasOpenApi = yield* Effect.promise(() =>
      server.request(`${SYMMY_REST_PREFIX}/openapi.json`, { method: 'GET' }),
    );
    expect(aliasOpenApi.status).toBe(404);
    const normalOpenApi = yield* Effect.promise(() =>
      server.request(`${shellPrefix}/openapi.json`, { method: 'GET' }, shellPrefix),
    );
    expect(normalOpenApi.status).toBe(200);
    const normalOpenApiDocument = yield* Effect.promise(() => normalOpenApi.text());
    expect(normalOpenApiDocument).toContain('/auth/api-key/gateway-context');
    expect(normalOpenApiDocument).not.toContain(SYMMY_REST_PREFIX);
    expect(server.authAttempts).toEqual([]);
  }),
);

it.effect('fails closed by default and rejects caller-provided authority in fixture inputs', () =>
  Effect.gen(function* rejectsUnconfiguredAndUnverifiedInputs() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start()),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.adminRegions.path, { headers: { 'x-api-key': validKey }, method: 'GET' }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const noReceipt = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.productsBatch.path, {
        ...fixtureJson,
        headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(noReceipt.status).toBe(503);
    expect(yield* Effect.promise(() => noReceipt.json())).not.toHaveProperty('jobId');
    const noJobStatus = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.job.path.replace('{id}', jobId), {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    expect(noJobStatus.status).toBe(503);
    expect(yield* Effect.promise(() => noJobStatus.text())).toContain('SymmyUnavailableProblem');
    const invalidBody = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.productsBatch.path, {
        body: '{"fixtureId":"internal-c14-fixture","audience":"outside-module"}',
        headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(invalidBody.status).toBe(400);
    const invalidQuery = yield* Effect.promise(() =>
      server.request(`${SYMMY_ROUTES.adminProducts.path}?audience=outside-module`, {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    expect(invalidQuery.status).toBe(400);
    expect(server.authAttempts).toEqual([validKey, validKey, validKey]);
  }),
);

it.effect('requires an exact idempotency key and rejects reflected credentials before dispatch', () =>
  Effect.gen(function* rejectsInvalidDurableIdentity() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start()),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const submit = (headers: HeadersInit, body = fixtureJson.body) =>
      Effect.promise(() => server.request(SYMMY_ROUTES.productsBatch.path, { body, headers, method: 'POST' }));
    const common = { ...fixtureJson.headers, 'x-api-key': validKey };
    expect((yield* submit(common)).status).toBe(400);
    expect((yield* submit({ ...common, 'idempotency-key': 'first, second' })).status).toBe(400);
    expect((yield* submit({ ...common, 'idempotency-key': `job-${validKey}` })).status).toBe(400);
    const reflected = yield* submit(
      { ...common, 'idempotency-key': idempotencyKey },
      JSON.stringify({ fixtureId: validKey }),
    );
    expect(reflected.status).toBe(400);
    expect(yield* Effect.promise(() => reflected.text())).not.toContain(validKey);
    expect(server.authAttempts).toEqual([]);
  }),
);

it.effect('uses the generated owner Action and Read with distinct fresh assertions and transport keys', () =>
  Effect.gen(function* usesExactGeneratedOperations() {
    const calls: { readonly headers: Record<string, string>; readonly path: string; readonly payload: Schema.Json }[] =
      [];
    const fetchOwner: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const payload = Schema.decodeUnknownSync(Schema.Json)(await request.json());
      calls.push({ headers: Object.fromEntries(request.headers), path: new URL(request.url).pathname, payload });
      return Response.json({ jobId, phase: 'admitted' });
    };
    let identifier = 0;
    const dispatch = makeSymmyGovernedDispatch(
      Effect.sync(() => {
        identifier += 1;
        return `fixture-identifier-${identifier}`;
      }),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start({ dispatch, ownerFetch: fetchOwner })),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const submit = () =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.customerGroupCustomersBatch.path.replace('{code}', groupCode), {
          ...fixtureJson,
          headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
          method: 'POST',
        }),
      );
    const poll = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.job.path.replace('{id}', jobId), {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    const first = yield* submit();
    const retry = yield* submit();
    expect([poll.status, first.status, retry.status]).toEqual([200, 202, 202]);
    expect(yield* Effect.promise(() => poll.json())).toEqual({ jobId, status: 'admitted' });
    expect(yield* Effect.promise(() => first.json())).toEqual({ jobId, status: 'admitted' });
    expect(yield* Effect.promise(() => retry.json())).toEqual({ jobId, status: 'admitted' });
    expect(calls.map(({ path }) => path)).toEqual([
      `${releasePath}/reads/symmy-job-status`,
      `${releasePath}/symmy-integration/actions/admit-symmy-job`,
      `${releasePath}/symmy-integration/actions/admit-symmy-job`,
    ]);
    const intent = { code: groupCode, fixtureId, idempotencyKey, routeKey: 'customerGroupCustomersBatch' };
    expect(calls.map(({ payload }) => payload)).toEqual([{ jobId }, intent, intent]);
    expect(calls.map(({ headers }) => headers['idempotency-key'])).toEqual([
      undefined,
      'fixture-identifier-3',
      'fixture-identifier-5',
    ]);
    expect(calls.map(({ headers }) => headers['authorization'])).toEqual([
      'Bearer synthetic-assertion-1',
      'Bearer synthetic-assertion-2',
      'Bearer synthetic-assertion-3',
    ]);
    expect(calls.map(({ headers }) => headers['x-correlation-id'])).toEqual([
      'fixture-identifier-1',
      'fixture-identifier-2',
      'fixture-identifier-4',
    ]);
    expect(calls.every(({ headers }) => headers['x-ontos-composition-revision'] === revision)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(validKey);
  }),
);

it.effect('preserves governed execution outcomes and pending recovery without owner details', () =>
  Effect.gen(function* projectsGovernedExecution() {
    const accepted = yield* decodeSymmyItemOutcome({
      effects: [
        {
          effectId: '20000000-0000-4000-8000-000000000001',
          owner: 'test.catalog',
          status: 'accepted_change',
        },
      ],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const denied = yield* decodeSymmyItemOutcome({
      effects: [{ owner: 'test.pricing', status: 'denied' }],
      itemId: '30000000-0000-4000-8000-000000000002',
    });
    const uncertain = yield* decodeSymmyItemOutcome({
      effects: [
        {
          effectId: '20000000-0000-4000-8000-000000000003',
          owner: 'test.inventory',
          status: 'indeterminate',
        },
      ],
      itemId: '30000000-0000-4000-8000-000000000003',
    });
    const acceptedResult = { ...accepted, outcome: 'accepted' };
    const deniedResult = { ...denied, outcome: 'not_accepted' };
    const uncertainResult = { ...uncertain, outcome: 'not_accepted' };
    const cases = [
      { expected: { items: [], status: 'admitted' }, items: [], phase: 'admitted' },
      { expected: { items: [acceptedResult], status: 'running' }, items: [accepted], phase: 'running' },
      {
        expected: { items: [acceptedResult, deniedResult], status: 'blocked' },
        items: [accepted, denied],
        phase: 'blocked',
      },
      {
        expected: { items: [acceptedResult, deniedResult], status: 'completed_partial' },
        items: [accepted, denied],
        phase: 'completed_all',
      },
      {
        expected: { items: [acceptedResult, uncertainResult], status: 'indeterminate' },
        items: [accepted, uncertain],
        phase: 'indeterminate',
      },
      { items: [], phase: 'completed_none' },
    ] as const;
    let ownerCase: (typeof cases)[number] = cases[0];
    const privateDetail = 'fixture-private-source-record';
    const fetchOwner: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          items: ownerCase.items.map((item) => ({
            ...item,
            effects: item.effects.map((effect) => ({ ...effect, originalTarget: privateDetail })),
            sourceRecord: privateDetail,
          })),
          jobId,
          phase: ownerCase.phase,
          routeRevision: privateDetail,
        }),
      );
    const dispatch = makeSymmyGovernedDispatch(Effect.succeed('fresh-poll-key'));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start({ dispatch, ownerFetch: fetchOwner })),
      (fixture) => Effect.promise(fixture.dispose),
    );
    for (const entry of cases) {
      ownerCase = entry;
      const response = yield* Effect.promise(() =>
        server.request(SYMMY_ROUTES.job.path.replace('{id}', jobId), {
          headers: { 'x-api-key': validKey },
          method: 'GET',
        }),
      );
      expect(response.status).toBe('expected' in entry ? 200 : 503);
      const body = yield* Effect.promise(() => response.json());
      if ('expected' in entry) {
        expect(body).toEqual({ ...entry.expected, jobId });
      }
      expect(JSON.stringify(body)).not.toContain(privateDetail);
    }
  }),
);

it.effect('refuses unlisted owner targets before consulting release authority', () =>
  Effect.gen(function* refusesUnlistedReleaseTargets() {
    let lookups = 0;
    const authority = Layer.succeed(ActiveApplicationCompositionService, {
      load: Effect.sync(() => {
        lookups += 1;
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new ActiveApplicationCompositionUnavailableError({
              reason: 'Fixture has no configured Symmy executable',
            }),
          ),
        ),
      ),
    });
    const relayOrigin = 'https://symmy-owner-relay.invalid';
    const denied = [
      `https://foreign.example.test${releasePath}/symmy-integration/actions/admit-symmy-job`,
      `${relayOrigin}${releasePath}/actions/unlisted-action`,
      `${relayOrigin}${releasePath}/reads/symmy-job-status?extra=true`,
      `${relayOrigin}${apiBaseUrl}/reads/symmy-job-status`,
      `${relayOrigin}/module-api/another-owner/fixture-build/another-owner-api/actions/admit-symmy-job`,
    ];
    for (const url of denied) {
      expect(
        yield* Effect.flip(forwardSymmyOwnerRelease(url, { method: 'POST' }).pipe(Effect.provide(authority))),
      ).toEqual(symmyUnavailableProblem);
    }
    expect(lookups).toBe(0);
    const configuredPath = yield* Effect.flip(
      forwardSymmyOwnerRelease(`${relayOrigin}${releasePath}/reads/symmy-job-status`, { method: 'POST' }).pipe(
        Effect.provide(authority),
      ),
    );
    expect(configuredPath).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(lookups).toBe(1);
  }),
);

it.effect('projects owner admission and polling failures without owner details', () =>
  Effect.gen(function* projectsGovernedFailures() {
    const cases = [
      { expected: 401, ownerStatus: 401, tag: 'AdmitSymmyJobActionAuthenticationProblem' },
      { code: 'action_permission_denied', expected: 403, ownerStatus: 403, tag: 'AdmitSymmyJobActionForbiddenProblem' },
      { code: 'symmy_job_route_denied', expected: 403, ownerStatus: 403, tag: 'AdmitSymmyJobRouteDeniedProblem' },
      {
        code: 'symmy_job_intent_conflict',
        expected: 409,
        ownerStatus: 409,
        tag: 'AdmitSymmyJobIntentConflictProblem',
      },
      { expected: 503, ownerStatus: 502, tag: 'UnknownUpstreamFailure' },
      { expected: 404, ownerStatus: 404, poll: true, tag: 'SymmyJobStatusNotFoundProblem' },
      { expected: 403, ownerStatus: 403, poll: true, tag: 'SymmyJobStatusForbiddenProblem' },
      { expected: 503, ownerStatus: 503, poll: true, tag: 'SymmyJobStatusUnavailableProblem' },
    ] as const;
    const privateDetail = 'owner-only diagnostic';
    let ownerCase: (typeof cases)[number] = cases[0];
    const fetchOwner: typeof fetch = () =>
      Promise.resolve(
        Response.json(
          {
            _tag: ownerCase.tag,
            code: 'code' in ownerCase ? ownerCase.code : undefined,
            detail: privateDetail,
            retryable: ownerCase.ownerStatus === 503 ? true : undefined,
            status: ownerCase.ownerStatus,
            title: 'Private owner operation',
            type: 'https://ontos.dev/problems/test-owner-operation',
          },
          { headers: { 'content-type': 'application/problem+json' }, status: ownerCase.ownerStatus },
        ),
      );
    const dispatch = makeSymmyGovernedDispatch(Effect.succeed('fresh-action-key'));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start({ dispatch, ownerFetch: fetchOwner })),
      (fixture) => Effect.promise(fixture.dispose),
    );
    for (const entry of cases) {
      ownerCase = entry;
      const response = yield* Effect.promise(() =>
        'poll' in entry
          ? server.request(SYMMY_ROUTES.job.path.replace('{id}', jobId), {
              headers: { 'x-api-key': validKey },
              method: 'GET',
            })
          : server.request(SYMMY_ROUTES.productsBatch.path, {
              ...fixtureJson,
              headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
              method: 'POST',
            }),
      );
      expect(response.status).toBe(entry.expected);
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain(privateDetail);
      expect(body).not.toContain(jobId);
      expect(body).not.toContain(idempotencyKey);
      if (entry.expected === 401) {
        expect(response.headers.get('www-authenticate')).toContain('ApiKey');
      }
    }
  }),
);

it.effect('logs a correlated defect classification and sanitizes the gateway problem', () =>
  Effect.gen(function* sanitizesDefect() {
    const requestId = 'fixture-c14-request-id';
    const traceId = '0123456789abcdef0123456789abcdef';
    const defect = Cause.combine(Cause.die({ apiKey: validKey }), Cause.die('sensitive-dispatch-details'));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start({ defect })),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const get = (correlationId: string, requestTraceId = traceId) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.adminProducts.path, {
          headers: {
            traceparent: `00-${requestTraceId}-0123456789abcdef-01`,
            'x-api-key': validKey,
            'x-correlation-id': correlationId,
          },
          method: 'GET',
        }),
      );
    const response = yield* get(requestId);
    const text = yield* Effect.promise(() => response.text());
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(text).toContain('GatewayInternalProblem');
    expect(text).not.toContain(validKey);
    expect((yield* get(`before-${validKey}-after`)).status).toBe(500);
    expect((yield* get(validKey, validKey)).status).toBe(500);
    const errorLogs = server.logs.filter((log) => log.level === 'ERROR');
    expect(errorLogs).toMatchObject(
      [requestId, traceId, 'missing'].map((correlationId) => ({
        annotations: { correlationId },
        message: ['Unexpected Symmy ingress defect', { reasons: ['Die', 'Die'] }],
      })),
    );
    expect(JSON.stringify(server.logs)).not.toContain(validKey);
    expect(JSON.stringify(server.logs)).not.toContain('sensitive-dispatch-details');
  }),
);

it.effect('rejects malformed fixture outputs without classifying them as caller errors', () =>
  Effect.gen(function* failsClosedOnInvalidOutput() {
    const privateReference = 'private fixture reference';
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.succeed([privateReference]),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.adminProducts.path, { headers: { 'x-api-key': validKey }, method: 'GET' }),
    );
    const body = yield* Effect.promise(() => response.text());
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(body).toContain('GatewayInternalProblem');
    expect(body).not.toContain(privateReference);
    expect(JSON.stringify(server.logs)).not.toContain(privateReference);
  }),
);
