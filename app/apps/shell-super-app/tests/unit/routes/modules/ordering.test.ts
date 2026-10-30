import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Cause, Clock, ConfigProvider, Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  documentContext,
  executeLegalEntityDetail,
  issueDocumentGatewayContexts,
} from '../../../../src/api/auth-client.ts' with { rstest: 'importActual' };
import type {
  availableLegalEntities,
  availableTenants,
  canManageDemoAccounts,
  currentSession,
  resolveModuleTarget,
  shellComposition,
} from '../../../../src/api/auth-client.ts';
import {
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  CurrentSessionSchema,
  ResolvedModuleTargetSchema,
  ShellAuthenticationRequiredProblemSchema,
  ShellCapabilityUnavailableProblemSchema,
  ShellTargetForbiddenProblemSchema,
  TenantAuthenticationRequiredProblemSchema,
} from '../../../../shared/api.ts';
import { resetBrowserSessionCache } from '../../../../src/routes/[lang]/home-page-model.ts';
import { loader, loadModulePageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';

const mocks = rstest.hoisted(() => ({
  availableLegalEntities: rstest.fn<typeof availableLegalEntities>(),
  availableTenants: rstest.fn<typeof availableTenants>(),
  canManageDemoAccounts: rstest.fn<typeof canManageDemoAccounts>(),
  currentSession: rstest.fn<typeof currentSession>(),
  resolveModuleTarget: rstest.fn<typeof resolveModuleTarget>(),
  shellComposition: rstest.fn<typeof shellComposition>(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  documentContext,
  executeLegalEntityDetail,
  issueDocumentGatewayContexts,
  ...mocks,
}));

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
let originalDocument: PropertyDescriptor | undefined;
let origin: string;
const request = () => new Request(`${origin}/en/contacts`);
const load = (input = request()) =>
  loadModulePageModel({ canonicalPath: '/contacts', request: input }).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
  );

beforeEach(() => {
  sequence += 1;
  // A new origin also makes the native immutable target cache cold without exposing a new reset API.
  origin = `https://ordering-${sequence}.example.test`;
  originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document.implementation.createHTMLDocument(),
  });
  mocks.currentSession.mockReturnValue(Effect.succeed(session));
  mocks.shellComposition.mockReturnValue(Effect.succeed(composition));
  mocks.canManageDemoAccounts.mockReturnValue(Effect.succeed(false));
  mocks.availableLegalEntities.mockReturnValue(Effect.succeed(companies));
  mocks.availableTenants.mockReturnValue(Effect.succeed(tenants));
  mocks.resolveModuleTarget.mockReturnValue(Effect.succeed(target));
});

afterEach(() => {
  if (originalDocument !== undefined) {
    Object.defineProperty(globalThis, 'document', originalDocument);
  }
});

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

