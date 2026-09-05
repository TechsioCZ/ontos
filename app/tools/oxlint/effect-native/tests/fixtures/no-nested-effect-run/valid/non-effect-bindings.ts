// Look-alike members on non-Effect bindings must never be run sites.
import { Effect } from "effect";

declare const program: Effect.Effect<void>;

const runner = { runPromise: async (value: unknown): Promise<unknown> => value };

export const startup = async (): Promise<void> => {
  await runner.runPromise(program);
};

export const scheduled = setTimeout(() => {
  void Effect.runPromise(program);
}, 10);

export const doubled = [1, 2, 3].map((value) => value * 2);
