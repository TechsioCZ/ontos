// @rstest-environment happy-dom
import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { networkIdle, networkQuietExcept } from '@app/shared-contracts/testing/http-double';
import { beforeEach, expect, it } from 'effect-rstest';

import {
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  CurrentSessionSchema,
  ResolvedModuleTargetSchema,
  ShellAuthenticationRequiredProblemSchema,
  ShellCapabilityUnavailableProblemSchema,
  ShellTargetForbiddenProblemSchema,
  TenantAuthenticationRequiredProblemSchema,
} from '../../../../shared/browser-api.ts';
import { resetBrowserSessionCache } from '../../../../src/routes/[lang]/home-page-model.ts';
import { loader, loadModulePageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffEndpoint, ShellBffScript } from '../../../support/shell-bff-double.ts';

const revision = 'a'.repeat(64);
const identity = {
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  legalEntityId: '11111111-1111-4111-8111-111111111111',
  legalName: 'Alpha company',
  principalId: 'principal-1',
  tenantId: '22222222-2222-4222-8222-222222222222',
};
const session = Schema.decodeUnknownSync(CurrentSessionSchema)({ identity, state: 'authenticated' });
const composition = {
  compositionRevision: revision,
  deniedAppIds: [],
  gatewayAudiences: [],
  homeComponents: [],
  navigation: [],
  state: 'available' as const,
  unavailableDeployments: [],
};
const companies = Schema.decodeUnknownSync(AvailableLegalEntitiesResponseSchema)({
  legalEntities: [{ legalEntityId: '11111111-1111-4111-8111-111111111111', legalName: 'Alpha company' }],
  selectedLegalEntityId: '11111111-1111-4111-8111-111111111111',
  state: 'authenticated' as const,
  tenantContextAvailable: true,
});
const tenants = Schema.decodeUnknownSync(AvailableTenantsResponseSchema)({
  tenants: [{ name: 'Alpha tenant', tenantId: '22222222-2222-4222-8222-222222222222' }],
});
const target = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
  appId: 'party-registry',
  componentKey: 'party.registry.page-contacts',
  compositionRevision: revision,
  entrypointKey: 'party.registry.page.contacts',
  federation: {
    expose: './PageContacts',
    manifest: { sha256: 'b'.repeat(64), url: 'https://assets.example.test/party/release-a/mf-manifest.json' },
    remoteName: 'partyRegistryReleaseA',
  },
  moduleId: 'party.registry',
  routeParameters: {},
  writable: false,
});

let sequence = 0;
let origin: string;
const request = () => new Request(`${origin}/en/contacts`);
const load = (input = request()) =>
  loadModulePageModel({ canonicalPath: '/contacts', request: input }).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
  );

beforeEach(() => {
  sequence += 1;
  origin = `https://ordering-${sequence}.example.test`;
});

const moduleBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    availableLegalEntities: () => Effect.succeed(companies),
    availableTenants: () => Effect.succeed(tenants),
    currentSession: () => Effect.succeed(session),
    demoAccountCapability: () => Effect.succeed({ canManage: false }),
    resolveModuleTarget: () => Effect.succeed(target),
    shellComposition: () => Effect.succeed(composition),
    ...overrides,
  });
const endpoints = [
  'currentSession',
  'shellComposition',
  'demoAccountCapability',
  'availableLegalEntities',
  'availableTenants',
  'resolveModuleTarget',
] satisfies ShellBffEndpoint[];
const reads = (bff: ReturnType<typeof moduleBff>, endpoint: ShellBffEndpoint) =>
  bff.requests.filter((received) => received.endpoint === endpoint);

const gate = <Value, Failure>(answer: Effect.Effect<Value, Failure>) =>
  Effect.gen(function* deferredTransport() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const interrupted = yield* Deferred.make<boolean>();
    return {
      interrupted: Deferred.await(interrupted),
      read: Deferred.succeed(started, true).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(answer),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, true)),
      ),
      release: Deferred.succeed(release, true),
      started: Deferred.await(started),
    };
  });

const problemFields = { detail: 'Fixture failure', title: 'Fixture failure', type: 'about:blank' };
const compositionUnavailable = Schema.decodeUnknownSync(ShellCapabilityUnavailableProblemSchema)({
  ...problemFields,
  _tag: 'ShellCapabilityUnavailableProblem',
  retryable: true,
  status: 503,
});
const authenticationRequired = Schema.decodeUnknownSync(ShellAuthenticationRequiredProblemSchema)({
  ...problemFields,
  _tag: 'ShellAuthenticationRequiredProblem',
  status: 401,
});
const targetForbidden = Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)({
  ...problemFields,
  _tag: 'ShellTargetForbiddenProblem',
  status: 403,
});
const tenantAuthenticationRequired = Schema.decodeUnknownSync(TenantAuthenticationRequiredProblemSchema)({
  ...problemFields,
  _tag: 'TenantAuthenticationRequiredProblem',
  status: 401,
});

