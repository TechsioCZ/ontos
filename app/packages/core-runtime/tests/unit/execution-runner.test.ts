import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OwnerAuthorizationDecision } from '../../src/access/enforcement/owner-overlay.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { dataAccessEvents } from '../../src/db/schema.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import { ExecutionRuleViolation, RequestPrincipalCallerSourceSchema } from '../../src/execution/contract.ts';
import type {
  CallExecutionRequest,
  ExecutionBudget,
  KernelExecution,
  OwnerBinding,
} from '../../src/execution/contract.ts';
import { KernelCalls } from '../../src/execution/kernel-calls.ts';
import type { KernelCallsService } from '../../src/execution/kernel-calls.ts';
import { KernelSessions } from '../../src/execution/kernel-sessions.ts';
import { KernelSessionsLive } from '../../src/execution/runner.ts';
import { KernelTransactionsLive } from '../../src/execution/transaction.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import {
  CallForbiddenSchema,
  CallNotFoundSchema,
  CallUnavailableSchema,
  IdempotencyKeySchema,
  RequestExecutionSchema,
  TransactionAborted,
  callAnswer,
  declaredCall,
  declaredWriteCall,
  moduleOperation,
} from '../../src/sdk/index.ts';
import type { DeclaredCalls } from '../../src/sdk/index.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000002',
  authContextRef: 'better-auth-session:execution-runner',
  authMethod: 'session',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId,
});
const scope: OperationalScope = { ...principal, correlationId: 'execution-runner' };
const operationTime = DateTime.makeUnsafe('2026-11-18T10:00:00.000Z');

const subjectSchema = Schema.Struct({ subject: Schema.String });
const answerSchema = Schema.Struct({ outcome: Schema.String });
const restrictionsOperation = moduleOperation({
  kind: 'read',
  path: '/restrictions',
  provider: { entrypointKey: 'test.provider.api.restrictions', moduleId: 'test.provider', schemaVersion: '1' },
  request: subjectSchema,
  response: answerSchema,
});
const commitOperation = moduleOperation({
  kind: 'write',
  path: '/commit',
  provider: { entrypointKey: 'test.provider.api.commit', moduleId: 'test.provider', schemaVersion: '1' },
  request: subjectSchema,
  response: answerSchema,
});
const calls = {
  commit: declaredWriteCall(commitOperation, 'test.consumer.requirement.commit', 'restrictions'),
  restrictions: declaredCall(restrictionsOperation, 'test.consumer.requirement.restrictions'),
} as const;

const commitKey = Schema.decodeSync(IdempotencyKeySchema)('commit-1');

const generousBudget: ExecutionBudget = { maxCalls: 64, maxDurationMillis: 600_000, maxTransactions: 24 };

const execution = <Calls extends DeclaredCalls>(
  declared: Calls,
  budget: ExecutionBudget = generousBudget,
  revision?: string,
): KernelExecution<Calls> => ({
  budget,
  callerSource: RequestPrincipalCallerSourceSchema.make({ principal }),
  calls: declared,
  facts: {
    compositionRevision: revision,
    identity: RequestExecutionSchema.make({ via: 'person' }),
    operationKey: 'test.consumer.api.verify',
    owningModuleKey: 'test.consumer',
  },
  scope,
  transactionMode: 'session_default',
});

class FactoryDependency extends Context.Service<FactoryDependency, { readonly label: string }>()(
  '@app/core-runtime/tests/unit/execution-runner.test/FactoryDependency',
) {}

interface TestServices {
  readonly executor: ScopedTransactionExecutor;
  readonly label: string;
}

/** Statements the scripted database answers; everything else answers no rows. */
const scriptedRows = (statement: string): readonly object[] => {
  if (statement.includes('statement_timestamp()')) {
    return [{ operation_at: DateTime.toDateUtc(operationTime) }];
  }
  if (statement.includes("current_setting('ontos.tenant_id', true) as tenant_id")) {
    return [{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }];
  }
  return [];
};

