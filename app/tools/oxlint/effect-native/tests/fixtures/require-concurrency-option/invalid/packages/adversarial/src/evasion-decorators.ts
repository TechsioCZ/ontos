// expect-count: 2
import { Effect } from 'effect';

declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

declare function bind(value: unknown): (target: unknown, context: unknown) => void;

@bind(Effect.all([left, right]))
class Decorated {
  @bind(Effect.all([left, right]))
  run(): void {}
}

export { Decorated };
