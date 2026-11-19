// @rstest-environment happy-dom
import type { CoreSearchPresentationEntry } from '@app/core-runtime/search-contract';
import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { browserNetwork, networkIdle, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { isRedirect } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  LegalEntityIdSchema,
  ModuleIdSchema,
  ResourceRefSchema,
  ShellAuthenticationApi,
  ShellCapabilityUnavailableProblemSchema,
  ShellReloadRequiredProblemSchema,
  ShellResourceResponseSchema,
  ShellTargetForbiddenProblemSchema,
  ShellTargetNotFoundProblemSchema,
  shellAuthenticationApiContract,
} from '../../../../shared/browser-api.ts';
import { loader } from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/resource-page-model.ts';
import { resetSessionScope } from '../../../../src/routes/session-scope.ts';
import { adaSignedIn, makeShellBff, signedInShellReads } from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';

const evaId = 'ea2200ab-4308-491e-8e33-ca3871a8fa55';
const counterparty = { moduleId: 'party.registry', resourceId: evaId, resourceType: 'party.registry.counterparty' };
const company = authenticatedShellFixture().selectedLegalEntityId;
const otherCompany = '20000000-0000-4000-8000-000000000002';
const requestFor = (params: typeof counterparty, prefix = 'generic') =>
  new Request(
    `https://shell.example.test/${prefix}/resources/${params.moduleId}/${params.resourceType}/${encodeURIComponent(params.resourceId)}?resourceId=attacker&redirect=https://attacker.test`,
  );

const compositionRevision = authenticatedShellFixture().compositionRevision ?? 'a'.repeat(64);
const metadata = (key: string, order: number) => ({
  icon: 'icon-[mdi--file-outline]' as const,
  key,
  label: { cs: key, en: key },
  order,
});

interface RouteSpec {
  readonly idEncoding: 'native' | 'selected_company_dot_prefix';
  readonly idFormat: 'opaque' | 'uuid';
  readonly kind: 'path' | 'query';
  readonly ownerModuleId: string;
  readonly pageKey: string;
  readonly parameterName: string;
  readonly resourceType: string;
  readonly routePath: string;
}

const routeSpecs: readonly RouteSpec[] = [
  {
    idEncoding: 'native',
    idFormat: 'uuid',
    kind: 'path',
    ownerModuleId: 'party.registry',
    pageKey: 'customers',
    parameterName: 'id',
    resourceType: 'party.registry.counterparty',
    routePath: '/prodej/zakaznici/:id',
  },
  {
    idEncoding: 'selected_company_dot_prefix',
    idFormat: 'opaque',
    kind: 'path',
    ownerModuleId: 'demo.merchandise',
    pageKey: 'products',
    parameterName: 'id',
    resourceType: 'demo.merchandise.product',
    routePath: '/provoz/produkty/:id',
  },
  {
    idEncoding: 'selected_company_dot_prefix',
    idFormat: 'opaque',
    kind: 'query',
    ownerModuleId: 'demo.merchandise',
    pageKey: 'orders',
    parameterName: 'orderId',
    resourceType: 'demo.merchandise.order',
    routePath: '/prodej/objednavky',
  },
  {
    idEncoding: 'selected_company_dot_prefix',
    idFormat: 'opaque',
    kind: 'query',
    ownerModuleId: 'facility.operations',
    pageKey: 'assets',
    parameterName: 'asset',
    resourceType: 'facility.operations.asset',
    routePath: '/provoz/majetek',
  },
  {
    idEncoding: 'native',
    idFormat: 'opaque',
    kind: 'query',
    ownerModuleId: 'work.tasks',
    pageKey: 'tasks',
    parameterName: 'resourceId',
    resourceType: 'work.tasks.task',
    routePath: '/ukoly',
  },
];

