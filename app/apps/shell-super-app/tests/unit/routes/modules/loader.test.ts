import { Cause, ConfigProvider, Deferred, Effect, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  ResolvedModuleTargetSchema,
  ShellCapabilityUnavailableProblemSchema,
  ShellSelectionRequiredProblemSchema,
  ShellTargetForbiddenProblemSchema,
  ShellTargetNotFoundProblemSchema,
} from '../../../../shared/browser-api.ts';
import type { CurrentSession, ShellDocumentContext, ShellDocumentTarget } from '../../../../shared/browser-api.ts';
import {
  BrowserModuleRevisionConflict,
  pinBrowserModuleTarget,
} from '../../../../src/routes/module-entrypoint-loader.ts';
import { loadModulePageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';
import {
  adaSignedIn,
  makeShellBff,
  shellCompositionRevision,
  signedInShellReads,
} from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';

/** The DOM's Request drops a cookie header, as a browser does; a loader request carries it. */
const request = (cookie = 'session=test-session') => {
  const value = new Request('https://shell.example.test/en/contacts');
  Object.defineProperty(value, 'headers', {
    value: new Headers({ cookie }),
  });
  return value;
};

const approvedTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
  appId: 'party-registry',
  componentKey: 'party.registry.page-contacts',
  compositionRevision: shellCompositionRevision,
  entrypointKey: 'party.registry.page.contacts',
  federation: {
    expose: './PageContacts',
    manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/party/release-a/mf-manifest.json' },
    remoteName: 'partyRegistryReleaseA',
  },
  moduleId: 'party.registry',
  routeParameters: {},
  writable: false,
});

const problem = { detail: 'redacted', title: 'redacted', type: 'about:blank' } as const;
/** The Problem Details the Shell BFF answers when it refuses a module target. */
const targetRefusals = {
  ShellCapabilityUnavailableProblem: Schema.decodeUnknownSync(ShellCapabilityUnavailableProblemSchema)({
    ...problem,
    _tag: 'ShellCapabilityUnavailableProblem',
    retryable: true,
    status: 503,
  }),
  ShellSelectionRequiredProblem: Schema.decodeUnknownSync(ShellSelectionRequiredProblemSchema)({
    ...problem,
    _tag: 'ShellSelectionRequiredProblem',
    status: 409,
  }),
  ShellTargetForbiddenProblem: Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)({
    ...problem,
    _tag: 'ShellTargetForbiddenProblem',
    status: 403,
  }),
  ShellTargetNotFoundProblem: Schema.decodeUnknownSync(ShellTargetNotFoundProblemSchema)({
    ...problem,
    _tag: 'ShellTargetNotFoundProblem',
    status: 404,
  }),
};

/** The Shell BFF of a signed-in Ada that approves the party registry target unless a test scripts otherwise. */
const moduleBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    ...signedInShellReads(adaSignedIn),
    resolveModuleTarget: () => Effect.succeed(approvedTarget),
    ...overrides,
  });

