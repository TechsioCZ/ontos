import { Cause, DateTime, Effect, Exit, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { NodeCrypto } from '@effect/platform-node';

import type { OwnerAuthorizationInput } from '../../src/access/enforcement/owner-overlay.ts';
import { defineAction, validateActionDescriptorInput } from '../../src/actions/definition.ts';
import type { ActionOwnerFactsResolver } from '../../src/actions/definition.ts';
import { ActionPermissionCheckError } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadAccessOwnerFactsResolver, ReadServiceFactory } from '../../src/reads/definition.ts';
import type { ReadCoreError, ReadHandlerUnavailable } from '../../src/reads/errors.ts';
import { ReadPermissionUnavailable } from '../../src/reads/errors.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

/** Module-operation admission refuses a non-Core operation with no bound owner registration. */
const shellOwner = makeTestOperationOwner({ moduleId: 'core.shell' }).ownerRegistration;

/**
 * O70: an entrypoint may name the owner records its owner rule is about. Core hands those facts to
 * the owner overlay inside the transaction, and only there: no fact reaches the decision engine, so
 * a fact can never grant anything. A resolver that cannot produce them fails closed as a retryable
 * 503, exactly like an unanswerable engine, and an empty map is no facts at all.
 */

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:owner-facts-fixture',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000080',
  principalId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
});

const CAPABILITY = 'core.shell.fixture.owner-facts';
const COUNTERPARTY = '00000000-0000-4000-8000-0000000000aa';
const WORKLOAD_KEY = 'core.shell.fixture.owner-facts-workload';

type FixturePayload = Readonly<{ readonly amount: number }>;

const fixtureEntrypoint = (actionKey: string) =>
  defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: actionKey,
    moduleKey: 'core.shell',
    role: 'action',
  });

const fixtureDescriptor = (actionKey: string) => ({
  accessEvidencePolicy: { captureMode: 'metadata_only' as const, policyKey: `${actionKey}.access.v1` },
  actionKey,
  auditProfile: 'standard' as const,
  domainErrorSchema: Schema.Never,
  domainEvents: {},
  entrypoint: fixtureEntrypoint(actionKey),
  idempotency: 'required' as const,
  legalEntityScope: 'optional' as const,
  owningModuleKey: 'core.shell',
  payloadSchema: Schema.Struct({ amount: Schema.Finite }),
  policies: [],
  resultSchema: Schema.Struct({ total: Schema.Finite }),
  schemaVersion: '1',
});

const declaration = {
  key: CAPABILITY,
  kind: 'action' as const,
  modes: ['run', 'propose', 'approve'] as const,
  placement: { group: 'fixtures', level: 'basic' as const },
  risk: 'sensitive' as const,
  selectors: [] as const,
};

const noServices = () => Effect.succeed(Object.freeze({}));
const ownerFacts = () => ({ counterpartyId: COUNTERPARTY });

const actionWithFacts = (accessOwnerFacts: ActionOwnerFactsResolver<FixturePayload>) =>
  defineAction(
    { ...fixtureDescriptor(CAPABILITY), accessDeclaration: declaration, accessOwnerFacts },
    (payload: FixturePayload) => Effect.succeed({ total: payload.amount }),
    noServices,
  );

const actionWithoutFacts = () =>
  defineAction(
    { ...fixtureDescriptor(CAPABILITY), accessDeclaration: declaration },
    (payload: FixturePayload) => Effect.succeed({ total: payload.amount }),
    noServices,
  );

const actionWithEmptyFacts = () =>
  defineAction(
    { ...fixtureDescriptor(CAPABILITY), accessDeclaration: declaration, accessOwnerFacts: () => ({}) },
    (payload: FixturePayload) => Effect.succeed({ total: payload.amount }),
    noServices,
  );

const actionWithFailingFacts = () =>
  defineAction(
    {
      ...fixtureDescriptor(CAPABILITY),
      accessDeclaration: declaration,
      accessOwnerFacts: () => {
        throw new Error('owner facts unavailable');
      },
    },
    (payload: FixturePayload) => Effect.succeed({ total: payload.amount }),
    noServices,
  );

const transport = (correlationId: string) => ({ correlationId, idempotencyKey: `${correlationId}-1` });