/** The Host will attach one detail inventory; the browser reads it structurally and validates every binding. */
const detailPresentation = (ref: { readonly moduleId: string; readonly resourceType: string }) => {
  const spec = routeSpecs.find(
    (candidate) => candidate.ownerModuleId === ref.moduleId && candidate.resourceType === ref.resourceType,
  );
  if (spec === undefined) {
    return null;
  }
  const ownerModuleId = Schema.decodeUnknownSync(ModuleIdSchema)(spec.ownerModuleId);
  const entry: CoreSearchPresentationEntry = {
    ownerModuleId,
    presentation: {
      family: metadata('records', 10),
      group: metadata('record', 10),
      record: {
        pageKey: spec.pageKey,
        selector: {
          idEncoding: spec.idEncoding,
          idFormat: spec.idFormat,
          kind: spec.kind,
          parameterName: spec.parameterName,
        },
      },
      scope: 'company',
    },
    resourceType: spec.resourceType,
    searchKey: `${spec.ownerModuleId}.search`,
  };
  return {
    business: { compositionRevision, entries: [entry], schemaVersion: '1' as const },
    pages: [{ ownerModuleId, pageKey: spec.pageKey, routePath: spec.routePath }],
  };
};

const resourceAnswer: NonNullable<ShellBffScript['resourceDetail']> = (ref) => {
  const presentation = detailPresentation(ref);
  const response = { outcome: 'detail_not_supported' as const, ref };
  return Effect.succeed(presentation === null ? response : { ...response, presentation });
};

const freshSession = Layer.effectDiscard(
  resetSessionScope.pipe(Effect.andThen(pinDocumentCompositionRevision(compositionRevision))),
);
const resourceBff = (script: ShellBffScript = {}) => {
  const bff = makeShellBff({ ...signedInShellReads(adaSignedIn), resourceDetail: resourceAnswer, ...script });
  return { ...bff, browser: bff.browser.pipe(Layer.provide(freshSession)) };
};
const resourceRequests = (bff: Pick<ReturnType<typeof makeShellBff>, 'requests'>) =>
  bff.requests.filter(({ endpoint }) => endpoint === 'resourceDetail');
const sessionRequests = (bff: Pick<ReturnType<typeof makeShellBff>, 'requests'>) =>
  bff.requests.filter(({ endpoint }) => endpoint === 'currentSession');
const sessionInOtherCompany = {
  ...adaSignedIn,
  identity: { ...adaSignedIn.identity, legalEntityId: Schema.decodeUnknownSync(LegalEntityIdSchema)(otherCompany) },
};
const shellInOtherCompany = {
  ...authenticatedShellFixture(),
  gatewayAudiences: [],
  identity: sessionInOtherCompany.identity,
  legalEntities: { items: [], state: 'available', tenantContextAvailable: false },
  selectedLegalEntityId: sessionInOtherCompany.identity.legalEntityId,
};

const rejected = (params: typeof counterparty, prefix = 'generic') =>
  Effect.flip(
    Effect.tryPromise({ catch: (cause) => cause, try: () => loader({ params, request: requestFor(params, prefix) }) }),
  );

it.live.each([
  [counterparty, `/cs/prodej/zakaznici/${evaId}`],
  [
    { moduleId: 'demo.merchandise', resourceId: `${company}.${evaId}`, resourceType: 'demo.merchandise.product' },
    `/cs/provoz/produkty/${evaId}`,
  ],
  [
    { moduleId: 'demo.merchandise', resourceId: `${company}.OBJ-42`, resourceType: 'demo.merchandise.order' },
    '/cs/prodej/objednavky?orderId=OBJ-42',
  ],
  [
    { moduleId: 'facility.operations', resourceId: `${company}.TEC-001`, resourceType: 'facility.operations.asset' },
    '/cs/provoz/majetek?asset=TEC-001',
  ],
  [
    { moduleId: 'work.tasks', resourceId: 'task 42&other=1', resourceType: 'work.tasks.task' },
    '/cs/ukoly?resourceId=task+42%26other%3D1',
  ],
] as const)('legacy resources open the exact owner record without search-history state: %s', ([params, href]) => {
  const bff = resourceBff();
  return Effect.gen(function* reloadOpensExactOwnerRecord() {
    const result = yield* rejected(params);
    expect(isRedirect(result)).toBe(true);
    expect(result).toMatchObject({ options: { to: href } });
    yield* networkIdle;
    expect(resourceRequests(bff)).toHaveLength(1);
    expect(resourceRequests(bff)[0]?.body).toMatchObject({
      ...params,
      compositionRevision: authenticatedShellFixture().compositionRevision,
    });
  }).pipe(Effect.provide(bff.browser));
});

