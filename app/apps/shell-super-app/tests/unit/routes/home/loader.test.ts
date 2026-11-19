import { createRequire } from 'node:module';

import { getDocumentCompositionRevision, pinDocumentCompositionRevision } from '@app/shared-contracts';
import { ConfigProvider, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AuthenticationUnavailableProblemSchema,
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  CurrentSessionSchema,
  OntosIdentityForbiddenProblemSchema,
  ShellCompositionSchema,
  ShellCapabilityUnavailableProblemSchema,
  ShellDocumentContextSchema,
  ShellReloadRequiredProblemSchema,
  ShellTargetForbiddenProblemSchema,
  ShellTargetNotFoundProblemSchema,
  TenantAuthenticationRequiredProblemSchema,
  TenantCapabilityUnavailableProblemSchema,
  TenantInternalProblemSchema,
} from '../../../../shared/browser-api.ts';
import type { CurrentSession, ShellComposition } from '../../../../shared/browser-api.ts';
import { LegalEntityDetailResponseSchema } from '../../../../shared/core-reads/legal-entity-detail.ts';
import {
  loadHomePageModel,
  loadServerModuleDocument,
  primeBrowserReads,
  resetBrowserSessionCache,
} from '../../../../src/routes/[lang]/home-page-model.ts';
import type { HomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import { endBrowserSession } from '../../../../src/routes/session-scope.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffEndpoint, ShellBffScript } from '../../../support/shell-bff-double.ts';

const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherLegalEntityId = '20000000-0000-4000-8000-000000000002';
const tenantId = '30000000-0000-4000-8000-000000000001';
const otherTenantId = '30000000-0000-4000-8000-000000000002';
const identity = {
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  legalEntityId,
  legalName: 'Alpha company',
  principalId: 'principal-1',
  tenantId,
};
const { legalEntityId: _companyId, legalName: _companyName, ...tenantIdentity } = identity;
const compositionRevision = '1'.repeat(64);
const futureItem = {
  appId: 'future-generated',
  enabled: true,
  entrypointKey: 'future.generated.page.records',
  groupKey: 'shell.navigation.unlisted',
  href: '/modules/future.generated',
  icon: 'icon-[mdi--view-grid-outline]' as const,
  label: { cs: 'Budoucí modul', en: 'Future generated' },
  moduleId: 'future.generated',
  order: 10,
  state: 'active' as const,
  unavailable: false,
  writable: true,
};
const navigation = [futureItem];
const problem = { detail: 'redacted', title: 'redacted', type: 'about:blank' } as const;
const request = (url = 'https://shell.example.test/en') =>
  new Request(url, {
    headers: { cookie: 'session=test-session' },
  });

const session = Schema.decodeUnknownSync(CurrentSessionSchema);
const legalEntitiesResponse = Schema.decodeUnknownSync(AvailableLegalEntitiesResponseSchema);
const legalEntities = legalEntitiesResponse({
  legalEntities: [{ legalEntityId, legalName: 'Alpha company' }],
  selectedLegalEntityId: legalEntityId,
  state: 'authenticated',
  tenantContextAvailable: false,
});
const tenants = Schema.decodeUnknownSync(AvailableTenantsResponseSchema)({
  tenants: [
    { name: 'Alpha tenant', tenantId },
    { name: 'Zeta tenant', tenantId: otherTenantId },
  ],
});
const shellComposition = Schema.decodeUnknownSync(ShellCompositionSchema);
type AvailableCompositionFields = Partial<
  Extract<typeof ShellCompositionSchema.Encoded, { readonly state: 'available' }>
>;
const availableComposition = (overrides: AvailableCompositionFields = {}) =>
  shellComposition({
    compositionRevision,
    deniedAppIds: [],
    gatewayAudiences: [],
    homeComponents: [],
    navigation,
    state: 'available',
    unavailableDeployments: [],
    ...overrides,
  });
const composition = availableComposition();

const targetForbidden = Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)({
  ...problem,
  _tag: 'ShellTargetForbiddenProblem',
  status: 403,
});
const targetNotFound = Schema.decodeUnknownSync(ShellTargetNotFoundProblemSchema)({
  ...problem,
  _tag: 'ShellTargetNotFoundProblem',
  status: 404,
});
const capabilityUnavailable = Schema.decodeUnknownSync(ShellCapabilityUnavailableProblemSchema)({
  ...problem,
  _tag: 'ShellCapabilityUnavailableProblem',
  retryable: true,
  status: 503,
});

/** The Shell BFF of a signed-in Ada with her Alpha company selected; a test overrides single reads. */
const signedInBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    availableLegalEntities: () => Effect.succeed(legalEntities),
    availableTenants: () => Effect.succeed(tenants),
    currentSession: () => Effect.succeed(session({ identity, state: 'authenticated' })),
    demoAccountCapability: () => Effect.succeed({ canManage: false }),
    executeLegalEntityDetail: () => Effect.fail(targetNotFound),
    resolveModuleTarget: () => Effect.fail(targetForbidden),
    shellComposition: () => Effect.succeed(composition),
    ...overrides,
  });
type Bff = ReturnType<typeof makeShellBff>;

