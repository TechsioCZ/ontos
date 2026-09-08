// expect-count: 2
import { Effect as E, pipe } from "effect";

const program = E.succeed(1);

// Point-free run reference inside a helper: still a root fiber, still off the edge.
const runIt = (): Promise<number> => pipe(program, E.runPromise);

// Computed member access does not hide the run either.
const runOther = (): number => E["runSync"](program);

void runIt;
void runOther;
