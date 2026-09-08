// expect-count: 21
import type { Effect } from 'effect';
type Operation<A> = PromiseLike<A> | Effect.Effect<A>;
interface Constrained<R extends Operation<number> = Operation<number>> { run(): R; }
interface Direct<R extends Promise<number>> { run(): R; }
type Identity<T> = T;
interface Substituted { run(): Identity<Promise<number>>; }
type Default<T = Promise<number>> = T;
interface Defaulted { run(): Default; }
type Alias<T> = Identity<T>;
interface Nested { run(): Alias<PromiseLike<number>>; }
export declare function execute<R extends Promise<number>>(operation: () => R): R;

type Callback<T> = () => T;
interface AppliedCallback { run: Callback<Promise<void>>; }
interface AppliedThenableCallback { run: Callback<PromiseLike<void>>; }
class AppliedField { declare run: Callback<Promise<void>>; }
declare const appliedBinding: Callback<Promise<void>>;
declare function register(operation: Callback<Promise<void>>): void;
type NestedCallback<T> = Callback<T>;
interface NestedCallbackPort { run: NestedCallback<Promise<void>>; }
interface CallbackFactory { make(): Callback<Promise<void>>; }
type DefaultCallback<T = PromiseLike<number>> = () => T;
interface DefaultCallbackPort { run: DefaultCallback; }

type Service<T> = { run: () => T };
declare const service: Service<Promise<void>>;
interface ServicePort { service: Service<PromiseLike<void>>; }
type MethodService<T> = { run(): T };
declare const methodService: MethodService<Promise<void>>;
interface GenericService<T> { run: () => T; }
declare const genericService: GenericService<Promise<void>>;
type NestedService<T> = { inner: { run: () => T } };
declare const nestedService: NestedService<Promise<void>>;
