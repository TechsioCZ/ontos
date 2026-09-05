// expect-count: 1
// Real scripts are .mts; the rule must reach that extension too.
import { Effect } from "effect";

const program = Effect.succeed(1);

const nested = async (): Promise<number> => await Effect.runPromise(program);

void nested;
