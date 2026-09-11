// expect-count: 3
import { Effect } from "@modern-js/bff-effect/effect-client";
import { Effect as E } from "@modern-js/bff-effect/effect-client";
import * as Client from "@modern-js/bff-effect/effect-client";

export const direct = Effect.runSync(Effect.succeed(1));
export const aliased = E.runSync(E.succeed(1));
export const namespace = Client.Effect.runSync(Client.Effect.succeed(1));
