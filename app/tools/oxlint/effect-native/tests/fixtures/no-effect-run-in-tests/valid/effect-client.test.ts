import { Effect } from "@modern-js/plugin-bff/effect-client";
import { Effect as E } from "@modern-js/plugin-bff/effect-client";
import * as Client from "@modern-js/plugin-bff/effect-client";

export const direct = () => Effect.succeed(1);
export const aliased = () => E.succeed(1);
export const namespace = () => Client.Effect.succeed(1);