type BrowserRequest = Parameters<
  NonNullable<Window['happyDOM']['settings']['fetch']['interceptor']>['beforeAsyncRequest']
>[0];

const forwardBrowserRequest =
  (send: typeof fetch) =>
  ({ request: incoming, window: browser }: BrowserRequest) =>
    Effect.gen(function* forwardRequest() {
      const body =
        incoming.method === 'GET' || incoming.method === 'HEAD'
          ? null
          : yield* Effect.promise(() => incoming.arrayBuffer());
      const response = yield* Effect.promise(() =>
        send(incoming.url, {
          body,
          headers: [...incoming.headers],
          method: incoming.method,
          signal: incoming.signal,
        }),
      );
      const bytes = yield* Effect.promise(() => response.arrayBuffer());
      return new browser.Response(bytes, {
        headers: [...response.headers],
        status: response.status,
        statusText: response.statusText,
      });
    });

// The shared browser transport omits Request.signal when forwarding. Preserve the real
// browser signal here so this router-boundary case can observe server-side interruption.
const abortableBrowserNetwork = (bff: ReturnType<typeof moduleBff>) =>
  Layer.effectDiscard(
    Effect.gen(function* interceptAbortableBrowserRequests() {
      const send = yield* FetchHttpClient.Fetch;
      const run = yield* FiberSet.makeRuntimePromise();
      const forward = forwardBrowserRequest(send);
      const { fetch: network } = window.happyDOM.settings;
      const previous = network.interceptor;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          network.interceptor = { beforeAsyncRequest: (incoming) => run(forward(incoming)) };
        }),
        () =>
          Effect.sync(() => {
            network.interceptor = previous;
          }),
      );
    }),
  ).pipe(Layer.provide(bff.layer));

const coldDocument = resetBrowserSessionCache.pipe(Effect.andThen(pinDocumentCompositionRevision(revision)));

// These two document states must precede the first successful composition: a real document's pin is immutable.
it.live('rejects an invalid document revision without any target or composition read', () => {
  const bff = moduleBff();
  return Effect.gen(function* invalidRevision() {
    yield* resetBrowserSessionCache;
    const meta = document.createElement('meta');
    meta.name = 'ontos-composition-revision';
    meta.content = 'invalid';
    document.head.append(meta);
    yield* Effect.gen(function* rejectInvalidRevision() {
      expect(yield* load()).toMatchObject({ state: 'reload_required' });
      yield* networkIdle;
      expect(reads(bff, 'resolveModuleTarget')).toHaveLength(0);
      expect(reads(bff, 'shellComposition')).toHaveLength(0);
    }).pipe(Effect.ensuring(Effect.sync(() => meta.remove())));
  }).pipe(Effect.provide(bff.layer));
});

it.live('waits for a valid composition revision when the document has no revision', () =>
  Effect.gen(function* missingRevision() {
    yield* resetBrowserSessionCache;
    const composed = yield* gate(Effect.succeed(composition));
    const bff = moduleBff({ shellComposition: () => composed.read });
    yield* Effect.gen(function* waitForRevision() {
      const fiber = yield* Effect.forkChild(load());
      yield* composed.started;
      // Only the held composition read stays open: a target read sent too early has arrived by now.
      yield* networkQuietExcept(1);
      expect(reads(bff, 'resolveModuleTarget')).toHaveLength(0);
      yield* composed.release;
      expect(yield* Fiber.join(fiber)).toMatchObject({ state: 'resolved' });
      expect(reads(bff, 'resolveModuleTarget')[0]?.body).toEqual({
        canonicalPath: '/contacts',
        compositionRevision: revision,
      });
    }).pipe(Effect.provide(bff.layer));
  }),
);

