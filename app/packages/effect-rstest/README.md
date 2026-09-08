# @app/effect-rstest

Vendored community port of `@effect/vitest` to Rstest by ScriptedAlchemy, commit `79abbf6`. Source: https://github.com/ScriptedAlchemy/effect-rstest. MIT licensed; the original copyright and permission notice are preserved in [LICENSE](./LICENSE).

Workspace exports use TypeScript source. Local corrections cover Rstest lifecycle integration, schema-backed property tests, and Effect semantic equality, alongside import and diagnostic adaptations.

## Usage

Import `it` and `expect` from `@app/effect-rstest`. Choose the smallest runner that fits:

- **Plain `it`**: synchronous assertions with no Effect program.
- **`it.effect`**: return an Effect directly. It supplies a test clock and test console; use `TestClock.adjust` from `effect/testing` to advance Effect sleeps deterministically.
- **`it.live`**: return an Effect using live services instead of the test clock/console. Use it when real elapsed time is necessary, such as integration tests coordinating Effect deadlines with external database or network I/O. Ordinary deterministic Effect tests should use `it.effect`.

```ts
import { expect, it } from '@app/effect-rstest';
import { Effect } from 'effect';

it('adds numbers', () => {
  expect(1 + 1).toBe(2);
});

it.effect('reads an Effect value', () =>
  Effect.gen(function* readsValue() {
    const value = yield* Effect.succeed(42);
    expect(value).toBe(42);
  }),
);
```

### Properties and equality

`it.prop` accepts FastCheck arbitraries and Effect schemas in either tuples or records. Use
`it.effect.prop` when the property itself returns an Effect.

```ts
import { addEqualityTesters, expect, it } from '@app/effect-rstest';
import { Schema } from 'effect';

addEqualityTesters();

it.prop('generates schema values', [Schema.String], ([value]) => {
  expect(typeof value).toBe('string');
});
```

`addEqualityTesters` enables Effect's `Equal.equals` for values implementing its equality protocol.
Ordinary objects and asymmetric matchers retain Rstest's native equality behavior.

### Shared layers

Use `it.layer` to share a layer across a suite; its resources are released when the suite ends. Set `excludeTestServices: true` when the suite needs live services instead of the test clock/console (the default is `false`). Replace `Layer.empty` below with your fixture layer:

```ts
import { expect, it } from '@app/effect-rstest';
import { Effect, Layer } from 'effect';

it.layer(Layer.empty, { excludeTestServices: true })('live fixture suite', (it) => {
  it.effect('reads an Effect value', () =>
    Effect.gen(function* readsValue() {
      const value = yield* Effect.succeed(42);
      expect(value).toBe(42);
    }),
  );
});
```

### Scoped cleanup

Both `it.effect` and `it.live` automatically own and close a per-test scope. Register cleanup with `Effect.acquireRelease` (or `Effect.addFinalizer` for an already-acquired resource); no extra `Effect.scoped` or Promise bridge is needed. Finalizers run on success, failure, and interruption.

```ts
it.effect('cleans up its fixture', () =>
  Effect.gen(function* scopedFixture() {
    const cache = yield* Effect.acquireRelease(
      Effect.sync(() => new Map<string, number>()),
      (resource) => Effect.sync(() => resource.clear()),
    );
    cache.set('answer', 42);
    expect(cache.get('answer')).toBe(42);
  }),
);
```

For an existing resource, register its Effect cleanup before using it: `yield* Effect.addFinalizer(() => release(resource))`. Use `acquireRelease` when acquisition and registration must be interruption-safe together.

**Do not use JavaScript `try/finally` for Effect cleanup.** A failed yielded Effect short-circuits the generator; JavaScript `finally` does not finalize failed yielded Effects. Register an Effect finalizer instead, so cleanup also runs when a yield fails or the test is interrupted.

On a runner timeout, the adapter interrupts the Effect and waits for its finalizers before the next
sequential test and enclosing layer teardown. Cleanup is not cut short by the runner's hook timeout,
so a finalizer that never settles can hold completion indefinitely.

Rstest runs native `afterEach` hooks before its test-finished callbacks. Those hooks can therefore
run while timed-out Effect cleanup is still pending. Keep resource release in Effect finalizers,
not native hooks. This ordering guarantee does not serialize concurrent tests.
