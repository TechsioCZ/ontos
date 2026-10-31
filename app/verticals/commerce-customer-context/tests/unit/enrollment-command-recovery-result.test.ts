import { ActionExecutionResolutionSchema } from '@app/core-runtime';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { enrollmentCommandRecoveryResult } from '../../api/enrollment-command-recovery.ts';
import { EnrollmentCommandRecoveryResultSchema } from '../../shared/enrollment-command-recovery-api.ts';

const ensureAction = 'commerce.customer-context.ensure-retail-customer-profile';
const bindAction = 'commerce.customer-context.bind-retail-portal-profile';
const invocationId = '12320000-0000-4000-8000-000000000001';
const strictResult = Schema.decodeUnknownResult(EnrollmentCommandRecoveryResultSchema, { onExcessProperty: 'error' });

it.effect('publishes the native committed verdict only after checking its exact requested Action key', () =>
  Effect.gen(function* committedResult() {
    for (const actionKey of [ensureAction, bindAction] as const) {
      const native = Schema.decodeUnknownSync(ActionExecutionResolutionSchema)({
        actionKey,
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
      });
      // The native result is not itself the closed public DTO.
      expect(Result.isFailure(strictResult(native))).toBe(true);
      const result = yield* enrollmentCommandRecoveryResult(actionKey, native);
      expect(result).toStrictEqual({ invocationId, retryCommand: false, state: 'COMMITTED' });
      expect(Result.isSuccess(strictResult(result))).toBe(true);
      expect(native).toHaveProperty('actionKey', actionKey);
    }
  }),
);

it.effect('rejects a committed verdict naming another Action rather than discarding that mismatch', () =>
  Effect.gen(function* foreignCommittedResult() {
    const native = Schema.decodeUnknownSync(ActionExecutionResolutionSchema)({
      actionKey: bindAction,
      invocationId,
      retryCommand: false,
      state: 'COMMITTED',
    });
    const failure = yield* Effect.flip(enrollmentCommandRecoveryResult(ensureAction, native));
    expect(failure).toMatchObject({ code: 'enrollment_unavailable', status: 503 });
  }),
);

it.effect('preserves every non-committed native verdict without manufacturing commit authority', () =>
  Effect.gen(function* otherResults() {
    const candidates = [
      { retryCommand: true, state: 'NOT_STARTED' },
      { invocationId, retryCommand: true, state: 'RETRYABLE' },
      { invocationId, retryCommand: false, state: 'RUNNING' },
      { invocationId, retryCommand: false, state: 'REJECTED' },
    ] as const;
    for (const candidate of candidates) {
      const native = Schema.decodeUnknownSync(ActionExecutionResolutionSchema)(candidate);
      expect(yield* enrollmentCommandRecoveryResult(ensureAction, native)).toStrictEqual(candidate);
    }
  }),
);

it.effect('retains strict rejection of excess data on non-committed native verdicts', () =>
  Effect.gen(function* excessNativeResult() {
    const native = Schema.decodeUnknownSync(ActionExecutionResolutionSchema)({
      invocationId,
      retryCommand: false,
      state: 'RUNNING',
    });
    const excess = { ...native, confidential: 'not-published' };
    const failure = yield* Effect.flip(enrollmentCommandRecoveryResult(ensureAction, excess));
    expect(failure).toMatchObject({ code: 'enrollment_unavailable', status: 503 });
  }),
);
