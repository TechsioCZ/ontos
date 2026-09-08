import type { Effect } from 'effect';
import type { Service as ForeignService } from 'foreign-sdk';
type Service<T> = { run: () => T };
interface Base<T> { run(): T; }
interface Middle<T> extends Base<T> {}
interface Synchronous extends Service<void> {}
interface EffectPort extends Middle<Effect.Effect<void>> {}
declare const effectPort: Middle<Effect.Effect<void>>;
interface Foreign extends ForeignService<Promise<void>> {}
namespace Shadowed {
  interface Promise<T> { value: T; }
  interface Local extends Service<Promise<void>> {}
  declare const local: Middle<Promise<void>>;
}
interface GenericPromise<Promise> extends Service<Promise> {}
interface Outer<T> extends Service<{ run: <T>() => T }> {}
declare const shadowedGeneric: Outer<Promise<void>>;
interface Nested<T> extends Service<{ value: T }> {}
declare const nestedNonPort: Nested<Promise<void>>;
interface Recursive<T> extends Recursive<T> {}
declare const cycle: Recursive<Promise<void>>;
interface Left<T> extends Right<T> {}
interface Right<T> extends Left<T> {}
declare const mutualCycle: Left<Promise<void>>;
interface Defaults<T, R = T> extends Base<R> {}
declare const override: Defaults<Promise<void>, void>;

namespace Lexical {
  type Service<T> = { sync(): void };
  interface Local extends Service<Promise<void>> {}
  declare const local: Local;
}
interface InnerDefault<T, R = T> { run(): R; }
interface Rebound<T> extends InnerDefault<void> {}
declare const rebound: Rebound<Promise<void>>;
// The Promise is data nested below a function return, not a first-party operation.
interface Fluent<T> extends Service<{ run(): T }> {}
declare const fluent: Fluent<Promise<void>>;
interface GenericMethod<T> extends Service<<T>() => T> {}
declare const genericMethod: GenericMethod<Promise<void>>;

export type SynchronousAlias = Service<void>;
export type EffectAlias = Service<Effect.Effect<void>>;