/** The typed failure of one run; a successful exit is a fixture bug. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): object => {
  if (Exit.isSuccess(exit)) {
    throw new Error('The fixture expected the runner to refuse this call');
  }
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error) || !Predicate.isObject(error.value)) {
    throw new Error('The fixture expected a typed refusal, not a defect');
  }
  return error.value;
};

type FixtureRegistration = ReturnType<typeof actionWithFacts>;

it.effect('hands the declared owner-local facts to the owner overlay inside the transaction (O70)', () =>
  Effect.gen(function* factsReachTheOverlay() {
    const ownerInputs: OwnerAuthorizationInput[] = [];
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      onOwnerAuthorization: (input) => {
        ownerInputs.push(input);
        return 'allowed' as const;
      },
      ownerRegistration: shellOwner,
    });
    const result = yield* harness.runtime.runAction({
      payload: { amount: 3 },
      principal,
      registration: actionWithFacts(ownerFacts),
      transport: transport('owner-facts'),
    });

    expect(result).toEqual({ total: 3 });
    expect(ownerInputs).toHaveLength(1);
    expect(ownerInputs[0]?.capabilityKey).toBe(CAPABILITY);
    // The facts name the owner record the rule is about; they are the only channel that carries it.
    expect(ownerInputs[0]?.ownerFacts).toEqual({ counterpartyId: COUNTERPARTY });
    // A v2 descriptor carries no legacy owner target, so the overlay decides on the facts alone.
    expect(ownerInputs[0]?.targets).toEqual([]);
    expect(harness.snapshot().stages).toContain('handler_executed');
  }),
);

it.effect('distinguishes a declared-but-empty fact bag from no resolver at all (O70)', () =>
  Effect.gen(function* factsAbsent() {
    const ownerInputs: OwnerAuthorizationInput[] = [];
    const runWith = (registration: FixtureRegistration, correlationId: string) =>
      Effect.gen(function* runFixture() {
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          onOwnerAuthorization: (input) => {
            ownerInputs.push(input);
            return 'allowed' as const;
          },
          ownerRegistration: shellOwner,
        });
        return yield* harness.runtime.runAction({
          payload: { amount: 1 },
          principal,
          registration,
          transport: transport(correlationId),
        });
      });

    yield* runWith(actionWithoutFacts(), 'owner-facts-none');
    yield* runWith(actionWithEmptyFacts(), 'owner-facts-empty');

    expect(ownerInputs).toHaveLength(2);
    // No resolver means no fact channel at all; a resolver that returns an empty map is the owner's
    // own statement that the request names no owner record, so the empty bag is passed through (O70).
    expect(ownerInputs.map((input) => 'ownerFacts' in input)).toEqual([false, true]);
    expect(ownerInputs[1]?.ownerFacts).toEqual({});
  }),
);

it.effect('answers a failing owner-facts resolver with a retryable 503 and never reaches the handler (O70)', () =>
  Effect.gen(function* failingFactsResolver() {
    let ownerAuthorizationCalls = 0;
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      onOwnerAuthorization: () => {
        ownerAuthorizationCalls += 1;
        return 'allowed' as const;
      },
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 2 },
        principal,
        registration: actionWithFailingFacts(),
        transport: transport('owner-facts-defect'),
      }),
    );

    // A resolver defect is Core state Core cannot answer with, so it is a retryable 503.
    expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
    expect(ownerAuthorizationCalls).toBe(0);
    expect(harness.snapshot().permissionDenials).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it('binds owner facts to a declared capability and to a resolver function (O5, O70)', () => {
  const bound = actionWithFacts(ownerFacts);
  expect(bound.descriptor.accessOwnerFacts).toBe(ownerFacts);
  expect(actionWithoutFacts().descriptor.accessOwnerFacts).toBeUndefined();

  const negativeControls: readonly [() => void, RegExp][] = [
    // Facts name the records of a capability; a workload carrier declares no capability at all.
    [
      () =>
        validateActionDescriptorInput({
          ...fixtureDescriptor(WORKLOAD_KEY),
          accessOwnerFacts: ownerFacts,
          accessWorkload: { reason: 'Trusted machine provisioning only', workloads: ['core.machine-provisioner'] },
        }),
      /accessOwnerFacts requires the descriptor to declare its own accessDeclaration/u,
    ],
    // A resolver is a function, never an already-evaluated map (O5).
    [
      () =>
        validateActionDescriptorInput({
          ...fixtureDescriptor(CAPABILITY),
          accessDeclaration: declaration,
          accessOwnerFacts: { counterpartyId: COUNTERPARTY },
        }),
      /access owner facts must be a resolver function/u,
    ],
  ];
  for (const [control, reason] of negativeControls) {
    expect(control).toThrow(reason);
  }
});

// --- The same O70 contract on the governed-read path ---

const READ_CAPABILITY = 'core.shell.fixture.owner-facts-read';
const readScope = { ...principal, correlationId: 'owner-facts-read' };
const readOperationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:00:00.000Z'));

interface ReadServices {
  readonly read: Effect.Effect<readonly string[], ReadHandlerUnavailable>;
}

const makeReadServices: ReadServiceFactory<ReadServices> = () => Effect.succeed({ read: Effect.succeed(['row']) });

const readDescriptor = {
  accessDeclaration: {
    key: READ_CAPABILITY,
    kind: 'read',
    modes: ['run'],
    placement: { group: 'fixtures', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  accessKind: 'detail',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: READ_CAPABILITY,
    moduleKey: 'core.shell',
    role: 'api',
  }),
  evidencePolicy: { captureMode: 'metadata_only', policyKey: `${READ_CAPABILITY}.evidence.v1` },
  inputSchema: Schema.Struct({}),
  legalEntityScope: 'optional',
  owningModuleKey: 'core.shell',
  permissionTarget: 'module',
  policies: [],
  readKey: READ_CAPABILITY,
  resultSchema: Schema.Array(Schema.String),
  schemaVersion: '1',
} as const;

/** An absent resolver stays absent, so the read sees exactly what the descriptor declares (O70). */
const readRegistration = (accessOwnerFacts?: ReadAccessOwnerFactsResolver<Record<string, never>>) =>
  defineRead(
    accessOwnerFacts === undefined ? readDescriptor : { ...readDescriptor, accessOwnerFacts },
    (_input, context) =>
      context.services.read.pipe(Effect.map((result) => ({ evidence: { resultCount: result.length }, result }))),
    makeReadServices,
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );

