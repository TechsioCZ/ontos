// expect-count: 2
// A test-support module that re-exports the run functions hands every importing test an ad hoc
// root fiber, exactly like importing them directly.
export { runPromise } from "effect/Effect";
export { runSync as runIt } from "effect/Effect";