it.live('starts all independent reads and target after identity, before composition or company lists finish', () =>
  Effect.gen(function* deferredStartOrder() {
    yield* coldDocument;
    const auth = yield* gate(Effect.succeed(session));
    const composed = yield* gate(Effect.succeed(composition));
    const people = yield* gate(Effect.succeed({ canManage: false }));
    const legal = yield* gate(Effect.succeed(companies));
    const tenant = yield* gate(Effect.succeed(tenants));
    const resolved = yield* gate(Effect.succeed(target));
    const bff = moduleBff({
      availableLegalEntities: () => legal.read,
      availableTenants: () => tenant.read,
      currentSession: () => auth.read,
      demoAccountCapability: () => people.read,
      resolveModuleTarget: () => resolved.read,
      shellComposition: () => composed.read,
    });
    yield* Effect.gen(function* startReadsAfterIdentity() {
      const fiber = yield* Effect.forkChild(load());
      yield* auth.started;
      // Only the held identity read stays open: a read started before identity has arrived by now.
      yield* networkQuietExcept(1);
      for (const endpoint of endpoints.filter((candidate) => candidate !== 'currentSession')) {
        expect(reads(bff, endpoint)).toHaveLength(0);
      }
      yield* auth.release;
      yield* Effect.all([composed.started, people.started, legal.started, tenant.started, resolved.started]);
      yield* resolved.release;
      yield* Effect.all([composed.release, people.release, legal.release, tenant.release]);
      expect(yield* Fiber.join(fiber)).toMatchObject({ state: 'resolved', target });
      yield* networkIdle;
      for (const endpoint of endpoints) {
        expect(reads(bff, endpoint)).toHaveLength(1);
      }
      const [received] = reads(bff, 'resolveModuleTarget');
      expect(received?.body).toEqual({ canonicalPath: '/contacts', compositionRevision: revision });
      expect(new URL(received?.url ?? '', origin).origin).toBe(origin);
      expect(new URL(received?.url ?? '', origin).pathname).toBe('/shell-super-app-api/shell/module-target');
      yield* load();
      yield* networkIdle;
      for (const endpoint of endpoints) {
        expect(reads(bff, endpoint)).toHaveLength(1);
      }
    }).pipe(Effect.provide(bff.layer));
  }),
);

it.live('retains composition failure precedence during overlap and does not cache the failure', () =>
  Effect.gen(function* failedComposition() {
    yield* coldDocument;
    const composed = yield* gate(Effect.fail(compositionUnavailable));
    const resolved = yield* gate(Effect.succeed(target));
    let compositionReads = 0;
    let targetReads = 0;
    const bff = moduleBff({
      resolveModuleTarget: () => {
        targetReads += 1;
        return targetReads === 1 ? resolved.read : Effect.succeed(target);
      },
      shellComposition: () => {
        compositionReads += 1;
        return compositionReads === 1 ? composed.read : Effect.succeed(composition);
      },
    });
    yield* Effect.gen(function* compositionFailurePrecedence() {
      const fiber = yield* Effect.forkChild(load());
      yield* Effect.all([composed.started, resolved.started]);
      yield* composed.release;
      expect(yield* Fiber.join(fiber)).toMatchObject({ shell: { state: 'unavailable' }, state: 'unavailable' });
      yield* resolved.interrupted;
      yield* networkIdle;
      for (const endpoint of endpoints) {
        expect(reads(bff, endpoint)).toHaveLength(1);
      }
      expect(yield* load()).toMatchObject({ state: 'resolved' });
      yield* networkIdle;
      expect(reads(bff, 'shellComposition')).toHaveLength(2);
      expect(reads(bff, 'resolveModuleTarget')).toHaveLength(2);
    }).pipe(Effect.provide(bff.layer));
  }),
);

it.live.each(['target', 'composition'] as const)('requires reload on an overlapping %s revision mismatch', (source) => {
  const bff = moduleBff(
    source === 'target'
      ? {
          resolveModuleTarget: () => Effect.succeed({ ...target, compositionRevision: 'c'.repeat(64) }),
        }
      : {
          shellComposition: () => Effect.succeed({ ...composition, compositionRevision: 'c'.repeat(64) }),
        },
  );
  return Effect.gen(function* revisionMismatch() {
    yield* coldDocument;
    expect(yield* load()).toMatchObject({ state: 'reload_required' });
  }).pipe(Effect.provide(bff.layer));
});

it.live('does not cache denied targets or infer their authority from navigation', () => {
  const bff = moduleBff({ resolveModuleTarget: () => Effect.fail(targetForbidden) });
  return Effect.gen(function* deniedTarget() {
    yield* coldDocument;
    expect(yield* load()).toMatchObject({ state: 'forbidden' });
    expect(yield* load()).toMatchObject({ state: 'forbidden' });
    yield* networkIdle;
    expect(reads(bff, 'resolveModuleTarget')).toHaveLength(2);
    expect(reads(bff, 'shellComposition')).toHaveLength(1);
  }).pipe(Effect.provide(bff.layer));
});