/** The next loader of the same document: it may reuse what earlier loaders read. */
const loadAgain = (bff: Bff, input: Request = request(), configuration = {}) =>
  loadHomePageModel(input).pipe(
    Effect.provide(bff.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(configuration)),
  );
/** One browser loader against the BFF, without the session and Shell reads an earlier loader kept. */
const loadModel = (bff: Bff, input: Request = request(), configuration = {}) =>
  resetBrowserSessionCache.pipe(Effect.andThen(loadAgain(bff, input, configuration)));
const endpoints = (bff: Bff) => bff.requests.map((received) => received.endpoint);
const requestsTo = (bff: Bff, endpoint: ShellBffEndpoint) =>
  bff.requests.filter((received) => received.endpoint === endpoint);

/** Answers each call with the next answer, the last one for every call after it. */
const inTurn = <Answer>(...answers: readonly [Answer, ...Answer[]]) => {
  const pending = [...answers];
  return () => (pending.length > 1 ? pending.shift() : pending[0]) ?? answers[0];
};

// Runs first: every browser loader after it pins this test document to the release it read.
it.effect('reuses the current-release composition for loaders that ask with its pinned revision', () =>
  Effect.gen(function* verifyRevisionAlias() {
    expect(yield* Effect.flip(getDocumentCompositionRevision())).toMatchObject({ reason: 'uninitialized' });
    const bff = signedInBff();
    const first = yield* loadModel(bff);
    const second = yield* loadAgain(bff);
    expect(first).toMatchObject({ compositionRevision, state: 'authenticated' });
    expect(second).toMatchObject({ compositionRevision, state: 'authenticated' });
    expect(requestsTo(bff, 'shellComposition').map(({ body }) => body)).toEqual([{}]);
  }),
);

it.effect('resolves trusted context before returning one serializable composition', () =>
  Effect.gen(function* verifyCase1() {
    const bff = signedInBff();
    expect(yield* loadModel(bff)).toEqual({
      compositionRevision,
      contextState: 'authenticated',
      gatewayAudiences: [],
      homeContribution: { state: 'forbidden' },
      identity,
      legalEntities: {
        items: [{ legalEntityId, legalName: 'Alpha company' }],
        state: 'available',
        tenantContextAvailable: false,
      },
      navigation: {
        deniedAppIds: [],
        items: navigation,
        moduleIds: [...new Set(navigation.map(({ moduleId }) => moduleId))],
        state: 'available',
        unavailableDeployments: [],
      },
      selectedLegalEntityId: legalEntityId,
      state: 'authenticated',
      tenants: {
        items: [
          { name: 'Alpha tenant', tenantId },
          { name: 'Zeta tenant', tenantId: otherTenantId },
        ],
        state: 'available',
      },
    });
    // The session is read first; every other read waits for it.
    expect(endpoints(bff)[0]).toBe('currentSession');
    expect(endpoints(bff).slice(1).toSorted()).toEqual([
      'availableLegalEntities',
      'availableTenants',
      'demoAccountCapability',
      'executeLegalEntityDetail',
      'shellComposition',
    ]);
  }),
);

it.effect('does not request composition for an anonymous session', () =>
  Effect.gen(function* verifyCase2() {
    const bff = signedInBff({ currentSession: () => Effect.succeed(session({ state: 'anonymous' })) });
    expect(yield* loadModel(bff)).toEqual({
      state: 'anonymous',
    });
    expect(endpoints(bff)).toEqual(['currentSession']);
  }),
);

it.effect('retains company admission when no role exposes navigation or a module Home', () =>
  Effect.gen(function* admittedWithoutRoles() {
    const bff = signedInBff({ shellComposition: () => Effect.succeed(availableComposition({ navigation: [] })) });
    expect(yield* loadModel(bff)).toMatchObject({
      contextState: 'authenticated',
      homeContribution: { state: 'forbidden' },
      legalEntities: { items: [{ legalEntityId, legalName: 'Alpha company' }], state: 'available' },
      navigation: { items: [], state: 'available' },
      selectedLegalEntityId: legalEntityId,
      state: 'authenticated',
    });
  }),
);

it.effect('does not invent a selected legal entity while a tenant session requires selection', () =>
  Effect.gen(function* verifyCase3() {
    const bff = signedInBff({
      currentSession: () =>
        Effect.succeed(
          session({
            availableLegalEntities: [{ legalEntityId, legalName: 'Alpha company' }],
            identity: tenantIdentity,
            state: 'selection_required',
          }),
        ),
    });
    const model = yield* loadModel(bff);
    expect(model).toMatchObject({
      contextState: 'selection_required',
      identity: tenantIdentity,
      legalEntities: {
        items: [{ legalEntityId, legalName: 'Alpha company' }],
        state: 'available',
        tenantContextAvailable: false,
      },
      state: 'authenticated',
    });
    expect(model).not.toHaveProperty('selectedLegalEntityId');
    expect(endpoints(bff)).not.toContain('shellComposition');
    expect(requestsTo(bff, 'availableLegalEntities')).toHaveLength(1);
  }),
);

