import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { Cause, Result, Schema } from 'effect';
import {
  getOutboxPersistenceCause,
  OutboxPersistenceError,
  outboxPersistenceError,
} from '../../src/outbox/errors.ts';

void test('isolates persistence causes and preserves their Cause identity and shape', () => {
  const firstCause = new Error('first persistence cause');
  const secondCause = new Error('second persistence cause');
  const firstFailure = outboxPersistenceError(firstCause);
  const secondFailure = outboxPersistenceError(secondCause);

  const firstObserved = getOutboxPersistenceCause(firstFailure);
  const secondObserved = getOutboxPersistenceCause(secondFailure);
  assert.ok(firstObserved);
  assert.ok(secondObserved);
  assert.deepEqual(firstObserved, Cause.die(firstCause));
  assert.deepEqual(secondObserved, Cause.die(secondCause));

  const firstDie = Cause.findDie(firstObserved);
  const secondDie = Cause.findDie(secondObserved);
  assert.equal(Result.isSuccess(firstDie), true);
  assert.equal(Result.isSuccess(secondDie), true);
  if (Result.isSuccess(firstDie) && Result.isSuccess(secondDie)) {
    assert.equal(firstDie.success.defect, firstCause);
    assert.equal(secondDie.success.defect, secondCause);
    assert.notEqual(firstDie.success.defect, secondCause);
    assert.notEqual(secondDie.success.defect, firstCause);
  }

  const directlyConstructed = new OutboxPersistenceError({
    code: 'outbox_persistence_failed',
    reason: 'direct construction has no side-channel cause',
  });
  assert.equal(getOutboxPersistenceCause(directlyConstructed), undefined);
});

void test('keeps persistence causes out of Schema encoding and inspection', () => {
  const failure = outboxPersistenceError(new Error('secret persistence cause'));
  const encoded = Schema.encodeSync(OutboxPersistenceError)(failure);
  const expected = {
    _tag: 'OutboxPersistenceError',
    code: 'outbox_persistence_failed',
    reason: 'The Outbox Worker persistence operation failed',
  };

  assert.deepEqual(encoded, expected);
  assert.equal(JSON.stringify(failure), JSON.stringify(expected));
  assert.doesNotMatch(
    inspect(failure, { depth: 10, showHidden: true }),
    /secret persistence cause/u,
  );
});
