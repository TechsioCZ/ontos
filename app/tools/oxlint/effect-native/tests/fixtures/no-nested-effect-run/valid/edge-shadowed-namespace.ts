// A parameter named `Effect` shadows the import; its members are not Effect run sites.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

interface FakeRunner {
  readonly runPromise: (value: unknown) => void;
}

export const shadowed = Effect.sync(() => {
  const call = (Effect: FakeRunner): void => {
    Effect.runPromise(program);
  };
  call({ runPromise: () => undefined });
});
