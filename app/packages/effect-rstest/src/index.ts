/**
 * Helpers for testing Effect (v4) code with [Rstest](https://rstest.rs).
 *
 * This module is a port of `@effect/vitest` to the Rstest runner. The public
 * API mirrors `@effect/vitest`: an enhanced `it` with `effect`, `live`,
 * `layer`, `prop` and `flakyTest`, plus `addEqualityTesters` and
 * `describeWrapped`.
 *
 * @since 0.1.0
 */
import type * as Duration from 'effect/Duration';
import type * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import type * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import type * as FC from 'effect/testing/FastCheck';
import * as Rs from '@rstest/core';
import * as internal from './internal/internal.ts';

/**
 * Re-exports everything from `@rstest/core` (`describe`, `expect`, `assert`,
 * hooks, `rs`, ...).
 *
 * @since 0.1.0
 */
export * from '@rstest/core';

/**
 * @since 0.1.0
 */
export type API = Rs.TestAPIs;

/**
 * Type namespace retained from `@effect/vitest` for source compatibility.
 *
 * @since 0.1.0
 */
export namespace Vitest {
  /**
   * @since 0.1.0
   */
  export interface TestFunction<A, E, R, TestArgs extends Array<any>> {
    (...args: TestArgs): Effect.Effect<A, E, R>;
  }

  /**
   * @since 0.1.0
   */
  export interface Test<R> {
    <A, E>(
      name: string,
      self: TestFunction<A, E, R, [Rs.TestContext]>,
      timeout?: number | Rs.TestOptions,
    ): void;
  }

  /**
   * @since 0.1.0
   */
  export type Arbitraries =
    | Array<Schema.Schema<any> | FC.Arbitrary<any>>
    | { [K in string]: Schema.Schema<any> | FC.Arbitrary<any> };

  /**
   * @since 0.1.0
   */
  export interface Tester<R> extends Vitest.Test<R> {
    skip: Vitest.Test<R>;
    skipIf: (condition: unknown) => Vitest.Test<R>;
    runIf: (condition: unknown) => Vitest.Test<R>;
    only: Vitest.Test<R>;
    each: <T>(
      cases: ReadonlyArray<T>,
    ) => <A, E>(
      name: string,
      self: TestFunction<A, E, R, Array<T>>,
      timeout?: number | Rs.TestOptions,
    ) => void;
    fails: Vitest.Test<R>;

