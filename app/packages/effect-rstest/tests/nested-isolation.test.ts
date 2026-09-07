import { TodoService } from './support/todo-service.ts';
import { State } from './support/state.ts';
import { SharedChild } from './support/shared-child.ts';
import { Parent } from './support/parent.ts';
import { Child } from './support/child.ts';
import { afterAll, assert, beforeAll, describe, expect, it, layer } from '@app/effect-rstest';
import { Effect, Layer, Ref } from 'effect';

describe('nested sibling layers', () => {
  let nextChildId = 0;
  let firstChildId = -1;
  let secondChildId = -1;
  const releasedChildIds: number[] = [];

  const parentLayer = Layer.succeed(Parent)('parent');

  const childLayer = Layer.effect(Child)(
    Parent.pipe(
      Effect.flatMap(() => {
        nextChildId += 1;
        const id = nextChildId;
        return Effect.acquireRelease(Effect.succeed({ id }), () =>
          Effect.sync(() => {
            releasedChildIds.push(id);
          }),
        );
      }),
    ),
  );

  layer(parentLayer)('parent', (suiteIt0) => {
    suiteIt0.layer(childLayer)('first sibling', (suiteIt1) => {
      suiteIt1.effect('allocates child', () =>
        Effect.gen(function* testEffect() {
          const child = yield* Child;
          firstChildId = child.id;

          assert.strictEqual(child.id, 1);
          assert.deepStrictEqual(releasedChildIds, []);
        }),
      );
    });

    suiteIt0.layer(childLayer)('second sibling', (suiteIt2) => {
      beforeAll(() => {
        expect(releasedChildIds).toEqual([firstChildId]);
      });

      suiteIt2.effect('allocates a fresh child', () =>
        Effect.gen(function* testEffect() {
          const child = yield* Child;
          secondChildId = child.id;

          assert.strictEqual(child.id, 2);
          assert.isTrue(child.id !== firstChildId);
          assert.deepStrictEqual(releasedChildIds, [firstChildId]);
        }),
      );
    });

    afterAll(() => {
      expect(firstChildId).toEqual(1);
      expect(secondChildId).toEqual(2);
      expect(releasedChildIds).toEqual([1, 2]);
    });
  });
});

describe.concurrent('nested sibling layers in concurrent suites', () => {
  let nextSharedId = 0;
  let firstSharedId: number | undefined;
  let secondSharedId: number | undefined;
  const releasedSharedIds: number[] = [];

  const parentLayer = Layer.succeed(Parent)('parent');

  const sharedChildLayer = Layer.effect(SharedChild)(
    Parent.pipe(
      Effect.flatMap(() =>
        Effect.gen(function* testEffect() {
          yield* Effect.yieldNow;

          nextSharedId += 1;
          const id = nextSharedId;
          return yield* Effect.acquireRelease(Effect.succeed({ id }), () =>
            Effect.sync(() => {
              releasedSharedIds.push(id);
            }),
          );
        }),
      ),
    ),
  );

  layer(parentLayer)('parent', (suiteIt3) => {
    describe.concurrent('concurrent siblings', () => {
      suiteIt3.layer(sharedChildLayer)('first sibling', (suiteIt4) => {
        suiteIt4.effect('captures shared child', () =>
          Effect.gen(function* testEffect() {
            const child = yield* SharedChild;
            firstSharedId = child.id;
            assert.isTrue(child.id === 1 || child.id === 2);
          }),
        );
      });

      suiteIt3.layer(sharedChildLayer)('second sibling', (suiteIt5) => {
        suiteIt5.effect('allocates an isolated child', () =>
          Effect.gen(function* testEffect() {
            const child = yield* SharedChild;
            secondSharedId = child.id;
            assert.isTrue(child.id === 1 || child.id === 2);
          }),
        );
      });
    });

    afterAll(() => {
      expect(firstSharedId).not.toEqual(secondSharedId);
      expect(nextSharedId).toEqual(2);
      expect(releasedSharedIds.toSorted((a, b) => a - b)).toEqual([1, 2]);
    });
  });
});

describe('nested sibling isolation with provided state graph', () => {
  const parentLayer = Layer.succeed(Parent)('parent');

  let nextId = 0;
  let firstStateId = -1;
  let secondStateId = -1;

  const baseLayer = Layer.effect(State)(
    Effect.gen(function* testEffect() {
      nextId += 1;
      const id = nextId;
      const todos = yield* Ref.make<string[]>([]);
      const migrated = yield* Ref.make(false);
      return { id, migrated, todos };
    }),
  );

  const migrationLayer = Layer.effectDiscard(
    Effect.gen(function* testEffect() {
      const state = yield* State;
      yield* Ref.set(state.migrated, true);
    }),
  );

  const migratedLayer = Layer.merge(baseLayer, migrationLayer.pipe(Layer.provide(baseLayer)));

  const inMemoryLayer = Layer.effect(TodoService)(
    Effect.gen(function* testEffect() {
      const state = yield* State;
      return {
        add: (title: string) => Ref.update(state.todos, (todos) => [...todos, title]),
        list: Ref.get(state.todos),
        migrated: Ref.get(state.migrated),
        stateId: Effect.succeed(state.id),
      } as const;
    }),
  ).pipe(Layer.provide(migratedLayer));

  layer(parentLayer)('parent', (suiteIt6) => {
    suiteIt6.layer(inMemoryLayer)('first sibling', (suiteIt7) => {
      suiteIt7.effect('mutates isolated provided state', () =>
        Effect.gen(function* testEffect() {
          const service = yield* TodoService;
          firstStateId = yield* service.stateId;

          assert.isTrue(yield* service.migrated);
          yield* service.add('write tests');
          assert.deepStrictEqual(yield* service.list, ['write tests']);
        }),
      );
    });

    suiteIt6.layer(inMemoryLayer)('second sibling', (suiteIt8) => {
      suiteIt8.effect('starts fresh with a new provided state', () =>
        Effect.gen(function* testEffect() {
          const service = yield* TodoService;
          secondStateId = yield* service.stateId;

          assert.isTrue(yield* service.migrated);
          assert.deepStrictEqual(yield* service.list, []);

          yield* service.add('ship feature');
          assert.deepStrictEqual(yield* service.list, ['ship feature']);
        }),
      );
    });

    afterAll(() => {
      expect(firstStateId).toEqual(1);
      expect(secondStateId).toEqual(2);
      expect(nextId).toEqual(2);
    });
  });
});

it('exposes nested layer API', () => {
  expect(it.layer).toBeTypeOf('function');
});
