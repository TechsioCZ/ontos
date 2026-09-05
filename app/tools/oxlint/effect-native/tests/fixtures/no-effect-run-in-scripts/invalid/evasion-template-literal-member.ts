// expect-count: 1
// B3/A1 evasion: a computed member written as a template literal instead of a string literal.
import { Effect } from "effect";

const program = Effect.succeed(1);

const runIt = (): Promise<number> => Effect[`runPromise`](program);

void runIt;
