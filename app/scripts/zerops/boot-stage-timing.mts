import { Clock, Console, Duration, Effect, Exit } from 'effect';

/** The one prefix every boot stage line carries, so a deploy's log is searchable for the whole boot at once. */
export const BOOT_TIMING_PREFIX = '[boot-timing]';

/** `[boot-timing] stage=<name> ms=<elapsed> outcome=<ok|failed|interrupted>`; one line, whatever the stage's end. */
export const bootTimingLine = (stage: string, millis: number, outcome: 'failed' | 'interrupted' | 'ok'): string =>
  `${BOOT_TIMING_PREFIX} stage=${stage} ms=${String(Math.round(millis))} outcome=${outcome}`;

/** A stage's outcome: its exit, and for a step that reports failure in its result, that result. */
export const bootStageOutcome = <A, E>(exit: Exit.Exit<A, E>, succeeded: (value: A) => boolean) => {
  if (Exit.isSuccess(exit)) {
    return succeeded(exit.value) ? ('ok' as const) : ('failed' as const);
  }
  return Exit.hasInterrupts(exit) ? ('interrupted' as const) : ('failed' as const);
};

const timeStage = <Value, Failure, Requirements>(
  stage: string,
  effect: Effect.Effect<Value, Failure, Requirements>,
  succeeded: (value: Value) => boolean,
) =>
  Effect.gen(function* timeBootStage() {
    const started = yield* Clock.monotonicTimeNanos;
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Clock.monotonicTimeNanos.pipe(
          Effect.flatMap((ended) => {
            const millis = Duration.toMillis(Duration.nanos(ended - started));
            return Console.log(bootTimingLine(stage, millis, bootStageOutcome(exit, succeeded)));
          }),
        ),
      ),
    );
  });

/**
 * Times one boot stage on the monotonic clock and writes its line when the stage ends, without changing its result.
 * The outcome is the stage's own: apply it to the step itself, never after a handler that turns its failure into a
 * success. Stage names are fixed infrastructure names; never pass request or tenant data here.
 */
export const timedBootStage =
  (stage: string) =>
  <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    timeStage(stage, effect, () => true);

/**
 * For a step that reports its own failure in its result instead of failing (it must never hold the boot): the line
 * says `failed` when `succeeded` rejects the result.
 */
export const timedBootStageJudged =
  <Value,>(stage: string, succeeded: (value: Value) => boolean) =>
  <Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    timeStage(stage, effect, succeeded);
