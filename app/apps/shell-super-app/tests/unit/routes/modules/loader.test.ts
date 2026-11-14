import { Cause, ConfigProvider, Deferred, Effect, Fiber, Schema } from 'effect';
import { beforeEach, expect, rstest, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import * as actualAuthClient from '../../../../src/api/auth-client.ts' with {
  rstest: 'importActual',
};
import { ResolvedModuleTargetSchema } from '../../../../shared/browser-api.ts';
import type { ShellDocumentTarget } from '../../../../shared/browser-api.ts';
import {
  BrowserModuleRevisionConflict,
  pinBrowserModuleTarget,
} from '../../../../src/routes/module-entrypoint-loader.ts';
import { loadModulePageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';

const { loadHomePageModelMock, loadServerModuleDocumentMock, resolveModuleTargetMock } = rstest.hoisted(() => ({
  loadHomePageModelMock: rstest.fn(),
  loadServerModuleDocumentMock: rstest.fn(),
  resolveModuleTargetMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
  resolveModuleTarget: resolveModuleTargetMock,
}));

rstest.mock('../../../../src/routes/[lang]/home-page-model.ts', () => ({
  loadHomePageModel: loadHomePageModelMock,
  loadServerModuleDocument: loadServerModuleDocumentMock,
  sessionEndedModel: { reason: 'session_ended', state: 'anonymous' },
}));

const authenticatedShell = {
  compositionRevision: 'c'.repeat(64),
  contextState: 'authenticated' as const,
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    legalEntityId: 'legal-1',
    legalName: 'Alpha company',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  legalEntities: { items: [], state: 'available' as const },
  navigation: { items: [], state: 'available' as const },
  selectedLegalEntityId: 'legal-1',
  state: 'authenticated' as const,
  tenants: { items: [], state: 'available' as const },
};

const request = () => {
  const value = new Request('https://shell.example.test/en/contacts');
  Object.defineProperty(value, 'headers', {
    value: new Headers({ cookie: 'session=test-session' }),
  });
  return value;
};

/** The module program reads its origin from config; pin an empty provider so every case is identical. */
const moduleModel = (input: Parameters<typeof loadModulePageModel>[0]) =>
  loadModulePageModel(input).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})));

const approvedTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
  appId: 'party-registry',
  componentKey: 'party.registry.page-contacts',
  compositionRevision: 'c'.repeat(64),
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

beforeEach(() => {
  loadHomePageModelMock.mockReturnValue(Effect.succeed(authenticatedShell));
  resolveModuleTargetMock.mockReturnValue(
    Effect.succeed({
      appId: 'party-registry',
      componentKey: 'party.registry.page-contacts',
      compositionRevision: 'c'.repeat(64),
      entrypointKey: 'party.registry.page.contacts',
      federation: {
        expose: './PageContacts',
        manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/party/release-a/mf-manifest.json' },
        remoteName: 'partyRegistryReleaseA',
      },
      moduleId: 'party.registry',
      routeParameters: {},
      writable: false,
    }),
  );
});

it.effect('retains only route parameters selected by the authenticated server target', () =>
  Effect.gen(function* retainsServerSelectedRouteParameters() {
    resolveModuleTargetMock.mockReturnValueOnce(
      Effect.succeed({ ...approvedTarget, routeParameters: { id: 'party-1' } }),
    );
    expect(
      yield* moduleModel({
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
    expect(resolveModuleTargetMock).toHaveBeenCalledWith(
      { canonicalPath: '/contacts/party-1', compositionRevision: 'c'.repeat(64) },
      expect.any(Object),
    );
  }),
);

it.effect('retains module landing behavior when no exact page entrypoint is supplied', () =>
  Effect.gen(function* retainsModuleLandingBehaviorWhenNo() {
    expect(
      yield* moduleModel({
        params: { moduleId: 'party.registry' },
        request: request(),
      }),
    ).toMatchObject({ routeParams: {} });
    expect(resolveModuleTargetMock).toHaveBeenCalledWith(
      { compositionRevision: 'c'.repeat(64), moduleId: 'party.registry' },
      expect.any(Object),
    );
  }),
);

it.effect('does not request or load a private target before authentication', () =>
  Effect.gen(function* doesNotRequestOrLoadA() {
    loadHomePageModelMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' }));
    expect(
      yield* moduleModel({
        params: {
          entrypointKey: 'party.registry.page.contacts',
          moduleId: 'party.registry',
        },
        request: request(),
      }),
    ).toMatchObject({ state: 'selection_required' });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
  }),
);

it.effect.each([
  ['ShellSelectionRequiredProblem', 'selection_required'],
  ['ShellTargetForbiddenProblem', 'forbidden'],
  ['ShellTargetNotFoundProblem', 'not_found'],
  ['ShellCapabilityUnavailableProblem', 'unavailable'],
] as const)('maps %s without returning a resolved private target', ([_tag, state]) =>
  Effect.gen(function* ShellSelectionRequiredProblem() {
    resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag }));
    expect(
      yield* moduleModel({
        params: {
          entrypointKey: 'party.registry.page.contacts',
          moduleId: 'party.registry',
        },
        request: request(),
      }),
    ).toMatchObject({ state });
  }),
);

