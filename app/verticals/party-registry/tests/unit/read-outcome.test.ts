import { Effect } from 'effect';
import { assert, it } from 'effect-rstest';
import { readDetailResult, readUnavailable, requireReadValue } from '../../src/api/read-outcome.ts';

it.effect('detail lookup preserves the value and one-result evidence', () => {
  const value = { revision: 7 };
  return requireReadValue('Missing record')({ _tag: 'found', value }).pipe(
    Effect.map(readDetailResult),
    Effect.tap((output) =>
      Effect.sync(() => {
        assert.equal(output.result, value);
        assert.deepEqual(output.evidence, { resultCount: 1 });
      }),
    ),
    Effect.asVoid,
  );
});

it.effect(
  'missing detail produces the caller-specific typed failure without result evidence',
  () => {
    const reason = 'The Official Identifier does not exist';
    return requireReadValue(reason)({ _tag: 'not_found' }).pipe(
      Effect.map(() => assert.fail('Missing lookup must not succeed')),
      Effect.catchTag('ReadHandlerNotFound', (failure) =>
        Effect.sync(() => {
          assert.equal(failure.code, 'read_handler_not_found');
          assert.equal(failure.reason, reason);
        }),
      ),
    );
  },
);

it('unavailable mapping retains hidden diagnostic cause and descriptor policy', () => {
  const cause = { diagnostic: 'private' };
  for (const configurable of [false, true]) {
    const failure = readUnavailable('Read storage unavailable', configurable)(cause);
    assert.equal(failure.code, 'read_handler_unavailable');
    assert.equal(failure.reason, 'Read storage unavailable');
    assert.deepEqual(Object.getOwnPropertyDescriptor(failure, 'cause'), {
      configurable,
      enumerable: false,
      value: cause,
      writable: false,
    });
    assert.equal(JSON.stringify(failure).includes('private'), false);
  }
});
