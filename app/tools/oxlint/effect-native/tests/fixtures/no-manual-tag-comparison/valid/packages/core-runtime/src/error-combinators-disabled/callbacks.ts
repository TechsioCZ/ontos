import { Effect as E, Schedule as S, Match as M } from "effect";
declare const operation: E.Effect<string, { _tag: string }>;
export const handled = operation.pipe(E.mapError((error) => error._tag === "Missing"));
export const schedule = S.recurWhile((error: { _tag: string }) => error._tag === "Retryable");
export const matcher = M.when((error: { _tag: string }) => error._tag === "Missing", () => 1);
