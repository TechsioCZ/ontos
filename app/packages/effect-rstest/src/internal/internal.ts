// @effect-diagnostics missedPipeableOpportunity:off strictEffectProvide:off -- vendored port of @effect/vitest; remove-when: upstream removes this runtime boundary
/**
 * @since 0.1.0
 */

import * as Cause from 'effect/Cause';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import { flow, pipe } from 'effect/Function';
import * as Layer from 'effect/Layer';
import { isObject } from 'effect/Predicate';
import * as Rec from 'effect/Record';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Scope from 'effect/Scope';
import * as fc from 'effect/testing/FastCheck';
import * as TestClock from 'effect/testing/TestClock';
import * as TestConsole from 'effect/testing/TestConsole';
import * as Rs from '@rstest/core';
import type * as EffectRstest from '../index.ts';

const runPromise: <E, A>(
  _: Effect.Effect<A, E, never>,
  ctx?: Rs.TestContext | undefined,
) => Promise<A> = Effect.fnUntraced(
  function* <E, A>(effect: Effect.Effect<A, E>, _ctx?: Rs.TestContext) {
    const exit = yield* Effect.exit(effect);
    if (Exit.isFailure(exit)) {
      const errors = Cause.prettyErrors(exit.cause);
      for (let i = 0; i < errors.length; i++) {
        yield* Effect.logError(errors[i]);
      }
    }
    return yield* exit;
  },
  (effect, _, ctx) => Effect.runPromise(effect, { signal: ctx?.signal }),
);

/** @internal */
const runTest =
  (ctx?: Rs.TestContext) =>
  <E, A>(effect: Effect.Effect<A, E>) =>
    runPromise(effect, ctx);

/** @internal */
export type TestContext = TestConsole.TestConsole | TestClock.TestClock;

const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());

/** @internal */
export const addEqualityTesters = () => {
  Rs.expect.addEqualityTesters([]);
};

/** @internal */
const testOptions = (timeout?: number | Rs.TestOptions): Rs.TestOptions =>
  typeof timeout === 'number' ? { timeout } : (timeout ?? {});

const hookTimeout = (timeout?: Duration.Input) =>
  timeout === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(timeout));

const makeItProxy = <Methods extends object>(
  it: Rs.TestAPIs,
  overrides: Methods,
): Methods & Rs.TestAPIs =>
  new Proxy(it as Methods & Rs.TestAPIs, {
    apply(target, thisArg, argArray) {
      return Reflect.apply(target, thisArg, argArray);
    },
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      // do not bind: binding would strip rstest's static helpers (e.g. `it.each`)
      return Reflect.get(target, property, receiver);
    },
  });

