// @effect-diagnostics asyncFunction:off unsafeEffectTypeAssertion:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { Cause, Effect, Logger, Redacted } from 'effect';
import {
  getActionInvocationPersistenceFailureCause,
  getActionTransactionFailureCause,
  logActionInvocationPersistenceFailureCause,
  logActionTransactionFailureCause,
  makeActionRepository,
} from '../../src/actions/repository.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../src/db/types.ts';

void test('repository log sinks redact provider diagnostics while retaining internal causes and safe metadata', async () => {
  const credential = 'synthetic-repository-password-do-not-log';
  const providerError = new Error(`postgresql://test:${credential}@localhost/test`);
  // Only the methods that fail are needed; no database connection is created.
  const executor = {
    select: () => {
      throw providerError;
    },
    transaction: () => Promise.reject(providerError),
  } as unknown as CoreDatabaseExecutor & CoreTransaction;
  const repository = makeActionRepository();
  const persistenceFailure = await Effect.runPromise(
    repository.lockInvocation(executor, 'invocation-test').pipe(Effect.flip),
  );
  const transactionFailure = await Effect.runPromise(
    repository
      .rejectPermissionDenied(executor, {
        actionInvocationId: 'invocation-test',
        actionKey: 'core.test',
        auditProfile: 'standard',
        principal: {
          authMethod: 'session',
          principalId: 'principal-test',
          tenantId: 'tenant-test',
        },
        transport: { correlationId: 'correlation-test' },
      })
      .pipe(Effect.flip),
  );
  assert.equal(transactionFailure._tag, 'ActionTransactionError');
  if (transactionFailure._tag !== 'ActionTransactionError') {
    assert.fail('Expected a transaction failure');
  }

  const messages: unknown[][] = [];
  const rendered: string[] = [];
  const logger = Logger.make((options) => {
    assert.ok(Array.isArray(options.message));
    messages.push(options.message);
    rendered.push(JSON.stringify(Logger.formatStructured.log(options)));
  });
  const annotations = { actionKey: 'core.test', invocationId: 'invocation-test' };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* logActionInvocationPersistenceFailureCause(persistenceFailure, annotations);
      yield* logActionTransactionFailureCause(
        transactionFailure,
        'Unexpected Action transaction failure',
        annotations,
      );
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))),
  );

  assert.equal(messages.length, 2);
  for (const [index, message] of messages.entries()) {
    assert.ok(Redacted.isRedacted(message[1]));
    assert.equal(inspect(message).includes(credential), false);
    assert.equal(JSON.stringify(message).includes(credential), false);
    assert.equal(rendered[index]?.includes(credential), false);
    assert.ok(rendered[index]?.includes('core.test'));
    assert.ok(rendered[index]?.includes('invocation-test'));
    assert.ok(rendered[index]?.includes('Unexpected Action'));
  }
  const persistenceCause = getActionInvocationPersistenceFailureCause(persistenceFailure);
  const transactionCause = getActionTransactionFailureCause(transactionFailure);
  assert.ok(persistenceCause);
  assert.ok(transactionCause);
  assert.equal(Cause.squash(persistenceCause), providerError);
  assert.equal(Cause.squash(transactionCause), providerError);
});
