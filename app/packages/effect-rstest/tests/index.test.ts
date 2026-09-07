import { Sleeper } from './support/sleeper.ts';
import { Scoped } from './support/scoped.ts';
import { Foo } from './support/foo.ts';
import { Bar } from './support/bar.ts';
import { afterAll, assert, describe, describeWrapped, expect, it, layer } from '@app/effect-rstest';
import { throws, throwsAsync } from '@app/effect-rstest/utils';
import { Clock, Duration, Effect, Exit, Fiber, Layer, Schema } from 'effect';
import { FastCheck, TestClock } from 'effect/testing';

const realNumber = FastCheck.float({ noDefaultInfinity: true, noNaN: true });

it.effect('effect', () =>
  Effect.acquireRelease(
    Effect.sync(() => expect(1).toEqual(1)),
    () => Effect.void,
  ),
);
it.live('live', () =>
  Effect.acquireRelease(
    Effect.sync(() => expect(1).toEqual(1)),
    () => Effect.void,
  ),
);

describeWrapped('describeWrapped', (suiteIt0) => {
  suiteIt0.effect('provides the enhanced test API', () =>
    Effect.sync(() => expect(suiteIt0.layer).toBeTypeOf('function')),
  );
});

it('throws fails when the thunk does not throw', () => {
  expect(() => throws(() => {})).toThrow();
});

const resolvedPromiseThrows: () => Promise<void> = throwsAsync.bind(
  undefined,
  Promise.resolve.bind(Promise),
  undefined,
);

it.effect('throwsAsync fails when the promise resolves', () =>
  Effect.gen(function* throwsResolved() {
    const result = yield* Effect.exit(Effect.tryPromise(resolvedPromiseThrows));
    expect(Exit.isFailure(result)).toBe(true);
  }),
);

// each

it.effect.each([1, 2, 3])('effect each %s', (n) =>
  Effect.acquireRelease(
    Effect.sync(() => expect(n).toEqual(n)),
    () => Effect.void,
  ),
);
it.live.each([1, 2, 3])('live each %s', (n) =>
  Effect.acquireRelease(
    Effect.sync(() => expect(n).toEqual(n)),
    () => Effect.void,
  ),
);

// skip

it.live.skip('live skipped', () => Effect.die('skipped anyway'));
it.effect.skip('effect skipped', () => Effect.die('skipped anyway'));

// skipIf

it.effect.skipIf(true)('effect skipIf (true)', () => Effect.die('skipped anyway'));
it.effect.skipIf(false)('effect skipIf (false)', () => Effect.sync(() => expect(1).toEqual(1)));

// runIf

it.effect.runIf(true)('effect runIf (true)', () => Effect.sync(() => expect(1).toEqual(1)));
it.effect.runIf(false)('effect runIf (false)', () => Effect.die('not run anyway'));

// chained helpers

it.describe.each(['foo', 'bar'] as const)('describe.each %s', (text) => {
  it.effect('runs an Effect test', () =>
    Effect.sync(() => {
      assert.include(['foo', 'bar'], text);
    }),
  );
});

it.skip.each([1])('skip.each %s', () => assert.fail('skipped anyway'));

// The following test is expected to fail because it simulates a test timeout.
// Be aware that eventual 'failure' of the test is only logged out.
it.live.fails(
  'interrupts on timeout',
  (ctx) =>
    Effect.gen(function* testEffect() {
      let acquired = false;

      ctx.onTestFailed(() => {
        expect(acquired).toBe(false);
      });

      yield* Effect.acquireRelease(
        Effect.sync(() => (acquired = true)),
        () => Effect.sync(() => (acquired = false)),
      );
      yield* Effect.sleep(1000);
    }),
  1,
);

const fooLayer = Layer.succeed(Foo)('foo');

const barLayer = Layer.effect(Bar)(Foo.pipe(Effect.as('bar' as const)));

const sleeperLayer = Layer.effect(Sleeper)(
  Effect.gen(function* testEffect() {
    const clock = yield* Clock.Clock;

    return {
      sleep: (ms: number) => clock.sleep(Duration.millis(ms)),
    };
  }),
);