/** @internal */
const makeTester = <R>(
  mapEffect: <A, E>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, never>,
  it: Rs.TestAPIs = Rs.it,
): EffectRstest.Vitest.Tester<R> => {
  // rstest's test callbacks must return `MaybePromise<void>`, so the test
  // value is intentionally discarded here (vitest accepts any return value)
  const run = <A, E, TestArgs extends Array<unknown>>(
    ctx: Rs.TestContext & object,
    args: TestArgs,
    self: EffectRstest.Vitest.TestFunction<A, E, R, TestArgs>,
  ): Promise<any> =>
    pipe(
      Effect.suspend(() => self(...args)),
      mapEffect,
      runTest(ctx),
    );

  const f: EffectRstest.Vitest.Test<R> = (name, self, timeout) =>
    it(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self));

  const skip: EffectRstest.Vitest.Tester<R>['only'] = (name, self, timeout) =>
    it.skip(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self));

  const skipIf: EffectRstest.Vitest.Tester<R>['skipIf'] = (condition) => (name, self, timeout) =>
    it.skipIf(Boolean(condition))(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self));

  const runIf: EffectRstest.Vitest.Tester<R>['runIf'] = (condition) => (name, self, timeout) =>
    it.runIf(Boolean(condition))(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self));

  const only: EffectRstest.Vitest.Tester<R>['only'] = (name, self, timeout) =>
    it.only(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self));

  const each: EffectRstest.Vitest.Tester<R>['each'] = (cases) => (name, self, timeout) =>
    it.for(cases)(name, testOptions(timeout), (args, ctx) => run(ctx, [args], self) as any);

  const fails: EffectRstest.Vitest.Tester<R>['fails'] = (name, self, timeout) =>
    it.fails(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self));

  const prop: EffectRstest.Vitest.Tester<R>['prop'] = (name, arbitraries, self, timeout) => {
    if (Array.isArray(arbitraries)) {
      const arbs = arbitraries.map((arbitrary) => {
        if (Schema.isSchema(arbitrary)) {
          return Schema.toArbitrary(arbitrary)(fc);
        }
        return arbitrary as fc.Arbitrary<any>;
      });
      return it(name, testOptions(timeout), (ctx) =>
        // @ts-ignore
        fc.assert(
          // @ts-ignore
          fc.asyncProperty(...arbs, (...as) => run(ctx, [as as any, ctx], self)),
          // @ts-ignore
          // @ts-ignore -- upstream variadic FastCheck options
          isObject(timeout) ? timeout?.['fastCheck'] : {},
        ),
      );
    }

    const arbs = fc.record(
      Object.keys(arbitraries).reduce(
        function (result, key) {
          const arb: any = arbitraries[key];
          Rec.assignProperty(result, key, Schema.isSchema(arb) ? Schema.toArbitrary(arb)(fc) : arb);
          return result;
        },
        {} as Record<string, fc.Arbitrary<any>>,
      ),
    );

    return it(name, testOptions(timeout), (ctx) =>
      // @ts-ignore
      fc.assert(
        fc.asyncProperty(arbs, (...as) =>
          // @ts-ignore
          run(ctx, [as[0] as any, ctx], self),
        ),
        // @ts-ignore
        // @ts-ignore -- upstream variadic FastCheck options
        isObject(timeout) ? timeout?.['fastCheck'] : {},
      ),
    );
  };

  return Object.assign(f, { skip, skipIf, runIf, only, each, fails, prop });
};

/** @internal */
export const prop: EffectRstest.Vitest.Methods['prop'] = (name, arbitraries, self, timeout) => {
  if (Array.isArray(arbitraries)) {
    const arbs = arbitraries.map((arbitrary) => {
      if (Schema.isSchema(arbitrary)) {
        throw new Error('Schemas are not supported yet');
      }
      return arbitrary;
    });
    return Rs.it(
      name,
      testOptions(timeout),
      // @ts-ignore
      (ctx) =>
        fc.assert(
          // @ts-ignore -- upstream variadic FastCheck typing
          fc.property(...arbs, (...as) => self(as, ctx)),
          // @ts-ignore -- upstream variadic FastCheck options
          isObject(timeout) ? timeout?.['fastCheck'] : {},
        ),
    );
  }

  const arbs = fc.record(
    Object.keys(arbitraries).reduce(
      function (result, key) {
        const arb: any = arbitraries[key];
        if (Schema.isSchema(arb)) {
          throw new Error('Schemas are not supported yet');
        }
        Rec.assignProperty(result, key, arb);
        return result;
      },
      {} as Record<string, fc.Arbitrary<any>>,
    ),
  );

  return Rs.it(
    name,
    testOptions(timeout),
    // @ts-ignore
    (ctx) =>
      fc.assert(
        // @ts-ignore -- upstream variadic FastCheck typing
        fc.property(arbs, (as) => self(as, ctx)),
        // @ts-ignore -- upstream variadic FastCheck options
        isObject(timeout) ? timeout?.['fastCheck'] : {},
      ),
  );
};

