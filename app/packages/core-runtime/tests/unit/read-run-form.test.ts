import { NodeCrypto } from '@effect/platform-node';
import { Cause, DateTime, Effect, Exit, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
} from '../../src/access/enforcement/owner-overlay.ts';
import { OwnerAuthorizationOverlay } from '../../src/access/enforcement/owner-overlay.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { ExecutionRuleViolation } from '../../src/execution/contract.ts';
import type { CallExecutionRequest, CallRoute } from '../../src/execution/contract.ts';
import { KernelCalls } from '../../src/execution/kernel-calls.ts';
import type { KernelCallsService } from '../../src/execution/kernel-calls.ts';
import { KernelSessionsLive } from '../../src/execution/runner.ts';
import { KernelTransactionsLive } from '../../src/execution/transaction.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import type { ReadHandlerResult } from '../../src/reads/context.ts';
import type { AnyReadRegistration, ReadLoadContext } from '../../src/reads/definition.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import {
  ReadEvidencePersistenceError,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPolicyEvaluationError,
} from '../../src/reads/errors.ts';
import type { PersistReadEvidenceInput } from '../../src/reads/repository.ts';
import { ReadRunEvidence } from '../../src/reads/run-evidence.ts';
import type { ReadRunEvidenceService } from '../../src/reads/run-evidence.ts';
import { executeRunFormRead } from '../../src/reads/run-form.ts';
import { requireHostedModuleCallRoute } from '../../src/reads/runtime.ts';
import type { RunFormReadInput } from '../../src/reads/sdk-contract.ts';
import { coreOperations } from '../../src/sdk/core-operations.ts';
import { RequestExecutionSchema, callAnswer, declaredCall, moduleOperation } from '../../src/sdk/index.ts';
import { canRun, readAnswer } from '../../src/sdk/read.ts';
import type { NoAccessQuestions, ReadRunContext } from '../../src/sdk/read.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { makeTestDatabase } from '../support/database.ts';

/**
 * The read adapter of the execution kernel: a `{ run }` read runs on the real kernel sessions and
 * transactions over a scripted database, with a stub call executor and a recording evidence writer;
 * the read runtime keeps the one-transaction path for handlers and `{ load }` reads.
 */

const MODULE = 'test.run-form';
const READ_KEY = `${MODULE}.api.verify`;
const tenantId = '20000000-0000-4000-8000-000000000001';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '20000000-0000-4000-8000-000000000002',
  authContextRef: 'better-auth-session:read-run-form',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000003',
  tenantId,
});
const scope: OperationalScope = { ...principal, correlationId: 'read-run-form' };
/** No composition revision was admitted for these executions, and their capture mode keeps no hash. */
const unadmitted = Option.getOrUndefined(Option.none<string>());
const operationAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-18T10:00:00.000Z'));

const ResultSchema = Schema.Struct({
  boundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
  secret: Schema.optionalKey(Schema.String),
  state: Schema.Literals(['CURRENT', 'STALE', 'UNAVAILABLE']),
});
type Result = typeof ResultSchema.Type;
/** The read declares the result schema; typed loosely here so a test can hand Core an invalid result. */
const DeclaredResultSchema: Schema.ConstraintDecoder<unknown> = ResultSchema;

class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()('QuotaExceeded', { limit: Schema.Finite }) {}

const descriptor = (readKey: string = READ_KEY) => ({
  accessDeclaration: {
    key: `${readKey}.read`,
    kind: 'read' as const,
    modes: ['run' as const],
    placement: { group: 'inventory', level: 'basic' as const },
    risk: 'routine' as const,
    selectors: [],
  },
  accessKind: 'detail' as const,
  domainErrorSchema: QuotaExceeded,
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: readKey,
    moduleKey: MODULE,
    role: 'api',
  }),
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: `${readKey}.evidence` },
  inputSchema: Schema.Struct({ subject: Schema.String }),
  legalEntityScope: 'forbidden' as const,
  owningModuleKey: MODULE,
  policies: [],
  readKey,
  resultSchema: DeclaredResultSchema,
  schemaVersion: '1',
});

const restrictionsOperation = moduleOperation({
  kind: 'read',
  path: '/restrictions',
  provider: { entrypointKey: 'test.provider.api.restrictions', moduleId: 'test.provider', schemaVersion: '1' },
  request: Schema.Struct({ subject: Schema.String }),
  response: Schema.Struct({ outcome: Schema.String }),
});
const calls = { restrictions: declaredCall(restrictionsOperation, `${MODULE}.requirement.restrictions`) } as const;

