// expect-count: 2
// B3/A1 evasion: the whole package is imported as one namespace and then re-bound to a local, so no
// `Effect.run*` member expression is ever written literally. Both helpers still start root fibers.
import * as Fx from "effect";

const program = Fx.Effect.succeed(1);
const Runner = Fx.Effect;

const loadDatabase = async (): Promise<number> => await Fx.Effect.runPromise(program);
const loadSpice = (): number => Runner.runSync(program);

void loadDatabase;
void loadSpice;
