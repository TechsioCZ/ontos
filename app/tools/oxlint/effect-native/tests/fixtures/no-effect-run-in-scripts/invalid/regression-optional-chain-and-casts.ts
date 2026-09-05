// expect-count: 4
// Syntactic disguises that must not hide a nested run.
import { Effect } from "effect";

const program = Effect.succeed(1);

const viaOptional = (): Promise<number> => Effect?.runPromise(program);
const viaSatisfies = (): Promise<number> => (Effect.runPromise satisfies typeof Effect.runPromise)(program);
const viaNonNull = (): number => Effect.runSync!(program);
const viaSequence = (): number => (0, Effect.runSync)(program);

void viaOptional;
void viaSatisfies;
void viaNonNull;
void viaSequence;