const okExecution: KernelCallsService['execute'] = (request) =>
  Effect.succeed({
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

const recordRequest = (requests: CallExecutionRequest[], request: CallExecutionRequest) =>
  Effect.sync(() => {
    requests.push(request);
  });

const makeHarness = (decisions: OwnerAuthorizationDecision[], execute?: KernelCallsService['execute']) =>
  Effect.gen(function* makeRunnerHarness() {
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) =>
      Effect.sync(() => {
        statements.push(statement);
        return scriptedRows(statement);
      }),
    );
    const callRequests: CallExecutionRequest[] = [];
    const callsService: KernelCallsService = {
      execute: (request) =>
        (execute ?? okExecution)(request).pipe(Effect.tap(() => recordRequest(callRequests, request))),
    };
    const sealCloses = { count: 0 };
    const owner: OwnerBinding<TestServices, FactoryDependency> = {
      build: (transaction) =>
        Effect.gen(function* buildTestServices() {
          const dependency = yield* FactoryDependency;
          return { executor: transaction, label: dependency.label };
        }),
      decide: () => Effect.sync(() => decisions.shift() ?? 'allowed'),
      seal: (transaction) => ({
        close: () => {
          sealCloses.count += 1;
        },
        transaction,
      }),
    };
    const layer = KernelSessionsLive.pipe(
      Layer.provide(KernelTransactionsLive),
      Layer.provide(Layer.succeed(CoreDatabase, { executor })),
      Layer.provide(Layer.succeed(KernelCalls, callsService)),
    );
    const sessions = Context.get(yield* Layer.build(layer), KernelSessions);
    const open = <Calls extends DeclaredCalls>(kernelExecution: KernelExecution<Calls>) =>
      sessions.open(kernelExecution, owner).pipe(Effect.provideService(FactoryDependency, { label: 'from-open' }));
    return { callRequests, open, sealCloses, statements };
  });

const violationRule = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return null;
  }
  for (const reason of exit.cause.reasons) {
    if (Cause.isDieReason(reason) && Schema.is(ExecutionRuleViolation)(reason.defect)) {
      return reason.defect.rule;
    }
  }
  return null;
};

const abortedReason = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return null;
  }
  for (const reason of exit.cause.reasons) {
    if (Cause.isFailReason(reason) && Schema.is(TransactionAborted)(reason.error)) {
      return reason.error.reason;
    }
  }
  return null;
};

const begins = (statements: readonly string[]) => statements.filter((statement) => /^begin/iu.test(statement)).length;

it.effect('a transaction inside a transaction dies nested_transaction and rolls back', () =>
  Effect.scoped(
    Effect.gen(function* nestedTransaction() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      const exit = yield* Effect.exit(
        session.capabilities.transaction(() => session.capabilities.transaction(() => Effect.void)),
      );
      expect(violationRule(exit)).toBe('nested_transaction');
      expect(harness.statements.at(-1)).toMatch(/^rollback/iu);
      // The open flag is cleared, so the next transaction opens normally.
      expect(yield* session.capabilities.transaction(() => Effect.succeed('next'))).toBe('next');
    }),
  ),
);

it.effect('a call while a transaction is open dies call_inside_transaction', () =>
  Effect.scoped(
    Effect.gen(function* callInsideTransaction() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      const exit = yield* Effect.exit(
        session.capabilities.transaction(() => session.capabilities.call('restrictions', { subject: 'customer' })),
      );
      expect(violationRule(exit)).toBe('call_inside_transaction');
      expect(harness.callRequests).toHaveLength(0);
    }),
  ),
);

it.effect('a call interrupted right after admission leaves nothing in flight', () =>
  Effect.scoped(
    Effect.gen(function* callInterruptedAtFork() {
      const harness = yield* makeHarness([], () => Effect.never);
      const session = yield* harness.open(execution(calls));
      yield* Effect.race(session.capabilities.call('restrictions', { subject: 'customer' }), Effect.void);
      expect(yield* session.capabilities.transaction(() => Effect.succeed('after'))).toBe('after');
      yield* session.settle;
      expect((yield* session.callRecords).map((record) => record.outcome)).toStrictEqual(['Interrupted']);
    }),
  ),
);

