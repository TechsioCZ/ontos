// Dynamic computed access and look-alike strings/keys must never report.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;
declare const key: "runPromise" | "runSync";

export const dynamic = Effect.sync(() => {
  const table: Record<string, (value: unknown) => unknown> = {
    runPromise: (value) => value,
    runSync: (value) => value,
  };
  return table[key]?.(program);
});

export const described = Effect.sync(() => `Effect.runPromise(${String(program)})`);

export const labelled = Effect.sync(() => ({ runPromise: "Effect.runSync", runSync: 1 }));
