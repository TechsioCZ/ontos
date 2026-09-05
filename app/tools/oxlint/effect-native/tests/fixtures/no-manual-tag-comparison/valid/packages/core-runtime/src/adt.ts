import { Exit, Option, Result } from "effect";

/** Effect's own ADT tags belong to `no-raw-effect-adt-tag-check`; this rule must stay silent. */
export const isFailure = (exit: Exit.Exit<number, string>): boolean => exit._tag === "Failure";

export const isSome = (option: Option.Option<number>): boolean => option._tag === "Some";

export const isNone = (option: Option.Option<number>): boolean => option._tag !== "None";

export const isLeftOrRight = (value: { readonly _tag: string }): boolean =>
  value._tag === "Left" || value._tag === "Right";

/** Combinator-based inspection is the target state. */
export const viaCombinators = (option: Option.Option<number>, result: Result.Result<number, string>): boolean =>
  Option.isSome(option) && Result.isSuccess(result);
