// expect-count: 6
import { Predicate, Schema } from "effect";
import { isTable } from "drizzle-orm";
import { isString } from "effect/Predicate";
import { filter } from "effect/Array";

export function shadowSchema(Schema: { is: (s: unknown) => (v: unknown) => boolean }) {
  return (value: unknown): value is string => Schema.is({})(value);
}
export function shadowPredicate(Predicate: { isString: (v: unknown) => boolean }) {
  return (value: unknown): value is string => Predicate.isString(value);
}
export function shadowGuard(isTable: (v: unknown) => boolean) {
  return (value: unknown): value is object => isTable(value);
}
export function shadowPointFree(isString: (v: unknown) => boolean) {
  const guard: (value: unknown) => value is string = isString;
  return guard;
}
export function shadowArray(Array: { isArray: (v: unknown) => boolean }) {
  return (value: unknown): value is unknown[] => Array.isArray(value);
}
export function shadowCollection(filter: (f: (v: unknown) => boolean) => unknown) {
  return filter((value: unknown): value is string => typeof value === "string");
}