interface Services {
  readonly load: (subject: string) => Effect.Effect<Result>;
}
const services = () =>
  Effect.succeed<Services>({
    load: (subject) => Effect.succeed({ secret: `owner:${subject}`, state: 'CURRENT' }),
  });

type RunContext = ReadRunContext<Services, typeof calls, NoAccessQuestions>;
type Run = (
  input: { readonly subject: string },
  context: RunContext,
) => Effect.Effect<ReadHandlerResult<unknown>, unknown>;

const runRead = (run: Run) => defineRead({ ...descriptor(), calls }, { run }, services);
const answered = <Value>(value: Value) => readAnswer(value, { resultCount: 1 });

/** Statements the scripted database answers; everything else answers no rows. */
const answer = (statement: string): readonly object[] => {
  if (statement.includes('statement_timestamp()')) {
    return [{ operation_at: operationAt }];
  }
  if (statement.includes("current_setting('ontos.tenant_id', true) as tenant_id")) {
    return [{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }];
  }
  return [];
};

const openTransactionsIn = (statements: readonly string[]) =>
  statements.filter((statement) => /^begin/iu.test(statement)).length -
  statements.filter((statement) => /^(?:commit|rollback)$/iu.test(statement.trim())).length;

interface SettledEvidence {
  readonly openTransactions: number;
  readonly rows: readonly PersistReadEvidenceInput[];
}

const okCall = (request: CallExecutionRequest) => ({
  outcome: { _tag: 'Ok' as const, value: { outcome: 'CURRENT' } },
  record: {
    callerKind: 'person' as const,
    durationMillis: 1,
    name: request.name,
    outcome: 'Ok' as const,
    placement: request.placement,
    provider: request.declared.operation.provider,
    requirementKey: request.declared.requirementKey,
    route: 'Module' as const,
    sequence: request.sequence,
  },
});

const makeRunFormHarness = (
  options: { readonly decisions?: readonly OwnerAuthorizationDecision[]; readonly settleFails?: boolean } = {},
) =>
  Effect.gen(function* makeHarness() {
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) =>
      Effect.sync(() => {
        statements.push(statement);
        return answer(statement);
      }),
    );
    const openTransactions = () => openTransactionsIn(statements);
    const callRequests: CallExecutionRequest[] = [];
    const openDuringCalls: number[] = [];
    const callsService: KernelCallsService = {
      execute: (request) =>
        Effect.sync(() => {
          callRequests.push(request);
          openDuringCalls.push(openTransactions());
          return okCall(request);
        }),
    };
    const settled: SettledEvidence[] = [];
    const runEvidence: ReadRunEvidenceService = {
      settle: (input) =>
        Effect.suspend(() => {
          settled.push({ openTransactions: openTransactions(), rows: input.rows });
          return options.settleFails === true
            ? Effect.fail(
                new ReadEvidencePersistenceError({
                  code: 'read_evidence_persistence_failed',
                  reason: 'Required read evidence could not be persisted',
                }),
              )
            : Effect.void;
        }),
    };
    const decisions = [...(options.decisions ?? [])];
    const ownerInputs: OwnerAuthorizationInput[] = [];
    const kernel = yield* Layer.build(
      KernelSessionsLive.pipe(
        Layer.provide(KernelTransactionsLive),
        Layer.provide(Layer.succeed(CoreDatabase, { executor })),
        Layer.provide(Layer.succeed(KernelCalls, callsService)),
        Layer.merge(Layer.succeed(ReadRunEvidence, runEvidence)),
        Layer.merge(
          Layer.succeed(OwnerAuthorizationOverlay, {
            authorize: (_transaction, input) =>
              Effect.sync(() => {
                ownerInputs.push(input);
                return decisions.shift() ?? 'allowed';
              }),
          }),
        ),
      ),
    );
    const execute = (registration: ReturnType<typeof runRead>, overrides: Partial<RunFormReadInput> = {}) =>
      executeRunFormRead(registration, {
        access: {},
        decodedInput: { subject: 'customer' },
        deniedFieldPaths: [],
        facts: {
          compositionRevision: unadmitted,
          identity: RequestExecutionSchema.make({ via: 'person' }),
          operationKey: READ_KEY,
          owningModuleKey: MODULE,
        },
        lease: (effect) => effect,
        ownerQuestion: {
          capabilityKey: `${READ_KEY}.read`,
          operation: 'read',
          operationKey: READ_KEY,
          owningModuleKey: MODULE,
          scope,
          targets: [],
        },
        permissionTargetMetadata: {},
        queryHash: unadmitted,
        scope,
        usesAccessGate: true,
        workloadAdmission: { carrier: {} },
        ...overrides,
      }).pipe(Effect.provideContext(kernel));
    return { callRequests, execute, openDuringCalls, ownerInputs, settled };
  });