it.live.each(['tenant', 'target', 'composition'] as const)(
  'discards overlapping data when the %s read ends the session',
  (source) =>
    Effect.gen(function* sessionEndsDuringOverlap() {
      yield* coldDocument;
      const composed = yield* gate(
        source === 'composition' ? Effect.fail(authenticationRequired) : Effect.succeed(composition),
      );
      const resolved = yield* gate(source === 'target' ? Effect.fail(authenticationRequired) : Effect.succeed(target));
      const bff = moduleBff({
        availableTenants: () =>
          source === 'tenant' ? Effect.fail(tenantAuthenticationRequired) : Effect.succeed(tenants),
        resolveModuleTarget: () => resolved.read,
        shellComposition: () => composed.read,
      });
      yield* Effect.gen(function* discardSessionReads() {
        const fiber = yield* Effect.forkChild(load());
        yield* Effect.all([composed.started, resolved.started]);
        yield* Effect.all([resolved.release, composed.release]);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          shell: { reason: 'session_ended', state: 'anonymous' },
          state: 'selection_required',
        });
      }).pipe(Effect.provide(bff.layer));
    }),
);

it.live.each(['anonymous', 'selection_required', 'tenant_authenticated'] as const)(
  'does not issue restricted reads for %s, while keeping companyless choices',
  (state) => {
    const { legalEntityId, legalName, ...tenantIdentity } = identity;
    void legalEntityId;
    void legalName;
    const companylessSession = Schema.decodeUnknownSync(CurrentSessionSchema)(
      state === 'anonymous'
        ? { state }
        : { availableLegalEntities: companies.legalEntities, identity: tenantIdentity, state },
    );
    const bff = moduleBff({
      currentSession: () => Effect.succeed(companylessSession),
      documentContext: () => Effect.succeed({ session: companylessSession }),
    });
    return Effect.gen(function* companySelectionGate() {
      yield* coldDocument;
      const model = yield* load();
      expect(model.state).toBe('selection_required');
      yield* networkIdle;
      expect(reads(bff, 'resolveModuleTarget')).toHaveLength(0);
      expect(reads(bff, 'shellComposition')).toHaveLength(0);
      expect(reads(bff, 'demoAccountCapability')).toHaveLength(0);
      if (state !== 'anonymous') {
        expect(model.shell).toMatchObject({
          contextState: state,
          legalEntities: { items: companies.legalEntities },
          navigation: { items: [] },
          state: 'authenticated',
        });
        expect(model.shell).not.toHaveProperty('selectedLegalEntityId');
      }
    }).pipe(Effect.provide(bff.layer));
  },
);

it.live('interrupts every pending transport when the caller fiber is interrupted', () =>
  Effect.gen(function* callerInterruption() {
    yield* coldDocument;
    const composed = yield* gate(Effect.succeed(composition));
    const people = yield* gate(Effect.succeed({ canManage: false }));
    const legal = yield* gate(Effect.succeed(companies));
    const tenant = yield* gate(Effect.succeed(tenants));
    const resolved = yield* gate(Effect.succeed(target));
    const bff = moduleBff({
      availableLegalEntities: () => legal.read,
      availableTenants: () => tenant.read,
      demoAccountCapability: () => people.read,
      resolveModuleTarget: () => resolved.read,
      shellComposition: () => composed.read,
    });
    yield* Effect.gen(function* interruptAllReads() {
      const fiber = yield* Effect.forkChild(load());
      const pending = [composed, people, legal, tenant, resolved];
      yield* Effect.all(pending.map((read) => read.started));
      yield* Fiber.interrupt(fiber);
      yield* Effect.all(pending.map((read) => read.interrupted));
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    }).pipe(Effect.provide(bff.layer));
  }),
);

it.live('interrupts pending browser transports through the router Request.signal boundary', () =>
  Effect.gen(function* requestSignalInterruption() {
    yield* coldDocument;
    const composed = yield* gate(Effect.succeed(composition));
    const resolved = yield* gate(Effect.succeed(target));
    const bff = moduleBff({
      resolveModuleTarget: () => resolved.read,
      shellComposition: () => composed.read,
    });
    yield* Effect.gen(function* abortRouterRequest() {
      const controller = new AbortController();
      const input = new Request(`${origin}/en/contacts`, { signal: controller.signal });
      const fiber = yield* Effect.forkChild(
        Effect.tryPromise(() => loader({ canonicalPath: '/contacts', request: input })).pipe(Effect.exit),
      );
      yield* Effect.all([composed.started, resolved.started]);
      controller.abort();
      expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
      yield* Effect.all([composed.interrupted, resolved.interrupted]);
    }).pipe(Effect.provide(abortableBrowserNetwork(bff)));
  }),
);
