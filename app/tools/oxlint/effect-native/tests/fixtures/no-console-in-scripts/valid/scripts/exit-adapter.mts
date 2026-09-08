// D tier / "existing patterns to preserve": one small process-exit adapter at the executable edge.
import { Effect, Exit } from "effect";

import { verifyRole } from "./effect-logging.mts";

const exit = await Effect.runPromiseExit(verifyRole("ontos_runtime"));
process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
