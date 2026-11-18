import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadLoadContext } from '../../src/reads/context.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { getReadHandler, getReadServiceFactory, makeReadTestHarness } from '../../src/testing/reads.ts';

// A read here has one step, its handler, written bare or as `{ load: handler }`. A staged read adds
// `prepare` and `finish` to the same plain object; nothing else may sit on it.
const loadFormDescriptor = (readKey: string) => ({
  accessDeclaration: {
    key: `${readKey}.read`,
    kind: 'read' as const,
    modes: ['run' as const],
    placement: { group: 'inventory', level: 'basic' as const },
    risk: 'routine' as const,
    selectors: [],
  },
  accessKind: 'detail' as const,
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: readKey,
    moduleKey: 'test.read-load',
    role: 'api',
  }),
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: `${readKey}.evidence` },
  inputSchema: Schema.Struct({ name: Schema.String }),
  legalEntityScope: 'forbidden' as const,
  owningModuleKey: 'test.read-load',
  policies: [],
  readKey,
  resultSchema: Schema.Array(Schema.String),
  schemaVersion: '1',
});
const loadFormScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '11111111-1111-4111-8111-111111111111',
    authContextRef: 'better-auth-session:read-load',
    authMethod: 'session',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId: '33333333-3333-4333-8333-333333333333',
  }),
  correlationId: 'read-load',
};
const loadFormHandler = (input: { readonly name: string }, context: ReadLoadContext<{ readonly suffix: string }>) =>
  Effect.succeed({
    evidence: { resultCount: 2 },
    result: [input.name, `${context.readKey}:${context.scope.tenantId}:${context.services.suffix}`],
  });
const loadFormServices = () => Effect.succeed({ suffix: 'owner' });
/** A synthetic owner for the runtime probe, not a production module. */
const loadFormOwner = makeModuleContractFixture({ appId: 'read-load-test', moduleId: 'test.read-load' }).manifest;

it('defines the same read from { load: handler } as from the bare handler', () => {
  const descriptor = loadFormDescriptor('test.read-load.bare');
  const bare = defineRead(descriptor, loadFormHandler, loadFormServices);
  const wrapped = defineRead(descriptor, { load: loadFormHandler }, loadFormServices);
  // The `{ load }` form is unwrapped at definition: the registration holds the very same handler.
  expect(getReadHandler(wrapped)).toBe(loadFormHandler);
  expect(getReadHandler(bare)).toBe(loadFormHandler);
  expect(getReadServiceFactory(wrapped)).toBe(getReadServiceFactory(bare));
  expect(Object.keys(wrapped)).toEqual(Object.keys(bare));
  expect(wrapped.descriptor).toEqual(bare.descriptor);
  expect(Object.isFrozen(wrapped.descriptor)).toBe(true);
});

const loadFormRefusal =
  /a pipeline is a plain object of load and optional prepare and finish steps, each an own enumerable data property holding a function/u;
// Each value below satisfies the `{ load }` type (an object that is no fresh literal may carry more keys,
// and a getter or a non-enumerable property still types as `load`), so only the definition-time check
// stands between it and a registration.
const withPrepare = { load: loadFormHandler, prepare: () => Effect.undefined };
const withPrepared = { load: loadFormHandler, prepared: {} };
const withFinish = { finish: () => Effect.undefined, load: loadFormHandler };
const withExtraKey = { extra: true, load: loadFormHandler };
const withSymbolKey = { load: loadFormHandler, [Symbol('extra')]: true };
const withGetter = {
  get load() {
    return loadFormHandler;
  },
};
const withHiddenLoad = Object.defineProperties({ load: loadFormHandler }, { load: { enumerable: false } });
const withLoadThatIsNoHandler = Object.defineProperties({ load: loadFormHandler }, { load: { value: 'no handler' } });
const withInheritedLoad = Object.setPrototypeOf(Object.defineProperties({}, {}), withExtraKey) satisfies object;
const handlerArray = Object.assign([loadFormHandler], { load: loadFormHandler });
// Its own property descriptor shows the handler, and reading the property gives another function.
const withSubstitutingProxy = new Proxy(
  { load: loadFormHandler },
  { get: () => () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) },
);
// The own key is `load` alone; the steps sit on the prototype, where an own-key check does not look.
const withStepsOnPrototype = Object.setPrototypeOf({ load: loadFormHandler }, { prepare: () => Effect.undefined });

it('refuses every other shape of the { load } form at definition', () => {
  const define = (definition: typeof withGetter) => () =>
    defineRead(loadFormDescriptor('test.read-load.refused'), definition, loadFormServices);
  // `prepare` and `finish` are a staged read's own steps, so they define; `prepared` is no step.
  expect(define(withPrepare)).not.toThrow();
  expect(define(withFinish)).not.toThrow();
  expect(define(withPrepared)).toThrow(loadFormRefusal);
  expect(define(withExtraKey)).toThrow(loadFormRefusal);
  expect(define(withSymbolKey)).toThrow(loadFormRefusal);
  expect(define(withGetter)).toThrow(loadFormRefusal);
  expect(define(withHiddenLoad)).toThrow(loadFormRefusal);
  expect(define(withLoadThatIsNoHandler)).toThrow(loadFormRefusal);
  expect(define(withInheritedLoad)).toThrow(loadFormRefusal);
  expect(define(handlerArray)).toThrow(loadFormRefusal);
  expect(define(withStepsOnPrototype)).toThrow(loadFormRefusal);
  expect(define(withSubstitutingProxy)).toThrow(loadFormRefusal);
  expect(define(Object.setPrototypeOf({ load: loadFormHandler }, null))).not.toThrow();
  // Control: the bare handler and the exact `{ load }` object are both accepted.
  expect(() =>
    defineRead(loadFormDescriptor('test.read-load.refused'), loadFormHandler, loadFormServices),
  ).not.toThrow();
  expect(define({ load: loadFormHandler })).not.toThrow();
});

it.layer(NodeCrypto.layer)('the { load } form through the read runtime', (suite) => {
  suite.effect('answers, stages and records evidence exactly as the bare handler does', () =>
    Effect.gen(function* sameRuntimeBehaviour() {
      const readKey = 'test.read-load.runtime';
      const bare = defineRead(loadFormDescriptor(readKey), loadFormHandler, loadFormServices);
      const wrapped = defineRead(loadFormDescriptor(readKey), { load: loadFormHandler }, loadFormServices);
      const run = Effect.fn('ReadLoadForm.run')(function* runReadLoadForm(registration: typeof bare) {
        const harness = yield* makeReadTestHarness({
          access: 'allowed',
          executeOwnerQuery: () => Effect.die('The handler runs no owner SQL'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-18T12:00:00.000Z')),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: defineVerticalRuntimeRegistration({
            actions: [],
            manifest: defineOntosModuleManifest({
              ...loadFormOwner,
              publicSurface: { ...loadFormOwner.publicSurface, actions: [], api: {}, components: {} },
            }),
            outboxWorkers: [],
            reads: [registration],
          }),
          scope: loadFormScope,
        });
        const result = yield* harness.runtime.runRead({
          input: { name: 'probe' },
          principal: loadFormScope,
          registration,
          transport: { correlationId: loadFormScope.correlationId },
        });
        return { result, snapshot: harness.snapshot() };
      });
      const bareRun = yield* run(bare);
      const wrappedRun = yield* run(wrapped);
      expect(bareRun.result).toEqual(['probe', `${readKey}:${loadFormScope.tenantId}:owner`]);
      expect(wrappedRun).toEqual(bareRun);
    }),
  );
});