it.live('retains the language prefix and never trusts an unrelated legacy query', () =>
  Effect.gen(function* localizedOwnerRedirect() {
    const result = yield* rejected(counterparty, 'cs');
    expect(isRedirect(result)).toBe(true);
    expect(result).toMatchObject({ options: { to: `/cs/prodej/zakaznici/${evaId}` } });
  }).pipe(Effect.provide(resourceBff().browser)),
);

it.live('keeps an admitted English owner link in English', () =>
  Effect.gen(function* englishOwnerRedirect() {
    const result = yield* rejected(counterparty, 'en');
    expect(result).toMatchObject({ options: { to: `/en/prodej/zakaznici/${evaId}` } });
  }).pipe(Effect.provide(resourceBff().browser)),
);

it('the unsupported wire response carries no guessed name or private detail fields', () => {
  const response = { outcome: 'detail_not_supported', ref: counterparty };
  expect(Schema.decodeUnknownSync(ShellResourceResponseSchema)(response)).toEqual(response);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(ShellResourceResponseSchema, { onExcessProperty: 'error' })({
        ...response,
        detail: { fields: [{ label: 'E-mail', value: 'private@example.test' }], title: 'Eva Bílá' },
      }),
    ),
  ).toBe(true);
});

const problemFields = { detail: 'Read refused', title: 'Read refused', type: 'about:blank' };
const failures = {
  ShellCapabilityUnavailableProblem: Effect.fail(
    ShellCapabilityUnavailableProblemSchema.make({ ...problemFields, retryable: true, status: 503 }),
  ),
  ShellReloadRequiredProblem: Effect.fail(ShellReloadRequiredProblemSchema.make({ ...problemFields, status: 409 })),
  ShellTargetForbiddenProblem: Effect.fail(ShellTargetForbiddenProblemSchema.make({ ...problemFields, status: 403 })),
  ShellTargetNotFoundProblem: Effect.fail(ShellTargetNotFoundProblemSchema.make({ ...problemFields, status: 404 })),
};

// An untyped upstream outage must cross the HTTP transport, rather than impersonating a declared Problem.
const contract = ShellAuthenticationApi.groups;
const reads = signedInShellReads(adaSignedIn);
const ReadApi = HttpApi.make('resourceLoaderReads')
  .add(HttpApiGroup.make('authentication').add(contract.authentication.endpoints.currentSession))
  .add(HttpApiGroup.make('identity').add(contract.identity.endpoints.demoAccountCapability))
  .add(HttpApiGroup.make('composition').add(contract.composition.endpoints.shellComposition))
  .add(HttpApiGroup.make('legalEntities').add(contract.legalEntities.endpoints.availableLegalEntities))
  .add(HttpApiGroup.make('tenants').add(contract.tenants.endpoints.availableTenants))
  .prefix(shellAuthenticationApiContract.apiPrefix);
const readHandlers = Layer.mergeAll(
  HttpApiBuilder.group(ReadApi, 'authentication', (group) => group.handle('currentSession', reads.currentSession)),
  HttpApiBuilder.group(ReadApi, 'identity', (group) =>
    group.handle('demoAccountCapability', reads.demoAccountCapability),
  ),
  HttpApiBuilder.group(ReadApi, 'composition', (group) => group.handle('shellComposition', reads.shellComposition)),
  HttpApiBuilder.group(ReadApi, 'legalEntities', (group) =>
    group.handle('availableLegalEntities', reads.availableLegalEntities),
  ),
  HttpApiBuilder.group(ReadApi, 'tenants', (group) => group.handle('availableTenants', reads.availableTenants)),
);
const transportFailureNetwork = browserNetwork(
  serveApi(ReadApi, readHandlers),
  HttpRouter.add(
    'POST',
    `${shellAuthenticationApiContract.apiPrefix}/shell/resource`,
    Effect.succeed(HttpServerResponse.text('Upstream unavailable', { status: 502 })),
  ),
).pipe(Layer.provide(freshSession));

it.live.each([
  ['ShellTargetForbiddenProblem', 'forbidden'],
  ['ShellTargetNotFoundProblem', 'not_found'],
  ['ShellCapabilityUnavailableProblem', 'unavailable'],
  ['HttpClientError', 'unavailable'],
  ['ShellReloadRequiredProblem', 'reload_required'],
] as const)('never redirects a denied, deleted, unknown or unavailable record: %s', ([tag, state]) =>
  Effect.gen(function* noRedirectOnReadFailure() {
    expect(
      yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) })),
    ).toMatchObject({
      state,
    });
  }).pipe(
    Effect.provide(
      tag === 'HttpClientError'
        ? transportFailureNetwork
        : resourceBff({ resourceDetail: () => failures[tag] }).browser,
    ),
  ),
);