it.effect('uses the configured HTTPS origin for the server-side session request', () =>
  Effect.gen(function* verifyCase4() {
    const bff = signedInBff({ currentSession: () => Effect.succeed(session({ state: 'anonymous' })) });
    yield* loadModel(bff, new Request('http://shell.stage.example.test/en'), {
      BETTER_AUTH_URL: 'https://shell.stage.example.test',
    });
    expect(bff.requests.at(-1)?.url).toBe('https://shell.stage.example.test/shell-super-app-api/auth/session');
  }),
);

it.effect('keeps the configured local HTTP origin for the server-side session request', () =>
  Effect.gen(function* verifyCase6() {
    const bff = signedInBff({ currentSession: () => Effect.succeed(session({ state: 'anonymous' })) });
    yield* loadModel(bff, new Request('http://localhost:3020/en'), { BETTER_AUTH_URL: 'http://localhost:3020' });
    expect(bff.requests.at(-1)?.url).toBe('http://localhost:3020/shell-super-app-api/auth/session');
  }),
);

it.effect('keeps composition failure authoritative after starting independent company reads', () =>
  Effect.gen(function* verifyCase8() {
    const bff = signedInBff({ shellComposition: () => Effect.fail(capabilityUnavailable) });
    expect(yield* loadModel(bff)).toEqual({ state: 'unavailable' });
    expect(endpoints(bff)).toContain('shellComposition');
    for (const read of ['availableLegalEntities', 'availableTenants', 'demoAccountCapability'] as const) {
      expect(requestsTo(bff, read).length).toBeLessThanOrEqual(1);
    }
  }),
);

it.effect('requires a document reload despite speculative company reads for a stale release', () =>
  Effect.gen(function* staleCompositionStopsOwnerReads() {
    const bff = signedInBff({
      shellComposition: () =>
        Effect.fail(
          Schema.decodeUnknownSync(ShellReloadRequiredProblemSchema)({
            ...problem,
            _tag: 'ShellReloadRequiredProblem',
            status: 409,
          }),
        ),
    });
    expect(yield* loadModel(bff)).toEqual({ state: 'reload_required' });
    expect(endpoints(bff)).toContain('shellComposition');
    for (const read of ['availableLegalEntities', 'availableTenants', 'demoAccountCapability'] as const) {
      expect(requestsTo(bff, read).length).toBeLessThanOrEqual(1);
    }
  }),
);

const tenantCapabilityUnavailable = () =>
  Effect.fail(
    Schema.decodeUnknownSync(TenantCapabilityUnavailableProblemSchema)({
      ...problem,
      _tag: 'TenantCapabilityUnavailableProblem',
      retryable: true,
      status: 503,
    }),
  );

it.effect('maps tenant failure to the current-tenant fallback without discarding composition', () =>
  Effect.gen(function* verifyCase9() {
    const bff = signedInBff({ availableTenants: tenantCapabilityUnavailable });
    expect(yield* loadModel(bff)).toMatchObject({
      navigation: { items: navigation, state: 'available' },
      tenants: {
        items: [{ name: tenantId, tenantId }],
        state: 'unavailable',
      },
    });
  }),
);

it.effect('keeps legal-entity acquisition failure explicit without claiming choices are available', () =>
  Effect.gen(function* verifyCase10() {
    const bff = signedInBff({ availableLegalEntities: tenantCapabilityUnavailable });
    expect(yield* loadModel(bff)).toMatchObject({
      legalEntities: { items: [], state: 'unavailable' },
      state: 'authenticated',
    });
  }),
);

it.effect('does not collapse an authentication infrastructure failure into an anonymous session', () =>
  Effect.gen(function* verifyCase11() {
    const bff = signedInBff({
      currentSession: () =>
        Effect.fail(
          Schema.decodeUnknownSync(AuthenticationUnavailableProblemSchema)({
            ...problem,
            _tag: 'AuthenticationUnavailableProblem',
            status: 503,
          }),
        ),
    });
    expect(yield* loadModel(bff)).toEqual({
      state: 'unavailable',
    });
  }),
);

it.effect('tears down stale authenticated data when tenant context requires authentication', () =>
  Effect.gen(function* verifyCase12() {
    const bff = signedInBff({
      availableTenants: () =>
        Effect.fail(
          Schema.decodeUnknownSync(TenantAuthenticationRequiredProblemSchema)({
            ...problem,
            _tag: 'TenantAuthenticationRequiredProblem',
            status: 401,
          }),
        ),
    });
    expect(yield* loadModel(bff)).toEqual({
      reason: 'session_ended',
      state: 'anonymous',
    });
  }),
);

const identityForbidden = Schema.decodeUnknownSync(OntosIdentityForbiddenProblemSchema)({
  ...problem,
  _tag: 'OntosIdentityForbiddenProblem',
  status: 403,
});

it.effect('sends a disabled account to sign-in instead of the unavailable state (S00)', () =>
  Effect.gen(function* verifyDisabledAccount() {
    const bff = signedInBff({ currentSession: () => Effect.fail(identityForbidden) });
    expect(yield* loadModel(bff)).toEqual({ reason: 'account_forbidden', state: 'anonymous' });
  }),
);