const elapsed = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
  Effect.gen(function* measureVirtualElapsed() {
    const start = yield* Clock.currentTimeMillis;
    yield* operation;
    return (yield* Clock.currentTimeMillis) - start;
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

const coldDocument = resetBrowserSessionCache.pipe(Effect.andThen(pinDocumentCompositionRevision(revision)));

it.effect('starts all independent reads and target after identity, before composition or company lists finish', () =>
  Effect.gen(function* deferredStartOrder() {
    yield* coldDocument;
    const auth = yield* gate(Effect.succeed(session));
    const composed = yield* gate(Effect.succeed(composition));
    const people = yield* gate(Effect.succeed(false));
    const legal = yield* gate(Effect.succeed(companies));
    const tenant = yield* gate(Effect.succeed(tenants));
    const resolved = yield* gate(Effect.succeed(target));
    mocks.currentSession.mockReturnValue(auth.read);
    mocks.shellComposition.mockReturnValue(composed.read);
    mocks.canManageDemoAccounts.mockReturnValue(people.read);
    mocks.availableLegalEntities.mockReturnValue(legal.read);
    mocks.availableTenants.mockReturnValue(tenant.read);
    mocks.resolveModuleTarget.mockReturnValue(resolved.read);
    const fiber = yield* Effect.forkChild(load());
    yield* auth.started;
    for (const read of Object.values(mocks).filter((mock) => mock !== mocks.currentSession)) {
      expect(read).not.toHaveBeenCalled();
    }
    yield* auth.release;
    yield* Effect.all([composed.started, people.started, legal.started, tenant.started, resolved.started]);
    // The target may finish while Shell reads are still pending, but cannot reveal a page on its own.
    yield* resolved.release;
    yield* Effect.all([composed.release, people.release, legal.release, tenant.release]);
    expect(yield* Fiber.join(fiber)).toMatchObject({ state: 'resolved', target });
    for (const read of Object.values(mocks)) {
      expect(read).toHaveBeenCalledTimes(1);
    }
    expect(mocks.resolveModuleTarget).toHaveBeenCalledWith(
      { canonicalPath: '/contacts', compositionRevision: revision },
      { baseUrl: new URL(`${origin}/shell-super-app-api`) },
    );
    yield* load();
    for (const read of Object.values(mocks)) {
      expect(read).toHaveBeenCalledTimes(1);
    }
  }),
);

it.effect(
  'reduces the local cold critical path from 1500 to 600 virtual ms with identical successful request keys',
  () =>
    Effect.gen(function* deterministicCriticalPath() {
      yield* coldDocument;
      mocks.currentSession.mockReturnValue(Effect.delay(Effect.succeed(session), '100 millis'));
      mocks.shellComposition.mockReturnValue(Effect.delay(Effect.succeed(composition), '400 millis'));
      mocks.canManageDemoAccounts.mockReturnValue(Effect.delay(Effect.succeed(false), '300 millis'));
      mocks.availableLegalEntities.mockReturnValue(Effect.delay(Effect.succeed(companies), '200 millis'));
      mocks.availableTenants.mockReturnValue(Effect.delay(Effect.succeed(tenants), '150 millis'));
      mocks.resolveModuleTarget.mockReturnValue(Effect.delay(Effect.succeed(target), '500 millis'));
      const options = { baseUrl: new URL(`${origin}/shell-super-app-api`) };
      // Local control reproduces the replaced successful dependency chain, not a live performance claim.
      const serial = Effect.gen(function* serialControl() {
        yield* mocks.currentSession(options);
        yield* mocks.shellComposition({ compositionRevision: revision }, options);
        yield* mocks.canManageDemoAccounts(options);
        yield* Effect.all([mocks.availableLegalEntities(options), mocks.availableTenants(options)], { concurrency: 2 });
        return yield* mocks.resolveModuleTarget({ canonicalPath: '/contacts', compositionRevision: revision }, options);
      });
      const control = yield* Effect.forkChild(elapsed(serial));
      yield* TestClock.adjust('1500 millis');
      expect(yield* Fiber.join(control)).toBe(1500);
      const keys = Object.values(mocks).map((mock) => [...mock.mock.calls]);
      for (const mock of Object.values(mocks)) {
        mock.mockClear();
      }
      const candidate = yield* Effect.forkChild(elapsed(load()));
      yield* TestClock.adjust('600 millis');
      expect(yield* Fiber.join(candidate)).toBe(600);
      expect(Object.values(mocks).map((mock) => [...mock.mock.calls])).toEqual(keys);
    }),
);

it.effect('retains composition failure precedence during overlap and does not cache the failure', () =>
  Effect.gen(function* failedComposition() {
    yield* coldDocument;
    const composed = yield* gate(Effect.fail(compositionUnavailable));
    const resolved = yield* gate(Effect.succeed(target));
    mocks.shellComposition.mockReturnValueOnce(composed.read);
    mocks.resolveModuleTarget.mockReturnValueOnce(resolved.read);
    const fiber = yield* Effect.forkChild(load());
    yield* Effect.all([composed.started, resolved.started]);
    yield* composed.release;
    expect(yield* Fiber.join(fiber)).toMatchObject({ shell: { state: 'unavailable' }, state: 'unavailable' });
    yield* resolved.interrupted;
    // One speculative target, capability, company list and tenant list may start on a failing composition.
    for (const read of Object.values(mocks)) {
      expect(read).toHaveBeenCalledTimes(1);
    }
    expect(yield* load()).toMatchObject({ state: 'resolved' });
    expect(mocks.shellComposition).toHaveBeenCalledTimes(2);
    expect(mocks.resolveModuleTarget).toHaveBeenCalledTimes(2);
  }),
);

it.effect('waits for a valid composition revision when the document has no revision', () =>
  Effect.gen(function* missingRevision() {
    yield* resetBrowserSessionCache;
    const composed = yield* gate(Effect.succeed(composition));
    mocks.shellComposition.mockReturnValueOnce(composed.read);
    const fiber = yield* Effect.forkChild(load());
    yield* composed.started;
    expect(mocks.resolveModuleTarget).not.toHaveBeenCalled();
    yield* composed.release;
    expect(yield* Fiber.join(fiber)).toMatchObject({ state: 'resolved' });
    expect(mocks.resolveModuleTarget.mock.calls[0]?.[0]).toEqual({
      canonicalPath: '/contacts',
      compositionRevision: revision,
    });
  }),
);

it.effect('rejects an invalid document revision without any target or composition read', () =>
  Effect.gen(function* invalidRevision() {
    yield* resetBrowserSessionCache;
    const meta = document.createElement('meta');
    meta.name = 'ontos-composition-revision';
    meta.content = 'invalid';
    document.head.append(meta);
    expect(yield* load()).toMatchObject({ state: 'reload_required' });
    expect(mocks.resolveModuleTarget).not.toHaveBeenCalled();
    expect(mocks.shellComposition).not.toHaveBeenCalled();
  }),
);

it.effect.each(['target', 'composition'] as const)('requires reload on an overlapping %s revision mismatch', (source) =>
  Effect.gen(function* revisionMismatch() {
    yield* coldDocument;
    if (source === 'target') {
      mocks.resolveModuleTarget.mockReturnValueOnce(Effect.succeed({ ...target, compositionRevision: 'c'.repeat(64) }));
    } else {
      mocks.shellComposition.mockReturnValueOnce(
        Effect.succeed({ ...composition, compositionRevision: 'c'.repeat(64) }),
      );
    }
    expect(yield* load()).toMatchObject({ state: 'reload_required' });
  }),
);

it.effect('does not cache denied targets or infer their authority from navigation', () =>
  Effect.gen(function* deniedTarget() {
    yield* coldDocument;
    mocks.resolveModuleTarget.mockReturnValue(Effect.fail(targetForbidden));
    expect(yield* load()).toMatchObject({ state: 'forbidden' });
    expect(yield* load()).toMatchObject({ state: 'forbidden' });
    expect(mocks.resolveModuleTarget).toHaveBeenCalledTimes(2);
    expect(mocks.shellComposition).toHaveBeenCalledTimes(1);
  }),
);

it.effect.each(['tenant', 'target', 'composition'] as const)(
  'discards overlapping data when the %s read ends the session',
  (source) =>
    Effect.gen(function* sessionEndsDuringOverlap() {
      yield* coldDocument;
      const composed = yield* gate(
        source === 'composition' ? Effect.fail(authenticationRequired) : Effect.succeed(composition),
      );
      const resolved = yield* gate(source === 'target' ? Effect.fail(authenticationRequired) : Effect.succeed(target));
      mocks.shellComposition.mockReturnValueOnce(composed.read);
      mocks.resolveModuleTarget.mockReturnValueOnce(resolved.read);
      if (source === 'tenant') {
        mocks.availableTenants.mockReturnValueOnce(Effect.fail(tenantAuthenticationRequired));
      }
      const fiber = yield* Effect.forkChild(load());
      yield* Effect.all([composed.started, resolved.started]);
      yield* Effect.all([resolved.release, composed.release]);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        shell: { reason: 'session_ended', state: 'anonymous' },
        state: 'selection_required',
      });
    }),
);