it.effect('a transaction interrupted right after admission leaves none open', () =>
  Effect.scoped(
    Effect.gen(function* transactionInterruptedAtFork() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      yield* Effect.race(
        session.capabilities.transaction(() => Effect.never),
        Effect.void,
      );
      expect(yield* session.capabilities.transaction(() => Effect.succeed('after'))).toBe('after');
      expect(callAnswer(yield* session.capabilities.call('restrictions', { subject: 'customer' }))).toStrictEqual(
        Option.some({ outcome: 'CURRENT' }),
      );
    }),
  ),
);

it.effect('a transaction while a forked call is in flight dies call_inside_transaction', () =>
  Effect.scoped(
    Effect.gen(function* transactionDuringCall() {
      const started = yield* Deferred.make<null>();
      const release = yield* Deferred.make<null>();
      const harness = yield* makeHarness([], (request) =>
        Effect.gen(function* slowCall() {
          yield* Deferred.succeed(started, null);
          yield* Deferred.await(release);
          return {
            outcome: { _tag: 'NotFound' as const, reason: 'none' },
            record: {
              callerKind: 'person' as const,
              durationMillis: 5,
              name: request.name,
              outcome: 'NotFound' as const,
              placement: request.placement,
              provider: request.declared.operation.provider,
              requirementKey: request.declared.requirementKey,
              route: 'Module' as const,
              sequence: request.sequence,
            },
          };
        }),
      );
      const session = yield* harness.open(execution(calls));
      const call = yield* Effect.forkChild(session.capabilities.call('restrictions', { subject: 'customer' }));
      yield* Deferred.await(started);
      const beginsBefore = begins(harness.statements);
      const exit = yield* Effect.exit(session.capabilities.transaction(() => Effect.void));
      expect(violationRule(exit)).toBe('call_inside_transaction');
      expect(begins(harness.statements)).toBe(beginsBefore);
      yield* Deferred.succeed(release, null);
      expect(Schema.is(CallNotFoundSchema)(yield* Fiber.join(call))).toBe(true);
      // Once the call answered, a transaction opens.
      yield* session.capabilities.transaction(() => Effect.void);
    }),
  ),
);

it.effect('a call by an undeclared name dies undeclared_call', () =>
  Effect.scoped(
    Effect.gen(function* undeclaredCall() {
      const harness = yield* makeHarness([]);
      const declared: DeclaredCalls = calls;
      const session = yield* harness.open(execution(declared));
      const exit = yield* Effect.exit(session.capabilities.call('missing', { subject: 'customer' }));
      expect(violationRule(exit)).toBe('undeclared_call');
      // An inherited key is not a declaration either.
      expect(violationRule(yield* Effect.exit(session.capabilities.call('toString', {})))).toBe('undeclared_call');
      expect(harness.callRequests).toHaveLength(0);
    }),
  ),
);

it.effect('a write call dies write_call_reserved', () =>
  Effect.scoped(
    Effect.gen(function* writeCall() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      const exit = yield* Effect.exit(
        session.capabilities.call('commit', { subject: 'customer' }, { idempotencyKey: commitKey }),
      );
      expect(violationRule(exit)).toBe('write_call_reserved');
      expect(harness.callRequests).toHaveLength(0);
    }),
  ),
);

it.effect('a capability used after the session closed dies capability_after_execution', () =>
  Effect.gen(function* afterExecution() {
    const harness = yield* Effect.scoped(makeHarness([]));
    const session = yield* Effect.scoped(harness.open(execution(calls)));
    const call = yield* Effect.exit(session.capabilities.call('restrictions', { subject: 'customer' }));
    const transaction = yield* Effect.exit(session.capabilities.transaction(() => Effect.void));
    expect(violationRule(call)).toBe('capability_after_execution');
    expect(violationRule(transaction)).toBe('capability_after_execution');
    expect(harness.callRequests).toHaveLength(0);
  }),
);

