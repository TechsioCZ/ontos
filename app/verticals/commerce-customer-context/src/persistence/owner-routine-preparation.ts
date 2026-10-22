import { ScopedRoutineInvocationError } from '@app/core-runtime';
import type { OwnerTransaction, ScopedRoutineInvoker } from '@app/core-runtime';
import { Effect, Option } from 'effect';

/** Each owner read gets a short scoped transaction; external evaluation never holds its connection. */
export const ownerRoutinePreparation = (transaction: OwnerTransaction): ScopedRoutineInvoker => ({
  invoke: (routine, values) =>
    transaction((owner) => owner.invoke(routine, values)).pipe(
      Effect.mapError((failure) =>
        failure._tag === 'ScopedRoutineInvocationError'
          ? failure
          : new ScopedRoutineInvocationError({
              code: 'scoped_routine_invocation_failed',
              constraint: Option.none(),
              ownerModuleKey: routine.ownerModuleKey,
              postgresCode: Option.none(),
              reason: failure.reason,
              routineKey: routine.routineKey,
            }),
      ),
    ),
});