it.effect('reuses one authenticated browser session across loaders and rereads after an anonymous answer', () =>
  Effect.gen(function* verifySessionMemo() {
    const signedIn = signedInBff();
    const load = loadAgain(signedIn, new Request('https://shell.example.test/en/ukoly'));
    yield* resetBrowserSessionCache;
    yield* Effect.all([load, load, load], { concurrency: 'unbounded' });
    expect(requestsTo(signedIn, 'currentSession')).toHaveLength(1);

    const signedOut = signedInBff({ currentSession: () => Effect.succeed(session({ state: 'anonymous' })) });
    const loadSignedOut = loadAgain(signedOut, new Request('https://shell.example.test/en/ukoly'));
    yield* resetBrowserSessionCache;
    yield* loadSignedOut;
    yield* loadSignedOut;
    expect(requestsTo(signedOut, 'currentSession')).toHaveLength(2);
  }),
);

it.effect('answers the next load with the current person after a session boundary', () =>
  Effect.gen(function* verifyBoundaryDropsPreviousPerson() {
    const grace = { ...identity, displayName: 'Grace Hopper', principalId: 'principal-2' };
    const bff = signedInBff({
      currentSession: inTurn<Effect.Effect<CurrentSession>>(
        Effect.succeed(session({ identity, state: 'authenticated' })),
        Effect.succeed(session({ identity: grace, state: 'authenticated' })),
      ),
    });
    expect(yield* loadModel(bff)).toMatchObject({ identity: { displayName: 'Ada Lovelace' }, state: 'authenticated' });

    yield* endBrowserSession;

    expect(yield* loadAgain(bff)).toMatchObject({
      identity: { displayName: 'Grace Hopper', principalId: 'principal-2' },
      state: 'authenticated',
    });
  }),
);

it.effect('shares one composition, tenant and legal-entity read across concurrent browser loaders', () =>
  Effect.gen(function* verifyContextMemo() {
    const bff = signedInBff({
      availableTenants: inTurn<ReturnType<NonNullable<ShellBffScript['availableTenants']>>>(
        Effect.succeed(tenants),
        Effect.fail(
          Schema.decodeUnknownSync(TenantInternalProblemSchema)({
            ...problem,
            _tag: 'TenantInternalProblem',
            status: 500,
          }),
        ),
        Effect.succeed(tenants),
      ),
    });
    const load = loadAgain(bff, new Request('https://shell.example.test/en/ukoly'));
    yield* resetBrowserSessionCache;
    yield* Effect.all([load, load, load], { concurrency: 'unbounded' });
    expect(requestsTo(bff, 'shellComposition')).toHaveLength(1);
    expect(requestsTo(bff, 'availableTenants')).toHaveLength(1);
    expect(requestsTo(bff, 'availableLegalEntities')).toHaveLength(1);

    // A failed answer is never kept: the next loader reads the tenants again.
    yield* resetBrowserSessionCache;
    yield* load;
    yield* load;
    expect(requestsTo(bff, 'availableTenants')).toHaveLength(3);
  }),
);

it.effect('rechecks Home contribution permissions on every visit even when navigation composition is reused', () =>
  Effect.gen(function* freshHomeContributionPermission() {
    const bff = signedInBff({
      resolveModuleTarget: inTurn<ReturnType<NonNullable<ShellBffScript['resolveModuleTarget']>>>(
        Effect.fail(targetForbidden),
        Effect.fail(targetForbidden),
        Effect.fail(capabilityUnavailable),
      ),
      shellComposition: () =>
        Effect.succeed(
          availableComposition({
            homeComponents: [
              {
                entrypointKey: 'fixture.summary.component.home',
                moduleId: 'fixture.summary',
                order: 100,
                requiresModules: ['fixture.summary', 'fixture.unlisted'],
              },
              {
                entrypointKey: 'fixture.dashboard.component.home',
                moduleId: 'fixture.dashboard',
                order: 200,
                requiresModules: ['fixture.dashboard', 'fixture.sales', 'fixture.tasks'],
              },
            ],
            navigation: ['fixture.dashboard', 'fixture.sales', 'fixture.tasks'].map((moduleId) => ({
              ...futureItem,
              moduleId,
            })),
          }),
        ),
    });
    yield* loadModel(bff);
    yield* loadAgain(bff);
    const homeTargets = requestsTo(bff, 'resolveModuleTarget');
    expect(homeTargets).toHaveLength(2);
    expect(homeTargets[0]?.body).toEqual({
      compositionRevision,
      entrypointKey: 'fixture.dashboard.component.home',
      moduleId: 'fixture.dashboard',
    });
    expect(homeTargets[0]?.targetSource).toBe('home');
    expect(requestsTo(bff, 'shellComposition')).toHaveLength(1);
    expect(yield* loadAgain(bff)).toMatchObject({ homeContribution: { state: 'unavailable' } });
  }),
);

it.effect('does not resolve the Home component from anonymous, selection-required or non-Home routes', () =>
  Effect.gen(function* homeContributionContextGate() {
    const signedIn = signedInBff();
    yield* loadModel(signedIn, request('https://shell.example.test/en/ukoly'));
    expect(endpoints(signedIn)).not.toContain('resolveModuleTarget');
    const signedOut = signedInBff({ currentSession: () => Effect.succeed(session({ state: 'anonymous' })) });
    yield* loadModel(signedOut);
    expect(endpoints(signedOut)).not.toContain('resolveModuleTarget');
  }),
);

