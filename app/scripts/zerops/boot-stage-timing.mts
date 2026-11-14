import { Clock, Console, Duration, Effect, Exit } from 'effect';

/** The one prefix every boot stage line carries, so a deploy's log is searchable for the whole boot at once. */
export const BOOT_TIMING_PREFIX = '[boot-timing]';

/** `[boot-timing] stage=<name> ms=<elapsed> outcome=<ok|failed|interrupted>`; one line, whatever the stage's end. */
export const bootTimingLine = (stage: string, millis: number, outcome: 'failed' | 'interrupted' | 'ok'): string =>
  `${BOOT_TIMING_PREFIX} stage=${stage} ms=${String(Math.round(millis))} outcome=${outcome}`;

const outcomeOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return 'ok' as const;
  }
  return Exit.hasInterrupts(exit) ? ('interrupted' as const) : ('failed' as const);
};

/**
 * Times one boot stage on the monotonic clock and writes its line when the stage ends, success or not, without
 * changing its result. Stage names are fixed infrastructure names; never pass request or tenant data here.
 */
export const timedBootStage = (stage: string) =>
  Effect.fnUntraced(function* timeBootStage<Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) {
    const started = yield* Clock.monotonicTimeNanos;
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Clock.monotonicTimeNanos.pipe(
          Effect.flatMap((ended) =>
            Console.log(bootTimingLine(stage, Duration.toMillis(Duration.nanos(ended - started)), outcomeOf(exit))),
          ),
        ),
      ),
    );
  });