it.effect('an exhausted budget answers Unavailable for a call and budget_exhausted for a transaction', () =>
  Effect.scoped(
    Effect.gen(function* budgetExhaustion() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(
        execution(calls, { maxCalls: 1, maxDurationMillis: 600_000, maxTransactions: 1 }),
      );
      expect(Option.isSome(callAnswer(yield* session.capabilities.call('restrictions', { subject: 'a' })))).toBe(true);
      const spent = yield* session.capabilities.call('restrictions', { subject: 'b' });
      expect(Schema.is(CallUnavailableSchema)(spent) && !spent.retryable).toBe(true);
      yield* session.capabilities.transaction(() => Effect.void);
      const beginsBefore = begins(harness.statements);
      const exit = yield* Effect.exit(session.capabilities.transaction(() => Effect.void));
      expect(abortedReason(exit)).toBe('budget_exhausted');
      expect(begins(harness.statements)).toBe(beginsBefore);
      expect(harness.callRequests).toHaveLength(1);
      const records = yield* session.callRecords;
      expect(records.map(({ callerKind, outcome, sequence }) => ({ callerKind, outcome, sequence }))).toEqual([
        { callerKind: 'person', outcome: 'Ok', sequence: 1 },
        { callerKind: 'refused', outcome: 'Unavailable', sequence: 2 },
      ]);
      expect(yield* session.transactionCount).toBe(1);
    }),
  ),
);

it.effect('records a call before the first transaction as before and one after it as after', () =>
  Effect.scoped(
    Effect.gen(function* placement() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      yield* session.capabilities.call('restrictions', { subject: 'a' });
      const facts = yield* session.capabilities.transaction((_services, transactionFacts) =>
        Effect.succeed(transactionFacts),
      );
      yield* session.capabilities.call('restrictions', { subject: 'b' });
      expect(facts.sequence).toBe(1);
      expect(facts.operationAt.epochMilliseconds).toBe(operationTime.epochMilliseconds);
      expect(harness.callRequests.map(({ placement: where, sequence }) => ({ sequence, where }))).toEqual([
        { sequence: 1, where: 'before' },
        { sequence: 2, where: 'after' },
      ]);
      expect((yield* session.callRecords).map(({ placement: where }) => where)).toEqual(['before', 'after']);
    }),
  ),
);

it.effect('open fails owner_denied from the owner check and no capability exists', () =>
  Effect.scoped(
    Effect.gen(function* openDenied() {
      const harness = yield* makeHarness(['denied']);
      const exit = yield* Effect.exit(harness.open(execution(calls)));
      expect(abortedReason(exit)).toBe('owner_denied');
      expect(harness.callRequests).toHaveLength(0);
      // The owner check never commits.
      expect(harness.statements.at(-1)).toMatch(/^rollback/iu);
      expect(harness.statements.some((statement) => /^commit/iu.test(statement))).toBe(false);
    }),
  ),
);

it.effect('open fails owner_unavailable when the owner rule cannot answer', () =>
  Effect.scoped(
    Effect.gen(function* openUnavailable() {
      const harness = yield* makeHarness(['unavailable']);
      expect(abortedReason(yield* Effect.exit(harness.open(execution(calls))))).toBe('owner_unavailable');
    }),
  ),
);

it.effect('an owner denial the body swallowed stays: transactions fail at once and calls answer Forbidden', () =>
  Effect.scoped(
    Effect.gen(function* stickyDenial() {
      const harness = yield* makeHarness(['allowed', 'denied']);
      const session = yield* harness.open(execution(calls));
      const swallowed = yield* session.capabilities
        .transaction(() => Effect.succeed('ran'))
        .pipe(Effect.catchTag('TransactionAborted', (failure) => Effect.succeed(failure.reason)));
      expect(swallowed).toBe('owner_denied');
      expect(yield* session.ownerDenied).toBe(true);

      const beginsBefore = begins(harness.statements);
      const again = yield* Effect.exit(session.capabilities.transaction(() => Effect.succeed('ran')));
      expect(abortedReason(again)).toBe('owner_denied');
      expect(begins(harness.statements)).toBe(beginsBefore);

      const refused = yield* session.capabilities.call('restrictions', { subject: 'customer' });
      expect(Schema.is(CallForbiddenSchema)(refused)).toBe(true);
      expect(harness.callRequests).toHaveLength(0);
      const [record] = yield* session.callRecords;
      expect(record).toMatchObject({ callerKind: 'refused', outcome: 'Forbidden', placement: 'after' });
    }),
  ),
);