/** The module program reads its origin from config; pin an empty provider so every case is identical. */
const moduleModel = (bff: ReturnType<typeof moduleBff>, input: Parameters<typeof loadModulePageModel>[0]) =>
  loadModulePageModel(input).pipe(
    Effect.provide(bff.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
  );
const targetRequests = (bff: ReturnType<typeof moduleBff>) =>
  bff.requests.filter((received) => received.endpoint === 'resolveModuleTarget').map((received) => received.body);

it.effect('retains only route parameters selected by the authenticated server target', () =>
  Effect.gen(function* retainsServerSelectedRouteParameters() {
    const bff = moduleBff({
      resolveModuleTarget: () => Effect.succeed({ ...approvedTarget, routeParameters: { id: 'party-1' } }),
    });
    expect(
      yield* moduleModel(bff, {
        canonicalPath: '/contacts/party-1',
        request: request(),
      }),
    ).toMatchObject({
      routeParams: { id: 'party-1' },
      state: 'resolved',
      target: {
        appId: 'party-registry',
        componentKey: 'party.registry.page-contacts',
        entrypointKey: 'party.registry.page.contacts',
        moduleId: 'party.registry',
      },
    });
    expect(targetRequests(bff)).toEqual([
      { canonicalPath: '/contacts/party-1', compositionRevision: shellCompositionRevision },
    ]);
  }),
);

it.effect('retains module landing behavior when no exact page entrypoint is supplied', () =>
  Effect.gen(function* retainsModuleLandingBehaviorWhenNo() {
    const bff = moduleBff();
    expect(
      yield* moduleModel(bff, {
        params: { moduleId: 'party.registry' },
        request: request(),
      }),
    ).toMatchObject({ routeParams: {} });
    expect(targetRequests(bff)).toEqual([
      { compositionRevision: shellCompositionRevision, moduleId: 'party.registry' },
    ]);
  }),
);

it.effect('does not request or load a private target before authentication', () =>
  Effect.gen(function* doesNotRequestOrLoadA() {
    const anonymous: CurrentSession = { state: 'anonymous' };
    const bff = moduleBff({ currentSession: () => Effect.succeed(anonymous) });
    expect(
      yield* moduleModel(bff, {
        params: {
          entrypointKey: 'party.registry.page.contacts',
          moduleId: 'party.registry',
        },
        request: request(),
      }),
    ).toMatchObject({ state: 'selection_required' });
    expect(targetRequests(bff)).toEqual([]);
  }),
);

it.effect.each([
  ['ShellSelectionRequiredProblem', 'selection_required'],
  ['ShellTargetForbiddenProblem', 'forbidden'],
  ['ShellTargetNotFoundProblem', 'not_found'],
  ['ShellCapabilityUnavailableProblem', 'unavailable'],
] as const)('maps %s without returning a resolved private target', ([_tag, state]) =>
  Effect.gen(function* ShellSelectionRequiredProblem() {
    const bff = moduleBff({ resolveModuleTarget: () => Effect.fail(targetRefusals[_tag]) });
    const model = yield* moduleModel(bff, {
      params: {
        entrypointKey: 'party.registry.page.contacts',
        moduleId: 'party.registry',
      },
      request: request(),
    });
    expect(model).toMatchObject({ state });
    expect(model).not.toHaveProperty('target');
  }),
);

it.effect('fails with the typed timeout instead of hanging on an unresponsive shell read', () =>
  Effect.gen(function* failsWithTheTypedTimeout() {
    const entered = yield* Deferred.make<'entered'>();
    const bff = moduleBff({ currentSession: () => Effect.andThen(Deferred.succeed(entered, 'entered'), Effect.never) });
    const fiber = yield* Effect.forkChild(
      moduleModel(bff, {
        params: { moduleId: 'party.registry' },
        request: request(),
      }),
    );
    yield* Deferred.await(entered);

    yield* TestClock.adjust('30 seconds');

    expect(yield* Effect.flip(Fiber.join(fiber))).toBeInstanceOf(Cause.TimeoutError);
    expect(targetRequests(bff)).toEqual([]);
  }),
);

it.effect('pins one composition for each browser document and admits unchanged native identities', () =>
  Effect.gen(function* pinsDocumentIdentity() {
    const browserDocument = document.implementation.createHTMLDocument();
    yield* pinBrowserModuleTarget(approvedTarget, browserDocument);
    yield* pinBrowserModuleTarget(approvedTarget, browserDocument);
    yield* pinBrowserModuleTarget(
      { ...approvedTarget, federation: { ...approvedTarget.federation, expose: './PageDetails' } },
      browserDocument,
    );
  }),
);

it.effect('rejects another composition in the same document while admitting it after reload', () =>
  Effect.gen(function* rejectsMixedComposition() {
    const browserDocument = document.implementation.createHTMLDocument();
    yield* pinBrowserModuleTarget(approvedTarget, browserDocument);
    const promoted = { ...approvedTarget, compositionRevision: 'd'.repeat(64) };

    expect(yield* Effect.flip(pinBrowserModuleTarget(promoted, browserDocument))).toBeInstanceOf(
      BrowserModuleRevisionConflict,
    );
    yield* pinBrowserModuleTarget(promoted, document.implementation.createHTMLDocument());
  }),
);

it.effect.each([
  { sha256: 'b'.repeat(64), url: approvedTarget.federation.manifest.url },
  {
    sha256: approvedTarget.federation.manifest.sha256,
    url: 'https://assets.example.test/party/release-b/mf-manifest.json',
  },
])('rejects a changed immutable artifact behind an already pinned native remote', (manifest) =>
  Effect.gen(function* rejectsRemoteIdentityReplacement() {
    const browserDocument = document.implementation.createHTMLDocument();
    yield* pinBrowserModuleTarget(approvedTarget, browserDocument);

    expect(
      yield* Effect.flip(
        pinBrowserModuleTarget(
          { ...approvedTarget, federation: { ...approvedTarget.federation, manifest } },
          browserDocument,
        ),
      ),
    ).toBeInstanceOf(BrowserModuleRevisionConflict);
    yield* pinBrowserModuleTarget(approvedTarget, browserDocument);
  }),
);

it.effect('admits an independent approved remote within the same document composition', () =>
  Effect.gen(function* admitsIndependentRemote() {
    const browserDocument = document.implementation.createHTMLDocument();
    yield* pinBrowserModuleTarget(approvedTarget, browserDocument);
    yield* pinBrowserModuleTarget(
      Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
        ...approvedTarget,
        appId: 'inventory-stock',
        componentKey: 'inventory.stock.page-orders',
        entrypointKey: 'inventory.stock.page.orders',
        federation: {
          expose: './PageOrders',
          manifest: { sha256: 'b'.repeat(64), url: 'https://assets.example.test/inventory/release-a/mf-manifest.json' },
          remoteName: 'inventoryStockReleaseA',
        },
        moduleId: 'inventory.stock',
      }),
      browserDocument,
    );
  }),
);

