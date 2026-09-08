// Test support delegates runtime ownership to the shared runner.
import { it } from "effect-rstest";
import { Effect } from "effect";

it.effect("uses the shared runner from test support", () => Effect.void);