it.effect("the factory's requirements come from open's context", () =>
  Effect.scoped(
    Effect.gen(function* factoryRequirements() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      // Nothing provides FactoryDependency here: the session captured it when it opened.
      const label = yield* session.capabilities.transaction((services) => Effect.succeed(services.label));
      expect(label).toBe('from-open');
    }),
  ),
);

it.effect('a session_default transaction is a plain BEGIN, as main opens a read, and commits on success', () =>
  Effect.scoped(
    Effect.gen(function* transactionMode() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      const from = harness.statements.length;
      yield* session.capabilities.transaction(() => Effect.void);
      const statements = harness.statements.slice(from);
      expect(statements[0]).toMatch(/^begin$/iu);
      // No access mode or isolation is set: the session's defaults hold, as for every read on main.
      expect(statements.filter((statement) => /set transaction|read only|read write/iu.test(statement))).toEqual([]);
      const clock = statements.findIndex((statement) => statement.includes('statement_timestamp()'));
      const scopeInstall = statements.findIndex((statement) => statement.includes('set_config'));
      expect(scopeInstall).toBeGreaterThan(0);
      expect(clock).toBeGreaterThan(scopeInstall);
      expect(statements.at(-1)).toMatch(/^commit/iu);
      // Seal closed for the owner check and for the transaction.
      expect(harness.sealCloses.count).toBe(2);
    }),
  ),
);

it.effect('the executor services were built on dies transaction_ended when used after the body', () =>
  Effect.scoped(
    Effect.gen(function* servicesAfterBody() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      const { executor, prepared } = yield* session.capabilities.transaction((services) =>
        Effect.succeed({ executor: services.executor, prepared: services.executor.select().from(dataAccessEvents) }),
      );
      const before = harness.statements.length;
      // A query prepared inside the body, and one built after it: both refused where they execute.
      expect(violationRule(yield* Effect.exit(Effect.suspend(() => prepared)))).toBe('transaction_ended');
      expect(violationRule(yield* Effect.exit(Effect.suspend(() => executor.select().from(dataAccessEvents))))).toBe(
        'transaction_ended',
      );
      expect(harness.statements.slice(before)).toEqual([]);
    }),
  ),
);

it.effect('a forked fiber of the body finishes before the transaction commits', () =>
  Effect.scoped(
    Effect.gen(function* forkedStatement() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      const order: string[] = [];
      yield* session.capabilities.transaction(() =>
        Effect.forkChild(
          Effect.gen(function* forkedWork() {
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            order.push(`forked:${String(harness.statements.at(-1))}`);
          }),
        ).pipe(Effect.asVoid),
      );
      expect(order).toHaveLength(1);
      expect(order[0]).not.toMatch(/commit/iu);
      expect(harness.statements.at(-1)).toMatch(/^commit/iu);
      expect(Predicate.isString(order[0])).toBe(true);
    }),
  ),
);

it.effect('a body that fails interrupts the children it left running and answers its failure at once', () =>
  Effect.scoped(
    Effect.gen(function* failingBodyWithChild() {
      const harness = yield* makeHarness([]);
      const session = yield* harness.open(execution(calls));
      const started = yield* Deferred.make<null>();
      const childInterrupted = yield* Deferred.make<null>();
      // A failed body that waited for its child would never answer here.
      const exit = yield* Effect.exit(
        session.capabilities.transaction(() =>
          Effect.forkChild(
            Deferred.succeed(started, null).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(childInterrupted, null)),
            ),
          ).pipe(Effect.andThen(Deferred.await(started)), Effect.andThen(Effect.fail('body failed' as const))),
        ),
      );
      expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()).toStrictEqual(
        Option.some('body failed'),
      );
      expect(yield* Deferred.isDone(childInterrupted)).toBe(true);
      expect(harness.statements.at(-1)).toMatch(/^rollback/iu);
    }),
  ),
);
