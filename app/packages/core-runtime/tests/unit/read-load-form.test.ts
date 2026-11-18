import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadLoadContext } from '../../src/reads/definition.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { getReadHandler, getReadServiceFactory, makeReadTestHarness } from '../../src/testing/reads.ts';

// A read here has one step, its handler, written bare or as `{ load: handler }`. These tests hold for
// as long as `defineRead` has no `prepare` or `finish` step, and go when it gets them.
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

const loadStepRefusal = /a read has no (?:prepare|prepared|finish) step/u;
// Each value below satisfies the `{ load }` type (an object that is no fresh literal may carry more keys),
// so only the definition-time check stands between it and a registration.
const withPrepare = { load: loadFormHandler, prepare: () => Effect.undefined };
const withPrepared = { load: loadFormHandler, prepared: {} };
const withFinish = { finish: () => Effect.undefined, load: loadFormHandler };
const withExtraKey = { extra: true, load: loadFormHandler };
const withLoadThatIsNoHandler = { load: loadFormHandler };
Reflect.set(withLoadThatIsNoHandler, 'load', 'no handler');

it('refuses every other shape of the { load } form at definition, naming what is wrong', () => {
  const define = (definition: { readonly load: typeof loadFormHandler }) => () =>
    defineRead(loadFormDescriptor('test.read-load.refused'), definition, loadFormServices);
  expect(define(withPrepare)).toThrow(loadStepRefusal);
  expect(define(withPrepared)).toThrow(loadStepRefusal);
  expect(define(withFinish)).toThrow(loadStepRefusal);
  expect(define(withExtraKey)).toThrow(/unknown key extra/u);
  expect(define(withLoadThatIsNoHandler)).toThrow(/must be a function/u);
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