const rowsOf = (settled: readonly SettledEvidence[]) =>
  settled.map(({ rows }) =>
    rows.map(({ outcome, outcomeCode, outcomeStage, targetModuleKey }) =>
      targetModuleKey === undefined
        ? { outcome, outcomeCode, outcomeStage }
        : { outcome, outcomeCode, outcomeStage, targetModuleKey },
    ),
  );

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isSuccess(exit) ? undefined : Option.getOrUndefined(Cause.findErrorOption(exit.cause));

const allowedRow = { outcome: 'allowed', outcomeCode: 'read_allowed', outcomeStage: 'evidence' };
const callRow = {
  outcome: 'allowed',
  outcomeCode: 'call_ok',
  outcomeStage: 'execution',
  targetModuleKey: 'test.provider',
};
const deniedRow = { outcome: 'denied', outcomeCode: 'read_permission_denied', outcomeStage: 'authz' };

it.effect('runs a { run } read with zero calls and one transaction and releases its validated result', () =>
  Effect.scoped(
    Effect.gen(function* oneTransaction() {
      const harness = yield* makeRunFormHarness();
      const result = yield* harness.execute(
        runRead((input, context) =>
          context.transaction((owned) => owned.load(input.subject)).pipe(Effect.map(answered)),
        ),
      );
      expect(result).toEqual({ secret: 'owner:customer', state: 'CURRENT' });
      // The owner rule is decided before `run` (the opening check) and again in the transaction.
      expect(harness.ownerInputs.map((input) => DateTime.toDateUtc(input.operationAt))).toEqual([
        operationAt,
        operationAt,
      ]);
      expect(rowsOf(harness.settled)).toEqual([[allowedRow]]);
      expect(harness.settled[0]?.openTransactions).toBe(0);
    }),
  ),
);

it.effect('answers 403 for a { run } read with only calls when the owner rule denies, and sends no call', () =>
  Effect.scoped(
    Effect.gen(function* deniedBeforeCalls() {
      const harness = yield* makeRunFormHarness({ decisions: ['denied'] });
      let ran = false;
      const exit = yield* Effect.exit(
        harness.execute(
          runRead((input, context) =>
            Effect.sync(() => {
              ran = true;
            }).pipe(
              Effect.andThen(context.call('restrictions', { subject: input.subject })),
              Effect.map((outcome) => answered({ state: Option.isSome(callAnswer(outcome)) ? 'CURRENT' : 'STALE' })),
            ),
          ),
        ),
      );
      expect(Schema.is(ReadPermissionDenied)(failureOf(exit))).toBe(true);
      expect(ran).toBe(false);
      expect(harness.callRequests).toHaveLength(0);
      expect(rowsOf(harness.settled)).toEqual([[deniedRow]]);
    }),
  ),
);

it.effect('answers 403 with denied evidence and call rows when run swallows the owner denial', () =>
  Effect.scoped(
    Effect.gen(function* swallowedDenial() {
      // Allowed by the opening check, denied in the module's own transaction.
      const harness = yield* makeRunFormHarness({ decisions: ['allowed', 'denied'] });
      const exit = yield* Effect.exit(
        harness.execute(
          runRead((input, context) =>
            context
              .call('restrictions', { subject: input.subject })
              .pipe(
                Effect.andThen(
                  context
                    .transaction((owned) => owned.load(input.subject))
                    .pipe(Effect.orElseSucceed((): Result => ({ state: 'UNAVAILABLE' }))),
                ),
                Effect.map(answered),
              ),
          ),
        ),
      );
      expect(Schema.is(ReadPermissionDenied)(failureOf(exit))).toBe(true);
      expect(harness.callRequests).toHaveLength(1);
      expect(rowsOf(harness.settled)).toEqual([[deniedRow, callRow]]);
    }),
  ),
);

