// expect-count: 2
import { Effect } from "effect";
declare const error: { _tag: string };
export const ordinary = error._tag === "Missing";
export function shadow(Effect: { mapError(fn: (error: { _tag: string }) => boolean): unknown }) {
  return Effect.mapError((error) => error._tag === "Missing");
}
