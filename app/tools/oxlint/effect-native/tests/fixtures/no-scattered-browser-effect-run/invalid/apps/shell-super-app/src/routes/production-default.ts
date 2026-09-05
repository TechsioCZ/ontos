// expect-count: 1
import { Effect } from "effect";
export const load = () => Effect.runPromise(Effect.succeed("value"));
