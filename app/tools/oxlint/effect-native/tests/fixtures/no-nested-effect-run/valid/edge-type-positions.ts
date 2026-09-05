// Type-only references to the run members are not run sites.
import { Effect } from "effect";
import type { Effect as EffectType } from "effect";

declare const program: EffectType.Effect<number>;

type Runner = typeof Effect.runPromise;

export interface Bridge {
  readonly run: typeof Effect.runPromiseExit;
}

export const described = Effect.sync((): string => {
  const runner: Runner | undefined = undefined;
  return String(runner) + String(program);
});