it.effect.each(['anonymous', 'selection_required', 'tenant_authenticated'] as const)(
  'does not issue restricted reads for %s, while keeping companyless choices',
  (state) =>
    Effect.gen(function* companySelectionGate() {
      yield* coldDocument;
      const { legalEntityId, legalName, ...tenantIdentity } = identity;
      void legalEntityId;
      void legalName;
      mocks.currentSession.mockReturnValueOnce(
        Effect.succeed(
          Schema.decodeUnknownSync(CurrentSessionSchema)(
            state === 'anonymous'
              ? { state }
              : { availableLegalEntities: companies.legalEntities, identity: tenantIdentity, state },
          ),
        ),
      );
      const model = yield* load();
      expect(model.state).toBe('selection_required');
      expect(mocks.resolveModuleTarget).not.toHaveBeenCalled();
      expect(mocks.shellComposition).not.toHaveBeenCalled();
      expect(mocks.canManageDemoAccounts).not.toHaveBeenCalled();
      if (state !== 'anonymous') {
        expect(model.shell).toMatchObject({
          contextState: state,
          legalEntities: { items: companies.legalEntities },
          navigation: { items: [] },
          state: 'authenticated',
        });
        expect(model.shell).not.toHaveProperty('selectedLegalEntityId');
      }
    }),
);

it.effect('interrupts every pending transport when the caller fiber is interrupted', () =>
  Effect.gen(function* callerInterruption() {
    yield* coldDocument;
    const composed = yield* gate(Effect.succeed(composition));
    const people = yield* gate(Effect.succeed(false));
    const legal = yield* gate(Effect.succeed(companies));
    const tenant = yield* gate(Effect.succeed(tenants));
    const resolved = yield* gate(Effect.succeed(target));
    mocks.shellComposition.mockReturnValueOnce(composed.read);
    mocks.canManageDemoAccounts.mockReturnValueOnce(people.read);
    mocks.availableLegalEntities.mockReturnValueOnce(legal.read);
    mocks.availableTenants.mockReturnValueOnce(tenant.read);
    mocks.resolveModuleTarget.mockReturnValueOnce(resolved.read);
    const fiber = yield* Effect.forkChild(load());
    const reads = [composed, people, legal, tenant, resolved];
    yield* Effect.all(reads.map((read) => read.started));
    yield* Fiber.interrupt(fiber);
    yield* Effect.all(reads.map((read) => read.interrupted));
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  }),
);

it.effect('interrupts pending browser transports through the router Request.signal boundary', () =>
  Effect.gen(function* requestSignalInterruption() {
    yield* coldDocument;
    const composed = yield* gate(Effect.succeed(composition));
    const resolved = yield* gate(Effect.succeed(target));
    mocks.shellComposition.mockReturnValueOnce(composed.read);
    mocks.resolveModuleTarget.mockReturnValueOnce(resolved.read);
    const controller = new AbortController();
    const input = new Request(`${origin}/en/contacts`, { signal: controller.signal });
    const fiber = yield* Effect.forkChild(
      Effect.tryPromise(() => loader({ canonicalPath: '/contacts', request: input })).pipe(Effect.exit),
    );
    yield* Effect.all([composed.started, resolved.started]);
    controller.abort();
    expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
    yield* Effect.all([composed.interrupted, resolved.interrupted]);
  }),
);