it.live.each([
  { ...counterparty, resourceType: 'party.registry.party' },
  { ...counterparty, moduleId: 'demo.crm' },
  { ...counterparty, resourceId: 'malformed' },
  { moduleId: 'future.owner', resourceId: evaId, resourceType: 'future.owner.record' },
  { moduleId: 'demo.merchandise', resourceId: `${otherCompany}.${evaId}`, resourceType: 'demo.merchandise.product' },
  { moduleId: 'demo.merchandise', resourceId: `${company}.`, resourceType: 'demo.merchandise.product' },
])('unsupported or mismatched identities do not become a different record: %s', (params) =>
  Effect.gen(function* noInventedOwnerRecord() {
    expect(yield* Effect.promise(() => loader({ params, request: requestFor(params) }))).toMatchObject({
      state: 'unavailable',
    });
  }).pipe(Effect.provide(resourceBff().browser)),
);

it.live('never redirects an unsupported response for a different record', () =>
  Effect.gen(function* validatesUnsupportedReference() {
    expect(
      yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) })),
    ).toMatchObject({ state: 'unavailable' });
  }).pipe(
    Effect.provide(
      resourceBff({
        resourceDetail: () =>
          Effect.succeed({
            outcome: 'detail_not_supported',
            ref: Schema.decodeUnknownSync(ResourceRefSchema)({
              ...counterparty,
              resourceId: '00000000-0000-4000-8000-000000000001',
            }),
          }),
      }).browser,
    ),
  ),
);

it.live('a new scope makes a fresh resource read and cannot reuse another company admission', () => {
  let session = adaSignedIn;
  const bff = resourceBff({ currentSession: () => Effect.succeed(session) });
  return Effect.gen(function* scopeChangesDoNotCacheAdmission() {
    const params = {
      moduleId: 'demo.merchandise',
      resourceId: `${company}.${evaId}`,
      resourceType: 'demo.merchandise.product',
    };
    expect(isRedirect(yield* rejected(params))).toBe(true);
    session = sessionInOtherCompany;
    yield* resetSessionScope;
    expect(yield* Effect.promise(() => loader({ params, request: requestFor(params) }))).toMatchObject({
      state: 'unavailable',
    });
    yield* networkIdle;
    expect(resourceRequests(bff)).toHaveLength(2);
    expect(sessionRequests(bff)).toHaveLength(2);
  }).pipe(Effect.provide(bff.browser));
});

it.live('does not read or redirect before composition admission', () => {
  const bff = resourceBff({ shellComposition: () => failures.ShellReloadRequiredProblem });
  return Effect.gen(function* admissionFirst() {
    expect(
      yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) })),
    ).toMatchObject({ state: 'reload_required' });
    yield* networkIdle;
    expect(resourceRequests(bff)).toHaveLength(0);
  }).pipe(Effect.provide(bff.browser));
});

it.live('does not carry private details from a successful read into a later denied scope', () => {
  let session = adaSignedIn;
  let answer: ReturnType<NonNullable<ShellBffScript['resourceDetail']>> = Effect.succeed({
    detail: { fields: [{ label: 'E-mail', value: 'private@example.test' }], title: 'Eva Bílá' },
    media: { enabled: false, reason: 'absent' },
    projectionLagging: false,
    ref: Schema.decodeUnknownSync(ResourceRefSchema)(counterparty),
    timeline: [],
  });
  const bff = resourceBff({
    currentSession: () => Effect.succeed(session),
    resourceDetail: () => answer,
  });
  return Effect.gen(function* privateDetailsStayInTheirRequest() {
    expect(
      yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) })),
    ).toMatchObject({ state: 'ready' });
    session = sessionInOtherCompany;
    yield* resetSessionScope;
    answer = failures.ShellTargetForbiddenProblem;
    const denied = yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) }));
    expect(denied).toEqual({ shell: shellInOtherCompany, state: 'forbidden' });
    expect(JSON.stringify(denied)).not.toContain('private@example.test');
    yield* networkIdle;
    expect(resourceRequests(bff)).toHaveLength(2);
  }).pipe(Effect.provide(bff.browser));
});
