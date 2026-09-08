// expect-count: 2
// Multi-hop value aliases and an alias of the root barrel's `.Effect` member resolve back to the
// same import.
import * as EffectLib from "effect";
import { Effect } from "effect";

declare const program: Effect.Effect<string>;

const First = Effect;
const Second = First;
const FromRoot = EffectLib.Effect;

export const a = (): Promise<string> => Second.runPromise(program);
export const b = (): string => FromRoot.runSync(program);
