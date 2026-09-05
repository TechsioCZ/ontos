// Type-only re-exports are erased before runtime and cannot open a fiber.
export type { runPromise } from "effect/Effect";
export { type runSync } from "effect/Effect";
export type * from "effect/Effect";