const runRead = (
  harness: Effect.Success<ReturnType<typeof makeReadTestHarness>>,
  registration: ReturnType<typeof readRegistration>,
): Effect.Effect<readonly string[], ReadCoreError> =>
  harness.runtime.runRead({
    input: {},
    principal,
    registration,
    transport: { correlationId: readScope.correlationId },
  });

const runReadWithOwnerFacts = (
  ownerInputs: OwnerAuthorizationInput[],
  accessOwnerFacts?: ReadAccessOwnerFactsResolver<Record<string, never>>,
) =>
  Effect.gen(function* runFixture() {
    const harness = yield* makeReadTestHarness({
      access: 'allowed',
      executeOwnerQuery: () => Effect.die('This fixture read touches no owner SQL'),
      onOwnerAuthorization: (input) => {
        ownerInputs.push(input);
        return 'allowed' as const;
      },
      operationTime: readOperationTime,
      ownerRegistration: shellOwner,
      permissionDecision: 'allowed',
      scope: readScope,
    });
    return yield* runRead(harness, readRegistration(accessOwnerFacts));
  });

it.layer(NodeCrypto.layer)('governed-read owner facts', (suite) => {
  suite.effect('passes a declared empty fact bag through and leaves no resolver fact-free (O70)', () =>
    Effect.gen(function* readFacts() {
      const ownerInputs: OwnerAuthorizationInput[] = [];
      yield* runReadWithOwnerFacts(ownerInputs);
      yield* runReadWithOwnerFacts(ownerInputs, () => ({}));
      yield* runReadWithOwnerFacts(ownerInputs, () => ({ counterpartyId: COUNTERPARTY }));

      expect(ownerInputs).toHaveLength(3);
      // No resolver is no fact channel; an empty bag is the owner's own "no owner record" answer and
      // is passed through unchanged, exactly as the Action path does (O70).
      expect(ownerInputs.map((input) => 'ownerFacts' in input)).toEqual([false, true, true]);
      expect(ownerInputs[1]?.ownerFacts).toEqual({});
      expect(ownerInputs[2]?.ownerFacts).toEqual({ counterpartyId: COUNTERPARTY });
    }),
  );

  suite.effect('answers a failing read owner-facts resolver with a retryable 503 (O70)', () =>
    Effect.gen(function* readFactsDefect() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () => Effect.die('A failing resolver must not reach owner SQL'),
        operationTime: readOperationTime,
        permissionDecision: 'allowed',
        scope: readScope,
      });
      const failure = yield* Effect.flip(
        runRead(
          harness,
          readRegistration(() => {
            throw new Error('read owner facts unavailable');
          }),
        ),
      );
      expect(Schema.is(ReadPermissionUnavailable)(failure)).toBe(true);
      expect(harness.snapshot().stages).not.toContain('handler_executed');
    }),
  );
});
