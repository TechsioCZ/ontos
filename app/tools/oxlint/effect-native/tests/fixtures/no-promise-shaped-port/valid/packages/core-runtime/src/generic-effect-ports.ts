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

type Port<T> = { run: () => T };
declare const nativePort: Port<Effect.Effect<void>>;
interface PortHolder { port: Port<Effect.Effect<void>>; }
type MethodPort<T> = { run(): T };
declare const nativeMethodPort: MethodPort<Effect.Effect<void>>;
interface GenericPort<T> { run: () => T; }
declare const nativeGenericPort: GenericPort<Effect.Effect<void>>;
type NestedPort<T> = { inner: { run: () => T } };
declare const nativeNestedPort: NestedPort<Effect.Effect<void>>;
type PlainPort = { run: () => Effect.Effect<void> };
declare const plainPort: PlainPort;