const peopleNavigation = [
  { ...futureItem, href: '/fixture/people', requiresCapability: 'people_administration' as const },
  { ...futureItem, href: '/fixture/clients' },
];
const peopleAdministrationItems = (allowed: boolean) =>
  allowed
    ? [
        expect.objectContaining({ href: '/fixture/clients' }),
        expect.objectContaining({ href: '/sprava/lide-a-role' }),
        expect.objectContaining({ href: '/sprava/ke-schvaleni' }),
        expect.objectContaining({ href: '/sprava/aktivita-agentu' }),
        expect.objectContaining({ href: '/sprava/pripojene-aplikace' }),
      ]
    : [expect.objectContaining({ href: '/fixture/clients' })];

it.effect.each([false, true])(
  'offers people administration only after a successful server capability check (%s)',
  (allowed) =>
    Effect.gen(function* peopleNavigationCapability() {
      const bff = signedInBff({
        demoAccountCapability: () => Effect.succeed({ canManage: allowed }),
        shellComposition: () => Effect.succeed(availableComposition({ navigation: peopleNavigation })),
      });
      expect(yield* loadModel(bff)).toMatchObject({
        navigation: { deniedAppIds: [], items: peopleAdministrationItems(allowed) },
      });
      expect(requestsTo(bff, 'demoAccountCapability')).toHaveLength(1);
    }),
);

const welcomeRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;

it.effect('shows the welcome text the selected company provides on the Shell welcome page', () =>
  Effect.gen(function* companyWelcome() {
    const bff = signedInBff({
      executeLegalEntityDetail: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(LegalEntityDetailResponseSchema)({
            legalEntityRef: welcomeRef,
            legalName: 'Alpha company',
            status: 'active',
            welcome: 'Bread and pastry for the whole town.',
          }),
        ),
    });
    expect(yield* loadModel(bff)).toMatchObject({
      companyWelcome: 'Bread and pastry for the whole town.',
      homeContribution: { state: 'forbidden' },
    });
    expect(requestsTo(bff, 'executeLegalEntityDetail').at(-1)?.body).toEqual({ legalEntityRef: welcomeRef });
  }),
);

/** Server rendering: no browser document, like the SSR loader on Node and Workers. */
const asServerRender = <Value, Failure, Requirements>(operation: Effect.Effect<Value, Failure, Requirements>) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  return Effect.acquireUseRelease(
    Effect.sync(() => Reflect.deleteProperty(globalThis, 'document')),
    () => operation,
    () =>
      Effect.sync(() => {
        if (descriptor !== undefined) {
          Object.defineProperty(globalThis, 'document', descriptor);
        }
      }),
  );
};
// happy-dom's Request drops the cookie header (a browser-forbidden name); the server's request carries it.
const serverRequest = (url = 'https://shell.example.test/en') =>
  Object.defineProperty(new Request(url), 'headers', {
    value: new Headers({ cookie: 'better-auth.session_token=test-session' }),
  });

const documentContext = Schema.decodeUnknownSync(ShellDocumentContextSchema);
const documentContextOf = (overrides: Partial<typeof ShellDocumentContextSchema.Encoded> = {}) =>
  documentContext({
    canManagePeople: false,
    composition,
    home: { contribution: { state: 'forbidden' } },
    legalEntities,
    session: { identity, state: 'authenticated' },
    tenants: { state: 'available', tenants: [{ name: 'Alpha tenant', tenantId }] },
    ...overrides,
  });

/** The BFF answering server rendering with one document context; every separate read is left unscripted. */
const documentBff = (context: ReturnType<typeof documentContextOf>, overrides: ShellBffScript = {}) =>
  makeShellBff({ documentContext: () => Effect.succeed(context), ...overrides });

const serverModel = (bff: Bff, url?: string) => asServerRender(loadModel(bff, serverRequest(url)));

/** The serializer TanStack's server rendering embeds every loader's data with, as its router core loads it. */
interface EmbeddingSerializer {
  readonly crossSerialize: (value: HomePageModel) => string;
  readonly deserialize: (source: string) => HomePageModel;
  readonly serialize: (value: HomePageModel) => string;
}
const embeddingSerializer = (): EmbeddingSerializer => {
  const fromShell = createRequire(`${process.cwd()}/package.json`);
  const fromRouter = createRequire(fromShell.resolve('@tanstack/react-router'));
  return createRequire(fromRouter.resolve('@tanstack/router-core'))('seroval');
};

/** Names a person controls (their company, their name, a role) written to escape the document's script. */
const HOSTILE = '</script><script>alert(1)</script><!-- \u2028\u2029 ]]> "\'`';