/** Server rendering: no browser document, like the SSR loader on Node and Workers. */
const asServerRender = <Value, Failure>(operation: Effect.Effect<Value, Failure>) => {
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

/** The document context the BFF answers server rendering for Ada with the pinned composition. */
const signedInDocument = (target?: ShellDocumentTarget): ShellDocumentContext => {
  const document: ShellDocumentContext = {
    composition: {
      compositionRevision: shellCompositionRevision,
      deniedAppIds: [],
      gatewayAudiences: [],
      homeComponents: [],
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    },
    session: adaSignedIn,
  };
  return target === undefined ? document : { ...document, target };
};

/** Server rendering of /contacts for a visitor who carries the Shell's session cookie. */
const serverModel = (context: ShellDocumentContext) => {
  const bff = moduleBff({ documentContext: () => Effect.succeed(context) });
  const serverRequest = request('better-auth.session_token=test-session');
  return asServerRender(moduleModel(bff, { canonicalPath: '/contacts', request: serverRequest })).pipe(
    Effect.map((model) => ({ model, requests: bff.requests.map(({ body, endpoint }) => ({ body, endpoint })) })),
  );
};

it.effect('server rendering reads the page target in the one document read and keeps it only for that revision', () =>
  Effect.gen(function* serverTargetInDocument() {
    const resolved = yield* serverModel(signedInDocument({ state: 'resolved', target: approvedTarget }));
    expect(resolved.model).toMatchObject({ state: 'resolved', target: { moduleId: 'party.registry' } });
    // One request per document: no separate target read, no separate Shell read.
    expect(resolved.requests).toEqual([
      { body: { target: { canonicalPath: '/contacts' } }, endpoint: 'documentContext' },
    ]);

    const promoted = signedInDocument({
      state: 'resolved',
      target: { ...approvedTarget, compositionRevision: 'd'.repeat(64) },
    });
    expect((yield* serverModel(promoted)).model).toMatchObject({ state: 'reload_required' });
    const forbidden = signedInDocument({ problem: targetRefusals.ShellTargetForbiddenProblem, state: 'failed' });
    expect((yield* serverModel(forbidden)).model).toMatchObject({ state: 'forbidden' });
    const sessionEnded = signedInDocument({
      problem: { ...problem, _tag: 'ShellAuthenticationRequiredProblem', status: 401 },
      state: 'failed',
    });
    expect((yield* serverModel(sessionEnded)).model).toMatchObject({
      shell: { reason: 'session_ended' },
      state: 'selection_required',
    });
    const unselected = signedInDocument({ state: 'selection_required' });
    expect((yield* serverModel(unselected)).model).toMatchObject({ state: 'selection_required' });
    // An authenticated document that answered no target never shows a page.
    expect((yield* serverModel(signedInDocument())).model).toMatchObject({ state: 'unavailable' });
    const anonymous = yield* serverModel({ session: { state: 'anonymous' } });
    expect(anonymous.model).toMatchObject({ state: 'selection_required' });
    expect(anonymous.requests.map(({ endpoint }) => endpoint)).toEqual(['documentContext']);
  }),
);