it.effect('fails with the typed timeout instead of hanging on an unresponsive shell read', () =>
  Effect.gen(function* failsWithTheTypedTimeout() {
    const entered = yield* Deferred.make<'entered'>();
    loadHomePageModelMock.mockReturnValueOnce(Effect.andThen(Deferred.succeed(entered, 'entered'), Effect.never));
    const fiber = yield* Effect.forkChild(
      moduleModel({
        params: { moduleId: 'party.registry' },
        request: request(),
      }),
    );
    yield* Deferred.await(entered);

    yield* TestClock.adjust('30 seconds');

    expect(yield* Effect.flip(Fiber.join(fiber))).toBeInstanceOf(Cause.TimeoutError);
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
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
const asServerRender = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
      Reflect.deleteProperty(globalThis, 'document');
      return descriptor;
    }),
    () => operation,
    (descriptor) =>
      Effect.sync(() => {
        if (descriptor !== undefined) {
          Object.defineProperty(globalThis, 'document', descriptor);
        }
      }),
  );

/** The server document of the next case: its Shell model and, when it read one, the page target. */
const serverDocument = (target?: ShellDocumentTarget) =>
  loadServerModuleDocumentMock.mockReturnValueOnce(
    Effect.succeed(target === undefined ? { shell: authenticatedShell } : { shell: authenticatedShell, target }),
  );
const serverModel = () => asServerRender(moduleModel({ canonicalPath: '/contacts', request: request() }));

it.effect('server rendering reads the page target in the one document read and keeps it only for that revision', () =>
  Effect.gen(function* serverTargetInDocument() {
    serverDocument({ state: 'resolved', target: approvedTarget });
    expect(yield* serverModel()).toMatchObject({ state: 'resolved', target: { moduleId: 'party.registry' } });
    expect(loadServerModuleDocumentMock).toHaveBeenCalledWith(expect.any(Request), { canonicalPath: '/contacts' });
    // One request per document: no separate target read, no separate Shell read.
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
    expect(loadHomePageModelMock).not.toHaveBeenCalled();

    serverDocument({ state: 'resolved', target: { ...approvedTarget, compositionRevision: 'd'.repeat(64) } });
    expect(yield* serverModel()).toMatchObject({ state: 'reload_required' });
    serverDocument({
      problem: { _tag: 'ShellTargetForbiddenProblem', detail: 'd', status: 403, title: 't', type: 'x' },
      state: 'failed',
    });
    expect(yield* serverModel()).toMatchObject({ state: 'forbidden' });
    serverDocument({
      problem: { _tag: 'ShellAuthenticationRequiredProblem', detail: 'd', status: 401, title: 't', type: 'x' },
      state: 'failed',
    });
    expect(yield* serverModel()).toMatchObject({ shell: { reason: 'session_ended' }, state: 'selection_required' });
    serverDocument({ state: 'selection_required' });
    expect(yield* serverModel()).toMatchObject({ state: 'selection_required' });
    // An authenticated document that answered no target never shows a page.
    serverDocument();
    expect(yield* serverModel()).toMatchObject({ state: 'unavailable' });
    loadServerModuleDocumentMock.mockReturnValueOnce(Effect.succeed({ shell: { state: 'anonymous' } }));
    expect(yield* serverModel()).toMatchObject({ state: 'selection_required' });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
  }),
);
