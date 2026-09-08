// expect-count: 2
// TSX: run sites hidden in a JSX handler and in an async generator body.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

export const widget = Effect.sync(() => {
  const onClick = (): void => {
    void Effect.runPromise(program);
  };
  return (
    <button onClick={onClick} type="button">
      go
    </button>
  );
});

export const pump = Effect.sync(() => {
  async function* drain(): AsyncGenerator<number> {
    yield await Effect.runPromise(program);
  }
  return drain;
});
