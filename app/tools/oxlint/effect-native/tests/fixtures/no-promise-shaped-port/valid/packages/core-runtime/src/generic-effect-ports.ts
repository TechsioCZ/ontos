import type { Effect } from 'effect';
type Identity<T> = T;
type Default<T = Effect.Effect<number>> = T;
interface Service<R extends Effect.Effect<number>> { run(): R; }
interface Plain { run(): Identity<string>; }
interface Native { run(): Identity<Effect.Effect<number>>; }
interface NativeDefault { run(): Default; }
type Shadow<T> = T;
interface Safe { run(): Shadow<string>; }

type Callback<T> = () => T;
interface NativeCallback { run: Callback<Effect.Effect<void>>; }
interface SynchronousCallback { run: Callback<void>; }
declare const nativeCallback: Callback<Effect.Effect<void>>;
declare function register(operation: Callback<Effect.Effect<void>>): void;
type DefaultCallback<T = Effect.Effect<number>> = () => T;
interface NativeDefaultCallback { run: DefaultCallback; }
