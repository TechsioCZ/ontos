import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ExecutionRuleViolation } from '../../src/execution/contract.ts';
import {
  CallUnavailableSchema,
  callAnswer,
  callOkSchema,
  declaredCall,
  declaredWriteCall,
  moduleOperation,
} from '../../src/sdk/index.ts';
import type { DeclaredCalls } from '../../src/sdk/index.ts';
import { ExecutionStandInAnswerMissing, makeExecutionStandIn } from '../../src/testing/sdk.ts';

/**
 * The capability stand-ins a module test drives its `{ run }` function with: typed answers per declared
 * call, and the kernel's runtime rule (no call while a transaction is open, no nested transaction).
 */

const ResolveResponseSchema = Schema.Struct({ ok: Schema.Boolean });
const resolve = moduleOperation({
  kind: 'read',
  path: '/reads/resolve',
  provider: { entrypointKey: 'provider.alpha.api.resolve', moduleId: 'provider.alpha', schemaVersion: '1' },
  request: Schema.Struct({ id: Schema.String }),
  response: ResolveResponseSchema,
});
const calls = { resolve: declaredCall(resolve, 'consumer.alpha.requirement.resolve') } as const;
const operationAt = DateTime.makeUnsafe('2026-03-01T00:00:00.000Z');

const isViolation = Schema.is(ExecutionRuleViolation);
const ruleOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return 'none';
  }
  const error = Cause.squash(exit.cause);
  return isViolation(error) ? error.rule : 'other';
};

it.effect('answers declared calls with their typed outcomes and records every step in order', () =>
  Effect.gen(function* standInSteps() {
    const standIn = makeExecutionStandIn(calls, {
      answers: {
        resolve: ({ id }) => Effect.succeed(callOkSchema(ResolveResponseSchema).make({ value: { ok: id === 'a' } })),
      },
      operationAt,
      services: (sequence) => ({ sequence }),
    });
    const outcome = yield* standIn.call('resolve', { id: 'a' });
    const seen = yield* standIn.transaction((services, facts) => Effect.succeed([services.sequence, facts.sequence]));
    const again = yield* standIn.transaction((services) => Effect.succeed(services.sequence));
    expect(callAnswer(outcome)).toEqual(Option.some({ ok: true }));
    expect(seen).toEqual([1, 1]);
    expect(again).toBe(2);
    expect(standIn.steps).toEqual([
      { input: { id: 'a' }, kind: 'call', name: 'resolve' },
      { kind: 'begin', sequence: 1 },
      { kind: 'end', sequence: 1 },
      { kind: 'begin', sequence: 2 },
      { kind: 'end', sequence: 2 },
    ]);
  }),
);

it.effect('dies as the kernel does on a call inside a transaction, a nested transaction and an undeclared call', () =>
  Effect.gen(function* standInRules() {
    const standIn = makeExecutionStandIn(calls, {
      answers: { resolve: () => Effect.succeed(CallUnavailableSchema.make({ reason: 'down', retryable: true })) },
      operationAt,
      services: () => ({}),
    });
    const inside = yield* Effect.exit(standIn.transaction(() => standIn.call('resolve', { id: 'a' })));
    const nested = yield* Effect.exit(standIn.transaction(() => standIn.transaction(() => Effect.void)));
    // Typed over any declared calls, so a name the descriptor does not declare compiles and reaches the rule.
    const untyped = makeExecutionStandIn<object, DeclaredCalls>(calls, {
      answers: {},
      operationAt,
      services: () => ({}),
    });
    const undeclared = yield* Effect.exit(untyped.call('other', { id: 'a' }));
    expect(ruleOf(inside)).toBe('call_inside_transaction');
    expect(ruleOf(nested)).toBe('nested_transaction');
    expect(ruleOf(undeclared)).toBe('undeclared_call');
    // A transaction that ended lets the next call run.
    const after = yield* standIn.call('resolve', { id: 'a' });
    expect(Schema.is(CallUnavailableSchema)(after)).toBe(true);
    expect(Option.isNone(callAnswer(after))).toBe(true);
  }),
);

it.effect('dies call_inside_transaction for a transaction while a forked call has not answered', () =>
  Effect.gen(function* standInCallInFlight() {
    const release = yield* Deferred.make<null>();
    const standIn = makeExecutionStandIn(calls, {
      answers: {
        resolve: () =>
          Deferred.await(release).pipe(Effect.as(CallUnavailableSchema.make({ reason: 'slow', retryable: true }))),
      },
      operationAt,
      services: () => ({}),
    });
    const call = yield* Effect.forkChild(standIn.call('resolve', { id: 'a' }), { startImmediately: true });
    expect(ruleOf(yield* Effect.exit(standIn.transaction(() => Effect.void)))).toBe('call_inside_transaction');
    yield* Deferred.succeed(release, null);
    yield* Fiber.join(call);
    // Once it answered, or once it was interrupted, a transaction opens.
    yield* standIn.transaction(() => Effect.void);
    const stalled = makeExecutionStandIn(calls, {
      answers: { resolve: () => Effect.never },
      operationAt,
      services: () => ({}),
    });
    const pending = yield* Effect.forkChild(stalled.call('resolve', { id: 'b' }), { startImmediately: true });
    yield* Fiber.interrupt(pending);
    expect(yield* stalled.transaction(() => Effect.succeed('after'))).toBe('after');
  }),
);

it.effect('ends a transaction whose body throws before it returns an effect', () =>
  Effect.gen(function* standInThrowingBody() {
    const standIn = makeExecutionStandIn(calls, { answers: {}, operationAt, services: () => ({}) });
    const thrown = yield* Effect.exit(
      standIn.transaction((): Effect.Effect<void> => {
        throw new Error('built badly');
      }),
    );
    expect(Exit.isFailure(thrown)).toBe(true);
    expect(yield* standIn.transaction(() => Effect.succeed('next'))).toBe('next');
    expect(standIn.steps).toEqual([
      { kind: 'begin', sequence: 1 },
      { kind: 'end', sequence: 1 },
      { kind: 'begin', sequence: 2 },
      { kind: 'end', sequence: 2 },
    ]);
  }),
);

it.effect('dies with the call name when the test gives no answer for a declared call', () =>
  Effect.gen(function* standInMissingAnswer() {
    const standIn = makeExecutionStandIn(calls, { answers: {}, operationAt, services: () => ({}) });
    const exit = yield* Effect.exit(standIn.call('resolve', { id: 'a' }));
    const missing = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(Schema.is(ExecutionStandInAnswerMissing)(missing)).toBe(true);
    expect(standIn.steps).toEqual([]);
  }),
);

it.effect('dies write_call_reserved on a write call, as the kernel does', () =>
  Effect.gen(function* standInWriteCall() {
    const reserve = moduleOperation({
      kind: 'write',
      path: '/actions/reserve',
      provider: { entrypointKey: 'provider.alpha.api.reserve', moduleId: 'provider.alpha', schemaVersion: '1' },
      request: Schema.Struct({ id: Schema.String }),
      response: ResolveResponseSchema,
    });
    const writeCalls = {
      reserve: declaredWriteCall(reserve, 'consumer.alpha.requirement.reserve', 'resolve'),
      resolve: calls.resolve,
    };
    const standIn = makeExecutionStandIn<object, DeclaredCalls>(writeCalls, {
      answers: {},
      operationAt,
      services: () => ({}),
    });
    const exit = yield* Effect.exit(standIn.call('reserve', { id: 'a' }));
    expect(ruleOf(exit)).toBe('write_call_reserved');
    expect(standIn.steps).toEqual([]);
  }),
);
