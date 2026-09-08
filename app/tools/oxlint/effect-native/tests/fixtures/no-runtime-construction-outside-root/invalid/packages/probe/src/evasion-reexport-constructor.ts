// expect-count: 2
// A wrapper module that re-exports the runtime constructors, so every consumer can toRuntime a second
// runtime without ever importing `effect`. Both the single-statement re-export and the
// `import { make } ...; export { make }` form hand the constructor around.
export { make as makeRuntime } from 'effect/ManagedRuntime';
export { toRuntime } from 'effect/Layer';
