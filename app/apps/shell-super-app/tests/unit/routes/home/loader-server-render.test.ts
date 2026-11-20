// @rstest-environment node
import { createRequire } from 'node:module';

import { ConfigProvider, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AvailableLegalEntitiesResponseSchema,
  CurrentSessionSchema,
  OntosIdentityForbiddenProblemSchema,
  ShellCompositionSchema,
  ShellDocumentContextSchema,
} from '../../../../shared/browser-api.ts';
import type { CurrentSession, ShellComposition } from '../../../../shared/browser-api.ts';
import { loadHomePageModel, loadServerModuleDocument } from '../../../../src/routes/[lang]/home-page-model.ts';
import type { HomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';

const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherLegalEntityId = '20000000-0000-4000-8000-000000000002';
const tenantId = '30000000-0000-4000-8000-000000000001';
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
    headers: { cookie: 'better-auth.session_token=test-session' },
  });

const session = Schema.decodeUnknownSync(CurrentSessionSchema);
const legalEntitiesResponse = Schema.decodeUnknownSync(AvailableLegalEntitiesResponseSchema);
const legalEntities = legalEntitiesResponse({
  legalEntities: [{ legalEntityId, legalName: 'Alpha company' }],
  selectedLegalEntityId: legalEntityId,
  state: 'authenticated',
  tenantContextAvailable: false,
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

type Bff = ReturnType<typeof makeShellBff>;
const endpoints = (bff: Bff) => bff.requests.map((received) => received.endpoint);
const serverModel = (bff: Bff, url?: string) =>
  loadHomePageModel(request(url)).pipe(
    Effect.provide(bff.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
  );

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

const identityForbidden = Schema.decodeUnknownSync(OntosIdentityForbiddenProblemSchema)({
  ...problem,
  _tag: 'OntosIdentityForbiddenProblem',
  status: 403,
});

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

it.effect('server rendering preserves hostile names through the document serializer', () =>
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
    // The browser reads back exactly the names the server rendered, the hostile ones included.
    expect(serializer.deserialize(serializer.serialize(model))).toMatchObject({
      identity: { displayName: HOSTILE, legalName: HOSTILE },
      legalEntities: { items: [{ legalEntityId, legalName: HOSTILE }] },
      tenants: { items: [{ name: HOSTILE, tenantId }] },
    });
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

it.effect('a module page document reads its target in the same document-context request', () =>
  Effect.gen(function* moduleDocument() {
    const target = { state: 'selection_required' as const };
    const bff = documentBff(documentContextOf({ target }));
    const moduleDocumentModel = yield* loadServerModuleDocument(request('https://shell.example.test/en/contacts'), {
      canonicalPath: '/contacts',
    }).pipe(
      Effect.provide(bff.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
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