it.effect('writes the denied authz row when run itself refuses the caller', () =>
  Effect.scoped(
    Effect.gen(function* moduleDenial() {
      const harness = yield* makeRunFormHarness();
      const refusal = new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: 'The request is outside the trusted operational context',
      });
      const exit = yield* Effect.exit(harness.execute(runRead(() => Effect.fail(refusal))));
      expect(failureOf(exit)).toBe(refusal);
      expect(rowsOf(harness.settled)).toEqual([[deniedRow]]);
    }),
  ),
);

it.effect('still answers the denial when its denied evidence cannot be written', () =>
  Effect.scoped(
    Effect.gen(function* deniedEvidenceFails() {
      const ownerDenied = yield* makeRunFormHarness({ decisions: ['denied'], settleFails: true });
      const ownerExit = yield* Effect.exit(
        ownerDenied.execute(runRead(() => Effect.succeed(answered({ state: 'CURRENT' })))),
      );
      expect(Schema.is(ReadPermissionDenied)(failureOf(ownerExit))).toBe(true);
      const refusal = new ReadPermissionDenied({
        code: 'read_permission_denied',
        reason: 'The request is outside the trusted operational context',
      });
      const moduleDenied = yield* makeRunFormHarness({ settleFails: true });
      const moduleExit = yield* Effect.exit(moduleDenied.execute(runRead(() => Effect.fail(refusal))));
      expect(failureOf(moduleExit)).toBe(refusal);
      expect(rowsOf(moduleDenied.settled)).toEqual([[deniedRow]]);
    }),
  ),
);

it.effect('answers permission unavailable when the owner rule cannot answer', () =>
  Effect.scoped(
    Effect.gen(function* ownerUnavailable() {
      const harness = yield* makeRunFormHarness({ decisions: ['unavailable'] });
      const exit = yield* Effect.exit(harness.execute(runRead(() => Effect.succeed(answered({ state: 'CURRENT' })))));
      expect(Predicate.isTagged(failureOf(exit), 'ReadPermissionUnavailable')).toBe(true);
      expect(rowsOf(harness.settled)).toEqual([
        [{ outcome: 'failed', outcomeCode: 'read_permission_unavailable', outcomeStage: 'execution' }],
      ]);
    }),
  ),
);

it.effect('fails result validation without releasing anything and records the failed row', () =>
  Effect.scoped(
    Effect.gen(function* invalidResult() {
      const harness = yield* makeRunFormHarness();
      const exit = yield* Effect.exit(harness.execute(runRead(() => Effect.succeed(answered({ state: 'UNKNOWN' })))));
      expect(Predicate.isTagged(failureOf(exit), 'ReadResultValidationError')).toBe(true);
      expect(rowsOf(harness.settled)).toEqual([
        [{ outcome: 'failed', outcomeCode: 'read_result_invalid', outcomeStage: 'execution' }],
      ]);
    }),
  ),
);

it.effect('commits the evidence before release, then removes the denied fields', () =>
  Effect.scoped(
    Effect.gen(function* evidenceThenProjection() {
      const registration = runRead((input, context) =>
        context.transaction((owned) => owned.load(input.subject)).pipe(Effect.map(answered)),
      );
      const harness = yield* makeRunFormHarness();
      expect(yield* harness.execute(registration, { deniedFieldPaths: [['secret']] })).toEqual({ state: 'CURRENT' });
      expect(rowsOf(harness.settled)).toEqual([[allowedRow]]);
      // Without committed evidence nothing is released.
      const failing = yield* makeRunFormHarness({ settleFails: true });
      const exit = yield* Effect.exit(failing.execute(registration, { deniedFieldPaths: [['secret']] }));
      expect(Schema.is(ReadEvidencePersistenceError)(failureOf(exit))).toBe(true);
    }),
  ),
);

it.effect('passes a declared domain error and sanitizes any other failure of run', () =>
  Effect.scoped(
    Effect.gen(function* domainFailure() {
      const harness = yield* makeRunFormHarness();
      const declared = new QuotaExceeded({ limit: 3 });
      expect(failureOf(yield* Effect.exit(harness.execute(runRead(() => Effect.fail(declared)))))).toEqual(declared);
      const undeclared = failureOf(
        yield* Effect.exit(
          harness.execute(
            runRead(() =>
              Effect.fail(
                new ReadPolicyEvaluationError({ code: 'read_policy_evaluation_failed', reason: 'secret owner detail' }),
              ),
            ),
          ),
        ),
      );
      expect(Predicate.isTagged(undeclared, 'ReadHandlerExecutionError')).toBe(true);
      expect(Predicate.hasProperty(undeclared, 'reason') ? undeclared.reason : '').not.toMatch(/secret/u);
    }),
  ),
);

