// expect-count: 7
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