describe('layer', () => {
  layer(fooLayer)((suiteIt1) => {
    suiteIt1.effect('adds context', () =>
      Effect.gen(function* testEffect() {
        const foo = yield* Foo;
        expect(foo).toEqual('foo');
      }),
    );

    suiteIt1.layer(barLayer)('nested', (suiteIt2) => {
      suiteIt2.effect('adds context', () =>
        Effect.gen(function* testEffect() {
          const foo = yield* Foo;
          const bar = yield* Bar;
          expect(foo).toEqual('foo');
          expect(bar).toEqual('bar');
        }),
      );
    });

    suiteIt1.layer(barLayer)((suiteIt3) => {
      suiteIt3.effect('without name', () =>
        Effect.gen(function* testEffect() {
          const foo = yield* Foo;
          const bar = yield* Bar;
          expect(foo).toEqual('foo');
          expect(bar).toEqual('bar');
        }),
      );
    });

    describe('release', () => {
      let released = false;
      afterAll(() => {
        expect(released).toEqual(true);
      });

      const scopedLayer = Layer.effect(Scoped)(
        Effect.acquireRelease(Effect.succeed('scoped' as const), () =>
          Effect.sync(() => (released = true)),
        ),
      );

      suiteIt1.layer(scopedLayer)((suiteIt4) => {
        suiteIt4.effect('adds context', () =>
          Effect.gen(function* testEffect() {
            const foo = yield* Foo;
            const scoped = yield* Scoped;
            expect(foo).toEqual('foo');
            expect(scoped).toEqual('scoped');
          }),
        );
      });

      suiteIt1.effect.prop(
        'adds context',
        [realNumber],
        ([num]) =>
          Effect.gen(function* testEffect() {
            const foo = yield* Foo;
            expect(foo).toEqual('foo');
            return !Number.isNaN(num);
          }),
        { fastCheck: { numRuns: 200 } },
      );
    });
  });

  layer(sleeperLayer)('test services', (suiteIt5) => {
    suiteIt5.effect('TestClock', () =>
      Effect.gen(function* testEffect() {
        const sleeper = yield* Sleeper;
        const fiber = yield* Effect.forkChild(sleeper.sleep(100_000));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(100_000);
        yield* Fiber.join(fiber);
      }),
    );
  });

  layer(fooLayer)('with a name', (suiteIt6) => {
    describe('with a nested describe', () => {
      suiteIt6.effect('adds context', () =>
        Effect.gen(function* testEffect() {
          const foo = yield* Foo;
          expect(foo).toEqual('foo');
        }),
      );
    });
    suiteIt6.effect('adds context', () =>
      Effect.gen(function* testEffect() {
        const foo = yield* Foo;
        expect(foo).toEqual('foo');
      }),
    );
  });

  layer(sleeperLayer, { excludeTestServices: true })('live services', (suiteIt7) => {
    suiteIt7.effect('Clock', () =>
      Effect.gen(function* testEffect() {
        const sleeper = yield* Sleeper;
        yield* sleeper.sleep(1);
      }),
    );
  });
});

// property testing

it.prop('symmetry', [realNumber, FastCheck.integer()], ([a, b]) => {
  expect(a + b).toBe(b + a);
});

it.prop('symmetry with object', { a: realNumber, b: FastCheck.integer() }, ({ a, b }) => {
  expect(a + b).toBe(b + a);
});

it.live.prop('schema with object', { value: Schema.Int }, ({ value }) =>
  Effect.sync(() => assert.isTrue(Number.isInteger(value))),
);

it.effect.prop('symmetry', [realNumber, FastCheck.integer()], ([a, b]) =>
  Effect.gen(function* testEffect() {
    yield* Effect.void;
    assert.isTrue(a + b === b + a);
  }),
);

it.effect.prop('symmetry with object', { a: realNumber, b: FastCheck.integer() }, ({ a, b }) =>
  Effect.gen(function* testEffect() {
    yield* Effect.void;
    assert.strictEqual(a + b, b + a);
  }),
);

it.effect.prop(
  'should detect the substring',
  { a: FastCheck.string(), b: FastCheck.string(), c: FastCheck.string() },
  ({ a, b, c }) =>
    Effect.gen(function* testEffect() {
      yield* Effect.scope;
      assert.include(a + b + c, b);
    }),
);
