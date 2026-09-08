// expect-count: 5
import { Effect } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

export class EntrypointLoader {
  static readonly warm = Effect.all([left, right]);

  readonly each = Effect.forEach(ids, load);

  static {
    void Effect.all([left, right]);
  }

  run(): Effect.Effect<readonly string[]> {
    return Effect.forEach(ids, load);
  }

  get lazy(): () => () => Effect.Effect<readonly number[]> {
    return () => () => Effect.all([left, right]);
  }
}