it.effect('the server model cannot break out of the document script, whatever the names it carries', () =>
  Effect.gen(function* hostileNames() {
    const hostileIdentity = { ...identity, displayName: HOSTILE, legalName: HOSTILE };
    const bff = documentBff(
      documentContextOf({
        legalEntities: { ...legalEntities, legalEntities: [{ legalEntityId, legalName: HOSTILE }] },
        session: { identity: hostileIdentity, state: 'authenticated' },
        tenants: { state: 'available', tenants: [{ name: HOSTILE, tenantId }] },
      }),
    );
    const model = yield* serverModel(bff);
    const serializer = embeddingSerializer();
    const embedded = serializer.crossSerialize(model);
    expect(embedded).toContain('alert(1)');
    expect(embedded).not.toMatch(/<\/script/iu);
    expect(embedded).not.toContain('<!--');
    expect(embedded).not.toMatch(/[\u2028\u2029]/u);
    expect(embedded).not.toContain('<');
    // The browser reads back exactly the names the server rendered, the hostile ones included.
    expect(serializer.deserialize(serializer.serialize(model))).toEqual(model);
  }),
);

it.effect('server rendering reads the whole document context in one request', () =>
  Effect.gen(function* serverReadsOnce() {
    const bff = documentBff(documentContextOf());
    expect(yield* serverModel(bff)).toEqual({
      compositionRevision,
      contextState: 'authenticated',
      gatewayAudiences: [],
      homeContribution: { state: 'forbidden' },
      identity,
      legalEntities: {
        items: [{ legalEntityId, legalName: 'Alpha company' }],
        state: 'available',
        tenantContextAvailable: false,
      },
      navigation: {
        deniedAppIds: [],
        items: navigation,
        moduleIds: ['future.generated'],
        state: 'available',
        unavailableDeployments: [],
      },
      selectedLegalEntityId: legalEntityId,
      state: 'authenticated',
      tenants: { items: [{ name: 'Alpha tenant', tenantId }], state: 'available' },
      // Exactly the separate endpoints' answers to this person here, and nothing else (no token, no assertion).
      browserReads: {
        canManagePeople: false,
        composition,
        legalEntities,
        tenants: { tenants: [{ name: 'Alpha tenant', tenantId }] },
      },
    });
    // One request: no separate session, composition, choice, capability, assertion or target read.
    expect(bff.requests.map(({ body, endpoint }) => ({ body, endpoint }))).toEqual([
      { body: { home: true }, endpoint: 'documentContext' },
    ]);
  }),
);

it.effect('a document whose hint checks could not answer primes nothing, so the browser asks again', () =>
  Effect.gen(function* unansweredHints() {
    const { canManagePeople: _unanswered, ...withoutPeopleHint } = documentContextOf();
    for (const context of [withoutPeopleHint, documentContextOf({ tenantContextUnavailable: true })]) {
      const model = yield* serverModel(documentBff(context));
      // The page still shows the hint as "no"; only nothing is kept as an answer.
      expect(model).toMatchObject({ state: 'authenticated' });
      expect(model).not.toHaveProperty('browserReads');
    }
  }),
);

/** The reads the server-rendered model answers; the session is always read fresh. */
const primedShellReads = [
  'shellComposition',
  'availableTenants',
  'availableLegalEntities',
  'demoAccountCapability',
] as const;

/**
 * Renders the document on the server, then primes its reads in this browser document as hydration does, and pins
 * the document to the rendered release. The returned BFF also answers the browser's separate reads; `browserReads`
 * lists what the browser asked after hydration.
 */
const hydrateServerModel = (overrides: ShellBffScript = {}) =>
  Effect.gen(function* hydrate() {
    const bff = signedInBff({ documentContext: () => Effect.succeed(documentContextOf()), ...overrides });
    const model = yield* serverModel(bff);
    if (
      model.state !== 'authenticated' ||
      model.browserReads === undefined ||
      model.compositionRevision === undefined
    ) {
      return yield* Effect.die('Expected a server-rendered model with its browser reads');
    }
    yield* resetBrowserSessionCache;
    yield* primeBrowserReads(model.identity, model.browserReads, 'https://shell.example.test/en').pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    );
    yield* pinDocumentCompositionRevision(model.compositionRevision, document);
    const rendered = bff.requests.length;
    return {
      bff,
      browserReads: () => endpoints(bff).slice(rendered),
      load: () => loadAgain(bff, new Request('https://shell.example.test/en/ukoly')),
      model,
      reads: model.browserReads,
    };
  });

it.effect('the first browser loader after hydration reuses the server-rendered Shell reads', () =>
  Effect.gen(function* hydratedReads() {
    const { browserReads, load, model: server } = yield* hydrateServerModel();
    expect(yield* load()).toMatchObject({
      compositionRevision,
      legalEntities: server.legalEntities,
      navigation: server.navigation,
      tenants: server.tenants,
    });
    // The session is read fresh, so the person and company the browser holds now choose the primed answers.
    expect(browserReads()).toEqual(['currentSession']);
  }),
);

/** Who the browser's session names after the render, through each way the identity can change under a document. */
const changedIdentities = [
  [
    'another company of the same person (company switch)',
    { ...identity, legalEntityId: otherLegalEntityId, legalName: 'Beta' },
  ],
  ['another tenant (tenant switch)', { ...identity, tenantId: otherTenantId }],
  ['another person signed in in this browser', { ...identity, displayName: 'Grace', principalId: 'principal-2' }],
  ['a support session acting as another person', { ...identity, displayName: 'Support', principalId: 'principal-3' }],
] as const;

