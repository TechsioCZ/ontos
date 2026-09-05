import { Runtime, ManagedRuntime } from 'effect';
import { runPromise as runCaptured } from 'effect/Runtime';
import { runPromise as runManaged } from 'effect/ManagedRuntime';
import { runSync } from 'effect/Effect';
import type { runPromise } from 'effect/Effect';
declare const captured: never;
declare const managed: never;
declare const program: never;
export const execute = () => Runtime.runPromise(captured)(program);
export const executeManaged = () => ManagedRuntime.runPromise(managed)(program);
export const direct = () => runCaptured(captured)(program);
export const directManaged = () => runManaged(managed)(program);
export type Runner = typeof runPromise;
export type SyncRunner = typeof runSync;
export class Port {
  runSync() { return 1; }
}
