// expect-count: 2
import { Effect } from 'effect';

/** Exported through a separate `export { … }` statement instead of an inline `export interface`. */
interface OutboxDispatchRepository {
  readonly claim: (limit: number) => Effect.Effect<readonly string[], Error>;
}

/** The same seam re-exported with `export type { … }`. */
type OutboxAckGateway = {
  readonly ack: (id: string) => Effect.Effect<void, Error>;
};

export { type OutboxDispatchRepository };
export type { OutboxAckGateway };

export const dispatch = (
  repository: OutboxDispatchRepository,
  gateway: OutboxAckGateway,
): Effect.Effect<void, Error> => Effect.flatMap(repository.claim(1), () => gateway.ack('a'));
