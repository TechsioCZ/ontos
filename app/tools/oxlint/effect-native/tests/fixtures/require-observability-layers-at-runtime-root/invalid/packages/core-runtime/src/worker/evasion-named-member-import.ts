// expect-count: 3
// Evasion: import the runtime constructor itself instead of its namespace.
import { make } from 'effect/ManagedRuntime';

declare const workerLayer: never;

export const boot = () => make(workerLayer);
