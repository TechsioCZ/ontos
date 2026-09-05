// Audit D/B3: the same real Promise adapter survives imported/local aliases and wrappers.
import { promise as lift, runPromise as run } from "effect/Effect";
import * as library from "effect";
const promise = lift;
const program = promise((async () => 1) satisfies () => Promise<number>);
const tryPromise = library.Effect["tryPromise" as string];
const another = tryPromise({ ["try"]: async () => 2, catch: String } as const);
await run(program).finally(() => {});
await library.Effect.runPromise(another);