it.effect('answers 503 for a kernel rule violation: a call inside the transaction', () =>
  Effect.scoped(
    Effect.gen(function* ruleViolation() {
      const harness = yield* makeRunFormHarness();
      const exit = yield* Effect.exit(
        harness.execute(
          runRead((input, context) =>
            context
              .transaction(() => context.call('restrictions', { subject: input.subject }))
              .pipe(Effect.map(() => answered({ state: 'CURRENT' }))),
          ),
        ),
      );
      const failure = failureOf(exit);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      const cause = Predicate.hasProperty(failure, 'cause') ? failure.cause : undefined;
      expect(
        Cause.isCause(cause) &&
          cause.reasons.some(
            (reason) =>
              Cause.isDieReason(reason) &&
              Schema.is(ExecutionRuleViolation)(reason.defect) &&
              reason.defect.rule === 'call_inside_transaction',
          ),
      ).toBe(true);
      expect(harness.callRequests).toHaveLength(0);
    }),
  ),
);

it.effect('holds no transaction while run calls', () =>
  Effect.scoped(
    Effect.gen(function* noTransactionDuringCalls() {
      const harness = yield* makeRunFormHarness();
      yield* harness.execute(
        runRead((input, context) =>
          context
            .transaction((owned) => owned.load(input.subject))
            .pipe(
              Effect.andThen(context.call('restrictions', { subject: input.subject })),
              Effect.andThen(context.transaction((owned) => owned.load(input.subject))),
              Effect.map(answered),
            ),
        ),
      );
      expect(harness.openDuringCalls).toEqual([0]);
      expect(rowsOf(harness.settled)).toEqual([[allowedRow, callRow]]);
    }),
  ),
);

it.effect('releases a proof as computed at its transaction, with its own boundary', () =>
  Effect.scoped(
    Effect.gen(function* proofBoundary() {
      const harness = yield* makeRunFormHarness();
      // The boundary passes right after the check; Core does not re-check it before release.
      const boundary = DateTime.add(DateTime.fromDateUnsafe(operationAt), { milliseconds: 1 });
      const result = yield* harness.execute(
        runRead((_input, context) =>
          context
            .transaction((_owned, facts) =>
              Effect.succeed<Result>(
                DateTime.isLessThan(facts.operationAt, boundary) ? { boundary, state: 'CURRENT' } : { state: 'STALE' },
              ),
            )
            .pipe(Effect.map(answered)),
        ),
      );
      expect(result).toEqual({ boundary, state: 'CURRENT' });
    }),
  ),
);

/* ------------------------------------------------------------------------------------------------ */
/* Through the read runtime                                                                         */
/* ------------------------------------------------------------------------------------------------ */

const revision = 'c'.repeat(64);
const owner = makeModuleContractFixture({ appId: 'read-run-form-test', moduleId: MODULE }).manifest;
/** The manifest requirement that covers one declared call of a read hosted here. */
const requirementOf = (
  entrypointKey: string,
  key: string,
  provider: Readonly<{ entrypointKey: string; moduleId: string; schemaVersion: string }>,
) =>
  withOptional(
    {
      condition: `${MODULE}.condition.${key}`,
      entrypointKey,
      evidence: [`${MODULE}.evidence.${key}`],
      key: `${MODULE}.requirement.${key}`,
      provider: { ...provider },
    },
    // A Core provider runs in-process with the execution's own principal: no caller is declared.
    'callers',
    provider.moduleId.startsWith('core.')
      ? undefined
      : [{ kind: 'person' as const, legalEntityScope: 'subject' as const }],
  );
const hostOf = (reads: readonly AnyReadRegistration[], operations: readonly ReturnType<typeof requirementOf>[] = []) =>
  defineVerticalRuntimeRegistration({
    actions: [],
    manifest: defineOntosModuleManifest(
      withOptional(
        { ...owner, publicSurface: { ...owner.publicSurface, actions: [], api: {}, components: {} } },
        'requirements',
        operations.length === 0
          ? undefined
          : { coreCapabilities: [], intrinsic: [], operations, schemaVersion: '1' as const },
      ),
    ),
    outboxWorkers: [],
    reads,
  });
