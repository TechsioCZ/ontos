// expect-count: 1
// Former harness paths must not bypass the shared runner.
import { Effect } from "effect";

export const result = Effect.runSync(Effect.succeed(1));
