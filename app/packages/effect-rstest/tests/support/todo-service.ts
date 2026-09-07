import { Context } from 'effect';
import type { Effect } from 'effect';

export class TodoService extends Context.Service<
  TodoService,
  {
    readonly add: (title: string) => Effect.Effect<void>;
    readonly list: Effect.Effect<string[]>;
    readonly migrated: Effect.Effect<boolean>;
    readonly stateId: Effect.Effect<number>;
  }
>()('@app/effect-rstest/tests/support/todo-service/TodoService') {}
