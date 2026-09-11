import { Effect } from "@modern-js/bff-effect/effect-client";
import { Effect as E } from "@modern-js/bff-effect/effect-client";
import * as Client from "@modern-js/bff-effect/effect-client";

export const direct = () => Effect.succeed(1);
export const aliased = () => E.succeed(1);
export const namespace = () => Client.Effect.succeed(1);