for (const [change, nowSignedIn] of changedIdentities) {
  it.effect(`never answers primed reads after the identity changed: ${change}`, () =>
    Effect.gen(function* changedIdentity() {
      const { browserReads, load } = yield* hydrateServerModel({
        currentSession: () => Effect.succeed(session({ identity: nowSignedIn, state: 'authenticated' })),
      });
      expect(yield* load()).toMatchObject({ identity: nowSignedIn, state: 'authenticated' });
      // Every read the render primed is asked again, for the identity the session names now.
      for (const primedRead of primedShellReads) {
        expect(browserReads().filter((endpoint) => endpoint === primedRead)).toHaveLength(1);
      }
    }),
  );
}

it.effect('primes a document model once: a session boundary is never undone by a later render', () =>
  Effect.gen(function* primedOnce() {
    const { browserReads, load, model: server, reads } = yield* hydrateServerModel();
    yield* endBrowserSession;
    // The Shell renders again from the same server model after the boundary.
    yield* primeBrowserReads(server.identity, reads, 'https://shell.example.test/en').pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    );
    yield* load();
    for (const primedRead of primedShellReads) {
      expect(browserReads().filter((endpoint) => endpoint === primedRead)).toHaveLength(1);
    }
  }),
);

it.effect('a session boundary drops the primed reads, so the next loader asks the Shell again', () =>
  Effect.gen(function* primedReadsEndWithSession() {
    const { browserReads, load } = yield* hydrateServerModel();
    yield* endBrowserSession;
    yield* load();
    expect(browserReads().toSorted()).toEqual(['currentSession', ...primedShellReads].toSorted());
  }),
);