    /**
     * @since 0.1.0
     */
    prop: <const Arbs extends Arbitraries, A, E>(
      name: string,
      arbitraries: Arbs,
      self: TestFunction<
        A,
        E,
        R,
        [
          {
            [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T>
              ? T
              : Arbs[K] extends Schema.Schema<infer T>
                ? T
                : never;
          },
          Rs.TestContext,
        ]
      >,
      timeout?:
        | number
        | (Rs.TestOptions & {
            fastCheck?: FC.Parameters<{
              [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T>
                ? T
                : Arbs[K] extends Schema.Schema<infer T>
                  ? T
                  : never;
            }>;
          }),
    ) => void;
  }

  /**
   * @since 0.1.0
   */
  export interface MethodsNonLive<R = never> extends API {
    readonly effect: Vitest.Tester<R | Scope.Scope>;
    readonly describe: Rs.Describe;
    readonly flakyTest: <A, E, R2>(
      self: Effect.Effect<A, E, R2 | Scope.Scope>,
      timeout?: Duration.Input,
    ) => Effect.Effect<A, never, R2>;
    readonly layer: <R2, E>(
      layer: Layer.Layer<R2, E, R>,
      options?: {
        readonly timeout?: Duration.Input;
      },
    ) => {
      (f: (it: Vitest.MethodsNonLive<R | R2>) => void): void;
      (name: string, f: (it: Vitest.MethodsNonLive<R | R2>) => void): void;
    };

    /**
     * @since 0.1.0
     */
    readonly prop: <const Arbs extends Arbitraries>(
      name: string,
      arbitraries: Arbs,
      self: (
        properties: {
          [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T>
            ? T
            : Arbs[K] extends Schema.Schema<infer T>
              ? T
              : never;
        },
        ctx: Rs.TestContext,
      ) => void,
      timeout?:
        | number
        | (Rs.TestOptions & {
            fastCheck?: FC.Parameters<{
              [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T>
                ? T
                : Arbs[K] extends Schema.Schema<infer T>
                  ? T
                  : never;
            }>;
          }),
    ) => void;
  }

  /**
   * @since 0.1.0
   */
  export interface Methods<R = never> extends MethodsNonLive<R> {
    readonly live: Vitest.Tester<Scope.Scope | R>;
    readonly layer: <R2, E>(
      layer: Layer.Layer<R2, E, R>,
      options?: {
        readonly memoMap?: Layer.MemoMap;
        readonly timeout?: Duration.Input;
        readonly excludeTestServices?: boolean;
      },
    ) => {
      (f: (it: Vitest.MethodsNonLive<R | R2>) => void): void;
      (name: string, f: (it: Vitest.MethodsNonLive<R | R2>) => void): void;
    };
  }
}

/**
 * @since 0.1.0
 */
export const addEqualityTesters: () => void = internal.addEqualityTesters;

/**
 * @since 0.1.0
 */
export const effect: Vitest.Tester<Scope.Scope> = internal.effect;

/**
 * @since 0.1.0
 */
export const live: Vitest.Tester<Scope.Scope> = internal.live;

/**
 * Share a `Layer` between multiple tests, optionally wrapping
 * the tests in a `describe` block if a name is provided.
 *
 * @since 0.1.0
 *
 * ```ts
 * import { assert, layer } from "effect-rstest"
 * import { Effect, Layer, Context } from "effect"
 *
 * class Foo extends Context.Service<Foo, "foo">()("Foo") {
 *   static layer = Layer.succeed(Foo, "foo")
 * }
 *
 * class Bar extends Context.Service<Bar, "bar">()("Bar") {
 *   static layer = Layer.effect(
 *     Bar,
 *     Effect.map(Foo, () => "bar" as const)
 *   )
 * }
 *
 * layer(Foo.layer)("layer", (it) => {
 *   it.effect("adds context", () =>
 *     Effect.gen(function*() {
 *       const foo = yield* Foo
 *       assert.strictEqual(foo, "foo")
 *     }))
 *
 *   it.layer(Bar.layer)("nested", (it) => {
 *     it.effect("adds context", () =>
 *       Effect.gen(function*() {
 *         const foo = yield* Foo
 *         const bar = yield* Bar
 *         assert.strictEqual(foo, "foo")
 *         assert.strictEqual(bar, "bar")
 *       }))
 *   })
 * })
 * ```
 */
export const layer: <R, E>(
  layer_: Layer.Layer<R, E>,
  options?: {
    readonly memoMap?: Layer.MemoMap;
    readonly timeout?: Duration.Input;
    readonly excludeTestServices?: boolean;
  },
) => {
  (f: (it: Vitest.MethodsNonLive<R>) => void): void;
  (name: string, f: (it: Vitest.MethodsNonLive<R>) => void): void;
} = internal.layer;

/**
 * @since 0.1.0
 */
export const flakyTest: <A, E, R>(
  self: Effect.Effect<A, E, R | Scope.Scope>,
  timeout?: Duration.Input,
) => Effect.Effect<A, never, R> = internal.flakyTest;

/**
 * @since 0.1.0
 */
export const prop: Vitest.Methods['prop'] = internal.prop;

/**
 * @since 0.1.0
 */
export const it: Vitest.Methods = internal.makeMethods(Rs.it);

/**
 * @since 0.1.0
 */
export const makeMethods: (it: Rs.TestAPIs) => Vitest.Methods = internal.makeMethods;

/**
 * Unlike `@effect/vitest`, this returns `void` because Rstest's `describe`
 * does not return a `SuiteCollector`.
 *
 * @since 0.1.0
 */
export const describeWrapped: (name: string, f: (it: Vitest.Methods) => void) => void =
  internal.describeWrapped;
