// expect-count: 2
// The two-statement spelling of the same wrapper module: import the constructor, then re-export the
// local binding. Consumers get `ManagedRuntime.make` / `Layer.toRuntime` without importing `effect`.
import { toRuntime } from 'effect/Layer';
import { make } from 'effect/ManagedRuntime';

export { make, toRuntime };