/** @internal */
export const layer =
  <R, E>(
    layer_: Layer.Layer<R, E>,
    options?: {
      readonly memoMap?: Layer.MemoMap;
      readonly timeout?: Duration.Input;
      readonly excludeTestServices?: boolean;
    },
  ): {
    (f: (it: EffectRstest.Vitest.MethodsNonLive<R>) => void): void;
    (name: string, f: (it: EffectRstest.Vitest.MethodsNonLive<R>) => void): void;
  } =>
  (
    ...args:
      | [name: string, f: (it: EffectRstest.Vitest.MethodsNonLive<R>) => void]
      | [f: (it: EffectRstest.Vitest.MethodsNonLive<R>) => void]
  ) => {
    const excludeTestServices = options?.excludeTestServices ?? false;
    const withTestEnv = excludeTestServices
      ? (layer_ as Layer.Layer<R, E>)
      : Layer.provideMerge(layer_, TestEnv);
    const memoMap = options?.memoMap ?? Effect.runSync(Layer.makeMemoMap);
    const scope = Effect.runSync(Scope.make());
    const contextEffect = Layer.buildWithMemoMap(withTestEnv, memoMap, scope).pipe(
      Effect.orDie,
      Effect.cached,
      Effect.runSync,
    );
    let setupFiber: Fiber.Fiber<unknown, unknown> | undefined;
    const buildContext = () =>
      runPromise(
        Effect.withFiber((fiber) => {
          setupFiber = fiber;
          return Effect.asVoid(contextEffect);
        }),
      );
    let closed = false;
    const closeScope = (ctx?: Rs.TestContext) => {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      // SuiteContext has no AbortSignal: a timed-out beforeAll keeps running.
      // Stop and await setup before releasing resources it may still be using.
      return runPromise(
        Effect.andThen(
          setupFiber !== undefined ? Fiber.interrupt(setupFiber) : Effect.void,
          Scope.close(scope, Exit.void),
        ),
        ctx,
      );
    };

    const makeIt = (it: Rs.TestAPIs): EffectRstest.Vitest.MethodsNonLive<R> =>
      makeItProxy(it, {
        effect: makeTester<R | Scope.Scope>(
          (effect) =>
            Effect.flatMap(contextEffect, (context) =>
              effect.pipe(Effect.scoped, Effect.provide(context)),
            ),
          it,
        ),
        describe: Rs.describe,
        prop,
        flakyTest,
        layer<R2, E2>(
          nestedLayer: Layer.Layer<R2, E2, R>,
          options?: {
            readonly timeout?: Duration.Input;
          },
        ) {
          return layer(Layer.provideMerge(nestedLayer, withTestEnv), {
            ...options,
            memoMap: Layer.forkMemoMapUnsafe(memoMap),
            excludeTestServices,
          });
        },
      });

    if (args.length === 1) {
      // Rstest has no `getCurrentSuite`, so use an empty nested suite as the
      // lifecycle boundary for an unnamed layer block. Rstest omits empty suite
      // names from test paths, while its beforeAll/afterAll hooks ensure the
      // scope closes before later tests in the enclosing suite run.
      return Rs.describe('', () => {
        Rs.beforeAll(buildContext, hookTimeout(options?.timeout));
        Rs.afterAll(() => closeScope(), hookTimeout(options?.timeout));
        return args[0](makeIt(Rs.it));
      });
    }

    return Rs.describe(args[0], () => {
      Rs.beforeAll(buildContext, hookTimeout(options?.timeout));
      Rs.afterAll(() => closeScope(), hookTimeout(options?.timeout));
      return args[1](makeIt(Rs.it));
    });
  };

/** @internal */
export const flakyTest = <A, E, R>(
  self: Effect.Effect<A, E, R | Scope.Scope>,
  timeout: Duration.Input = Duration.seconds(30),
) =>
  pipe(
    self,
    Effect.scoped,
    Effect.sandbox,
    Effect.retry(
      pipe(
        Schedule.recurs(10),
        Schedule.while((_) =>
          Effect.succeed(
            Duration.isLessThanOrEqualTo(
              Duration.fromInputUnsafe(_.elapsed),
              Duration.fromInputUnsafe(timeout),
            ),
          ),
        ),
      ),
    ),
    Effect.orDie,
  );

/** @internal */
export const makeMethods = (it: Rs.TestAPIs): EffectRstest.Vitest.Methods =>
  makeItProxy(it, {
    effect: makeTester<Scope.Scope>(flow(Effect.scoped, Effect.provide(TestEnv)), it),
    live: makeTester<Scope.Scope>(Effect.scoped, it),
    describe: Rs.describe,
    flakyTest,
    layer,
    prop,
  });

/** @internal */
export const {
  /** @internal */
  effect,
  /** @internal */
  live,
} = makeMethods(Rs.it);

/** @internal */
export const describeWrapped = (name: string, f: (it: EffectRstest.Vitest.Methods) => void): void =>
  Rs.describe(name, () => f(makeMethods(Rs.it)));