it.effect('a module page document reads its target in the same document-context request', () =>
  Effect.gen(function* moduleDocument() {
    const target = { state: 'selection_required' as const };
    const bff = documentBff(documentContextOf({ target }));
    const moduleDocumentModel = yield* asServerRender(
      loadServerModuleDocument(serverRequest('https://shell.example.test/en/contacts'), {
        canonicalPath: '/contacts',
      }).pipe(
        Effect.provide(bff.layer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      ),
    );
    expect(moduleDocumentModel.target).toEqual(target);
    expect(moduleDocumentModel.shell).toMatchObject({ compositionRevision, state: 'authenticated' });
    expect(bff.requests.map(({ body, endpoint, targetSource }) => ({ body, endpoint, targetSource }))).toEqual([
      { body: { target: { canonicalPath: '/contacts' } }, endpoint: 'documentContext', targetSource: 'server_render' },
    ]);
  }),
);

const withoutLegalEntities = ({ legalEntities: _legalEntities, ...rest }: ReturnType<typeof documentContextOf>) => rest;

it.effect('server rendering maps each document-context part to the same models as the separate reads', () =>
  Effect.gen(function* serverPartOutcomes() {
    expect(yield* serverModel(documentBff(documentContext({ session: { state: 'anonymous' } })))).toEqual({
      state: 'anonymous',
    });
    expect(yield* serverModel(documentBff(documentContextOf({ composition: { state: 'reload_required' } })))).toEqual({
      state: 'reload_required',
    });
    expect(yield* serverModel(documentBff(documentContextOf({ composition: { state: 'unavailable' } })))).toEqual({
      state: 'unavailable',
    });
    expect(
      yield* serverModel(documentBff(documentContextOf({ tenants: { state: 'authentication_required' } }))),
    ).toEqual({ reason: 'session_ended', state: 'anonymous' });
    expect(
      yield* serverModel(documentBff(withoutLegalEntities(documentContextOf({ tenants: { state: 'unavailable' } })))),
    ).toMatchObject({
      legalEntities: { items: [], state: 'unavailable' },
      tenants: { items: [{ name: tenantId, tenantId }], state: 'unavailable' },
    });
    const forbidden = makeShellBff({ documentContext: () => Effect.fail(identityForbidden) });
    expect(yield* serverModel(forbidden)).toEqual({ reason: 'account_forbidden', state: 'anonymous' });
  }),
);

it.effect('server rendering keeps a context without a selected legal entity free of composition data', () =>
  Effect.gen(function* serverSelectionRequired() {
    const bff = documentBff(
      documentContext({
        composition: { navigation: [], state: 'selection_required' },
        legalEntities: {
          legalEntities: [{ legalEntityId: otherLegalEntityId, legalName: 'Beta company' }],
          state: 'selection_required',
          tenantContextAvailable: true,
        },
        session: {
          availableLegalEntities: [{ legalEntityId: otherLegalEntityId, legalName: 'Beta company' }],
          identity: tenantIdentity,
          state: 'selection_required',
        },
        tenants: { state: 'available', tenants: [{ name: 'Alpha tenant', tenantId }] },
      }),
    );
    const model = yield* serverModel(bff);
    expect(model).toMatchObject({
      contextState: 'selection_required',
      legalEntities: { items: [{ legalEntityId: otherLegalEntityId, legalName: 'Beta company' }], state: 'available' },
      navigation: { items: [], state: 'available' },
    });
    expect(model).not.toHaveProperty('compositionRevision');
  }),
);

it.effect('server rendering offers people administration from the context capability', () =>
  Effect.gen(function* serverPeopleCapability() {
    for (const canManagePeople of [false, true]) {
      const bff = documentBff(
        documentContextOf({ canManagePeople, composition: availableComposition({ navigation: peopleNavigation }) }),
      );
      expect(yield* serverModel(bff)).toMatchObject({
        navigation: { items: peopleAdministrationItems(canManagePeople) },
      });
    }
  }),
);

it.effect('server rendering embeds the admitted Home target without a separate request', () =>
  Effect.gen(function* serverAdmitsHome() {
    const contribution = {
      state: 'ready' as const,
      target: {
        appId: 'fixture-dashboard',
        componentKey: 'fixture.dashboard.home',
        compositionRevision,
        entrypointKey: 'fixture.dashboard.component.home',
        federation: {
          expose: './Home',
          manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/dashboard/mf-manifest.json' },
          remoteName: 'fixtureDashboard',
        },
        moduleId: 'fixture.dashboard',
        routeParameters: {},
        writable: false,
      },
    };
    const home = documentBff(documentContextOf({ home: { contribution } }));
    expect(yield* serverModel(home)).toMatchObject({
      homeContribution: { state: 'ready', target: { compositionRevision, moduleId: 'fixture.dashboard' } },
      state: 'authenticated',
    });
    expect(endpoints(home)).toEqual(['documentContext']);
    const page = documentBff(documentContextOf());
    yield* serverModel(page, 'https://shell.example.test/en/ukoly');
    expect(page.requests.at(-1)?.body).toEqual({});
  }),
);

it.effect('server rendering preserves the company welcome and unavailable Home outcomes', () =>
  Effect.gen(function* serverHomeOutcomes() {
    const welcome = documentBff(
      documentContextOf({ home: { contribution: { state: 'forbidden' }, welcome: 'Firemní přivítání' } }),
    );
    expect(yield* serverModel(welcome)).toMatchObject({
      companyWelcome: 'Firemní přivítání',
      homeContribution: { state: 'forbidden' },
    });
    const unavailable = documentBff(documentContextOf({ home: { contribution: { state: 'unavailable' } } }));
    expect(yield* serverModel(unavailable)).toMatchObject({ homeContribution: { state: 'unavailable' } });
    expect([...endpoints(welcome), ...endpoints(unavailable)]).toEqual(['documentContext', 'documentContext']);
  }),
);

it.effect('server rendering embeds no gateway assertions and leaves them to the browser batch', () =>
  Effect.gen(function* serverWithoutAssertions() {
    const bff = documentBff(
      documentContextOf({ composition: availableComposition({ gatewayAudiences: ['future-generated'] }) }),
    );
    const model = yield* serverModel(bff, 'https://shell.example.test/en/ukoly');
    expect(model).toMatchObject({ gatewayAudiences: ['future-generated'], state: 'authenticated' });
    expect(model).not.toHaveProperty('gatewayAssertions');
    expect(endpoints(bff)).toEqual(['documentContext']);
  }),
);

const tenantSession = (): CurrentSession =>
  session({ availableLegalEntities: [], identity: tenantIdentity, state: 'tenant_authenticated' });
const tenantScopeComposition: ShellComposition = shellComposition({ navigation: [], state: 'selection_required' });

it.effect('reconstructs explicit tenant scope on browser reload without company navigation', () =>
  Effect.gen(function* browserTenantScope() {
    const bff = signedInBff({
      availableLegalEntities: () =>
        Effect.succeed(
          legalEntitiesResponse({
            legalEntities: [{ legalEntityId, legalName: 'Alpha company' }],
            state: 'tenant_authenticated',
            tenantContextAvailable: true,
          }),
        ),
      currentSession: () =>
        Effect.succeed(
          session({
            availableLegalEntities: [{ legalEntityId, legalName: 'Alpha company' }],
            identity: tenantIdentity,
            state: 'tenant_authenticated',
          }),
        ),
      documentContext: () =>
        Effect.succeed(
          documentContextOf({ composition: tenantScopeComposition, compositionRevision, session: tenantSession() }),
        ),
    });
    const model = yield* loadModel(bff);
    expect(model).toMatchObject({
      compositionRevision,
      contextState: 'tenant_authenticated',
      legalEntities: { tenantContextAvailable: true },
      navigation: { items: [] },
    });
    expect(model).not.toHaveProperty('selectedLegalEntityId');
    expect(endpoints(bff)).not.toContain('shellComposition');
    expect(requestsTo(bff, 'documentContext')).toHaveLength(1);
  }),
);

it.effect('reconstructs explicit tenant scope from the server document context', () =>
  Effect.gen(function* serverTenantScope() {
    const bff = documentBff(
      documentContextOf({
        composition: tenantScopeComposition,
        compositionRevision,
        legalEntities: { legalEntities: [], state: 'tenant_authenticated', tenantContextAvailable: true },
        session: tenantSession(),
      }),
    );
    const model = yield* serverModel(bff);
    expect(model).toMatchObject({
      compositionRevision,
      contextState: 'tenant_authenticated',
      legalEntities: { tenantContextAvailable: true },
      navigation: { items: [] },
    });
    expect(model).not.toHaveProperty('selectedLegalEntityId');
  }),
);
