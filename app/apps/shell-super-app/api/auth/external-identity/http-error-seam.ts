import { Cause, Effect } from 'effect';

export const safeExternalIdentityHttpEffect =
  <DefectFailure>(defectFailure: () => DefectFailure) =>
  <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure | DefectFailure, Requirements> =>
    effect.pipe(
      Effect.catchCauseIf(Cause.hasDies, (cause) =>
        Effect.logError('Unexpected external identity HTTP defect', cause).pipe(
          Effect.andThen(Effect.fail(defectFailure())),
        ),
      ),
    );
