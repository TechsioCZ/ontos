import { Context } from 'effect';
import type { Effect } from 'effect';

export class Sleeper extends Context.Service<
  Sleeper,
  {
    readonly sleep: (ms: number) => Effect.Effect<void>;
  }
>()('@app/effect-rstest/tests/support/sleeper') {}
