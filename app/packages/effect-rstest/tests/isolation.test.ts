import { TodoService } from './support/todo-service.ts';
import { State } from './support/state.ts';
import { Scoped } from './support/scoped.ts';
import { afterAll, assert, describe, it } from '@app/effect-rstest';
import { Effect, Layer, Ref } from 'effect';

describe('top-level it.layer isolation', () => {
  let nextId = 0;
  const observedStateIds: number[] = [];

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

  it.layer(inMemoryLayer)((suiteIt0) => {
    suiteIt0.effect('first block mutates isolated state', () =>
      Effect.gen(function* testEffect() {
        const service = yield* TodoService;
        const stateId = yield* service.stateId;
        const migrated = yield* service.migrated;

        observedStateIds.push(stateId);
        yield* service.add('write tests');

        assert.isTrue(migrated);
        assert.deepStrictEqual(yield* service.list, ['write tests']);
      }),
    );
  });

  it.layer(inMemoryLayer)((suiteIt1) => {
    suiteIt1.effect('second block starts fresh', () =>
      Effect.gen(function* testEffect() {
        const service = yield* TodoService;
        const stateId = yield* service.stateId;
        const migrated = yield* service.migrated;

        observedStateIds.push(stateId);

        assert.isTrue(migrated);
        assert.deepStrictEqual(yield* service.list, []);

        yield* service.add('ship feature');
        assert.deepStrictEqual(yield* service.list, ['ship feature']);
      }),
    );
  });

  it.layer(inMemoryLayer)((suiteIt2) => {
    suiteIt2.effect('third block also starts fresh', () =>
      Effect.gen(function* testEffect() {
        const service = yield* TodoService;
        const stateId = yield* service.stateId;
        const migrated = yield* service.migrated;

        observedStateIds.push(stateId);

        assert.isTrue(migrated);
        assert.deepStrictEqual(yield* service.list, []);
      }),
    );
  });

  afterAll(() => {
    assert.deepStrictEqual(observedStateIds, [1, 2, 3]);
  });
});

describe('unnamed layer release boundary', () => {
  let released = false;

  const scopedLayer = Layer.effect(Scoped)(
    Effect.acquireRelease(Effect.succeed('scoped' as const), () =>
      Effect.sync(() => (released = true)),
    ),
  );

  it.layer(scopedLayer)((suiteIt3) => {
    suiteIt3.effect('uses resource', () =>
      Effect.gen(function* usesResource() {
        const value = yield* Scoped;
        assert.strictEqual(value, 'scoped');
      }),
    );
  });

  it('later test sees released resource', () => {
    assert.isTrue(released);
  });
});
