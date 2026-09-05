import { Context, Effect, Layer } from 'effect';

export interface ActionRepositoryService {
  readonly load: (id: string) => Effect.Effect<string, Error>;
  readonly save: (id: string) => Promise<void>;
}

export class ActionRepository extends Context.Service<ActionRepository, ActionRepositoryService>()(
  '@app/core-runtime/actions/ActionRepository',
) {}

export const ActionRepositoryLive = Layer.effect(
  ActionRepository,
  Effect.succeed({ load: () => Effect.succeed('a'), save: async () => {} }),
);
