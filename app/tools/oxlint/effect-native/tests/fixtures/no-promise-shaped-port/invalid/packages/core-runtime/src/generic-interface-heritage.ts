// expect-count: 14
type Service<T> = { run: () => T };
interface Port extends Service<Promise<void>> {}
interface Base<T> { run(): T; }
interface Middle<T> extends Base<T> {}
interface Deep<T> extends Middle<T> {}
declare const service: Deep<Promise<void>>;
type Applied = Deep<PromiseLike<void>>;
export type ExportedPort = Service<Promise<void>>;
interface AppliedInterface extends Deep<Promise<void>> {}
interface Defaults<T, R = T> extends Base<R> {}
declare const defaults: Defaults<Promise<void>>;
interface ConcreteDefault<T = Promise<void>> extends Base<T> {}
declare const defaulted: ConcreteDefault;
interface Partial<T> extends Base<T> { sync(): void; }
interface Container { port: Partial<Promise<void>>; }
type Alias<T> = Deep<T>;
declare const aliased: Alias<Promise<void>>;
interface Multiple<T> extends Empty, Deep<T> {}
interface Empty {}
declare const multiple: Multiple<Promise<void>>;

// A cyclic branch must not hide a separate Promise-returning base.
interface Cyclic<T> extends Cyclic<T>, Base<T> {}
declare const cyclicPort: Cyclic<Promise<void>>;
namespace Lexical {
  type Service<T> = { sync: T };
  interface Local extends Service<void> {}
}
interface Outside extends Service<Promise<void>> {}
interface ShadowedParameter<T> extends Base<T> {}
declare const shadowedParameter: ShadowedParameter<PromiseLike<void>>;
