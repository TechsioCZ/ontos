import { Cause, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AccessProjectionWriteError,
  projectionWriteRefusal,
  projectionWriteViolation,
} from '../../src/access/intent/projection-write-error.ts';

it('keeps a projection refusal readable at a Promise or test-runner boundary', () => {
  const failure = projectionWriteRefusal('access_projection_write_fence_refused', 'The tenant fence moved');
  expect(failure.message).toBe('access_projection_write_fence_refused: The tenant fence moved');
  expect(String(failure)).toContain('The tenant fence moved');
  const encoded = Schema.encodeSync(AccessProjectionWriteError)(failure);
  expect(encoded).toMatchObject({
    code: 'access_projection_write_fence_refused',
    reason: 'The tenant fence moved',
  });
  expect(Object.keys(encoded).toSorted()).toEqual(['_tag', 'code', 'reason']);
  expect(Schema.decodeUnknownSync(AccessProjectionWriteError)(encoded)).toEqual(failure);
});

it.effect('reports the reason when a scoped worker cleanup fails outside a test', () =>
  Effect.gen(function* failedWorkerCleanup() {
    const reason = 'access_projection_unavailable: The SpiceDB projection call did not complete safely: gRPC 14';
    const failure = projectionWriteViolation('access_projection_write_unavailable', [reason]);
    const exit = yield* Effect.scoped(Effect.addFinalizer(() => Effect.fail(failure).pipe(Effect.orDie))).pipe(
      Effect.exit,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain(`access_projection_write_unavailable: ${reason}`);
    }
  }),
);

it('includes every compiler violation without changing its structured fields', () => {
  const reasons = ['The first scope is unavailable', 'The second scope is unavailable'];
  const failure = projectionWriteViolation('access_projection_write_plan_refused', reasons);
  expect(failure.message).toBe(`access_projection_write_plan_refused: ${reasons.join('; ')}`);
  expect(failure.reason).toBe(reasons[0]);
  expect(failure.violations).toEqual(reasons);
});
