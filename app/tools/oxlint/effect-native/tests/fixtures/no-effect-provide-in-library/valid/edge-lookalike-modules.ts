// Module specifiers that only look like `effect`: neither is the Effect namespace.
import { Effect } from "effect-http";
import { Effect as LocalEffect } from "./local-effect.ts";

declare const program: unknown;
declare const RequirementsLayer: never;

export const a = Effect.provide(program, RequirementsLayer);
export const b = LocalEffect.provideService(program, RequirementsLayer);
