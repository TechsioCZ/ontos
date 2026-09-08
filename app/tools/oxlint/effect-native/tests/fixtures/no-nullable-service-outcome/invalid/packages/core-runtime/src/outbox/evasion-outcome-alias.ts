// expect-count: 4
import { Effect } from "effect";

export interface OutboxClaim {
	readonly outboxId: string;
}

export class OutboxPersistenceError extends Error {}

/** The whole nullable outcome hidden behind a same-file alias of the wrapper. */
type ClaimOutcome = Promise<OutboxClaim | undefined>;
type ClaimEffect = Effect.Effect<OutboxClaim | null, OutboxPersistenceError>;

export interface OutboxRepositoryService {
	readonly claimNext: () => ClaimOutcome;
	claimBatch(): ClaimEffect;
}

export async function loadClaim(): ClaimOutcome {
	return undefined;
}

export const peekClaim = (): ClaimEffect => Effect.succeed(null);
