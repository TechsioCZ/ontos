import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { BOOT_TIMING_PREFIX, bootTimingLine, timedBootStage } from '../zerops/boot-stage-timing.mts';

class StageFailure extends Schema.TaggedError<StageFailure>()('StageFailure', { reason: Schema.String }) {}

it('writes one searchable line per stage: name, whole milliseconds, outcome', () => {
  expect(bootTimingLine('host.migrator', 21_499.6, 'ok')).toBe(
    `${BOOT_TIMING_PREFIX} stage=host.migrator ms=21500 outcome=ok`,
  );
  expect(bootTimingLine('host.publish', 0.2, 'failed')).toBe(
    `${BOOT_TIMING_PREFIX} stage=host.publish ms=0 outcome=failed`,
  );
});

it.effect('times a stage without changing its result, and passes a failure through unchanged', () =>
  Effect.gen(function* timesStages() {
    expect(yield* Effect.succeed(7).pipe(timedBootStage('test.ok'))).toBe(7);
    const failed = yield* Effect.exit(
      Effect.fail(new StageFailure({ reason: 'refused' })).pipe(timedBootStage('test.failed')),
    );
    expect(Exit.isFailure(failed)).toBe(true);
  }),
);