const restrictionsRequirement = requirementOf(READ_KEY, 'restrictions', restrictionsOperation.provider);

/** Before the harness exists, no connection count is observed. */
const noConnectionObserved = () => -1;

it.layer(NodeCrypto.layer)('the read runtime', (suite) => {
  suite.effect('runs a governed { run } read without holding a transaction across run', () =>
    Effect.gen(function* governedRun() {
      const observed: number[] = [];
      let openConnections = noConnectionObserved;
      const registration = defineRead(
        descriptor(),
        {
          run: (input, context) =>
            Effect.sync(() => {
              observed.push(openConnections());
            }).pipe(Effect.andThen(context.transaction((owned) => owned.load(input.subject))), Effect.map(answered)),
        },
        services,
      );
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        compositionRevision: revision,
        executeOwnerQuery: () => Effect.die('The read runs no owner SQL'),
        operationTime: operationAt,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: hostOf([registration]),
        scope,
      });
      ({ openConnections } = harness);
      const result = yield* harness.runtime.runRead({
        input: { subject: 'customer' },
        principal: trustVerifiedGatewayPrincipalContext(scope, revision),
        registration,
        transport: { correlationId: scope.correlationId },
      });
      expect(result).toEqual({ secret: 'owner:customer', state: 'CURRENT' });
      expect(observed).toEqual([0]);
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  suite.effect('asks the access questions of a governed { load } read in its owned transaction', () =>
    Effect.gen(function* governedLoadQuestions() {
      const target = defineRead(
        descriptor(`${MODULE}.api.records`),
        (_input, context: ReadLoadContext<Services>) => context.services.load('records').pipe(Effect.map(answered)),
        services,
      );
      const registration = defineRead(
        { ...descriptor(), accessQuestions: { write: canRun(target) } },
        {
          load: (_input, context) =>
            Effect.succeed(answered({ state: context.access.write === 'allowed' ? 'CURRENT' : 'STALE' })),
        },
        services,
      );
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        compositionRevision: revision,
        executeOwnerQuery: () => Effect.die('The read runs no owner SQL'),
        operationTime: operationAt,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: hostOf([registration, target]),
        scope,
      });
      const result = yield* harness.runtime.runRead({
        input: { subject: 'customer' },
        principal: trustVerifiedGatewayPrincipalContext(scope, revision),
        registration,
        transport: { correlationId: scope.correlationId },
      });
      expect(result).toEqual({ state: 'CURRENT' });
      const { connectionsOpened, gateTransactions } = harness.snapshot();
      // The own decision and the question both join the governed transaction: one connection.
      expect(gateTransactions.length).toBeGreaterThanOrEqual(2);
      expect(gateTransactions.every((transaction) => transaction === 'owned')).toBe(true);
      expect(connectionsOpened).toBe(1);
    }),
  );
});

it.effect('refuses to start a vertical host whose reads call another vertical without a ModuleCallRoute', () =>
  Effect.gen(function* hostWithoutRoute() {
    const moduleCalling = runRead(() => Effect.succeed(answered({ state: 'CURRENT' })));
    const coreCalling = defineRead(
      {
        ...descriptor(`${MODULE}.api.core`),
        calls: { legalEntity: declaredCall(coreOperations.legalEntityDetail, `${MODULE}.requirement.legal-entity`) },
      },
      { run: () => Effect.succeed(answered({ state: 'CURRENT' })) },
      services,
    );
    const route: CallRoute = { send: () => Effect.succeed({ _tag: 'Unreachable' as const, reason: 'stub' }) };
    const moduleHost = hostOf([moduleCalling], [restrictionsRequirement]);
    const coreHost = hostOf(
      [coreCalling],
      [requirementOf(`${MODULE}.api.core`, 'legal-entity', coreOperations.legalEntityDetail.provider)],
    );
    const exit = yield* Effect.exit(requireHostedModuleCallRoute(moduleHost, Option.none()));
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) =>
            Cause.isDieReason(reason) &&
            Schema.is(ExecutionRuleViolation)(reason.defect) &&
            reason.defect.rule === 'module_call_without_route',
        ),
    ).toBe(true);
    // With the route, or with only Core calls, the host starts.
    yield* requireHostedModuleCallRoute(moduleHost, Option.some(route));
    yield* requireHostedModuleCallRoute(coreHost, Option.none());
  }),
);
