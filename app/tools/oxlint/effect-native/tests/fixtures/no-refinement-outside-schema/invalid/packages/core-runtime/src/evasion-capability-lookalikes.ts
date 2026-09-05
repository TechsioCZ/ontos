// expect-count: 3
import { Predicate } from "effect";
export const dataGuard = (value: object): value is { name: string } =>
  "name" in value && Predicate.isString(value.name);
export const differentProperty = (value: object): value is { verify: () => void } =>
  "verify" in value && Predicate.isFunction(value.other);
export const extraClause = (value: object): value is { verify: () => void; ready: true } =>
  "verify" in value && Predicate.isFunction(value.verify) && value.ready === true;
