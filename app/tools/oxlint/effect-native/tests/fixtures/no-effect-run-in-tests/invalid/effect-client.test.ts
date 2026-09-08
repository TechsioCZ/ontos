// expect-count: 3
import { Effect } from "@modern-js/plugin-bff/effect-client";
import { Effect as E } from "@modern-js/plugin-bff/effect-client";
import * as Client from "@modern-js/plugin-bff/effect-client";

export const direct = Effect.runSync(Effect.succeed(1));
export const aliased = E.runSync(E.succeed(1));
export const namespace = Client.Effect.runSync(Client.Effect.succeed(1));
