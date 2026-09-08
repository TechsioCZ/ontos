import * as E from 'effect';

/** Root-barrel namespace import: `E.Context.Service` is still a tag. */
export interface OutboxRepositoryPort {
  readonly claim: (limit: number) => E.Effect.Effect<readonly string[], Error>;
}

export class OutboxRepository extends E.Context.Service<OutboxRepository, OutboxRepositoryPort>()(
  '@app/core-runtime/outbox/OutboxRepository',
) {}
