// A destructured `runPromise` from a non-Effect object is not an Effect run site, even inside Effect code.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

const runtime = { runPromise: async (value: unknown): Promise<unknown> => value };
const { runPromise } = runtime;

export const Panel = (): JSX.Element => {
  const onClick = (): void => {
    void runPromise(program);
  };
  return (
    <button onClick={onClick} type="button">
      go
    </button>
  );
};

export const inside = Effect.sync(() => {
  void runPromise(program);
});
