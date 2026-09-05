// expect-count: 5
import { Effect } from "effect";

export interface OutboxClaim {
	readonly outboxId: string;
}

export interface ArchivedClaim {
	readonly archivedAt: string;
}

export class OutboxPersistenceError extends Error {}

/** Audit A2/B5 evidence shape: `outbox/repository.ts:76`. */
export interface OutboxRepositoryService {
	readonly claimNext: (limit: number) => Effect.Effect<OutboxClaim | null, OutboxPersistenceError>;
	claimBatch(limit: number): Effect.Effect<OutboxClaim | undefined, OutboxPersistenceError>;
	readonly loadState: () => Effect.Effect<(OutboxClaim | undefined), OutboxPersistenceError>;
	readonly peek: () => Effect.Effect<OutboxClaim | (ArchivedClaim | null), OutboxPersistenceError>;
	readonly count: () => Effect.Effect<number, OutboxPersistenceError>;
	readonly maybeRunner: (() => Effect.Effect<OutboxClaim, OutboxPersistenceError>) | undefined;
}

export type ClaimNext = (limit: number) => Effect.Effect<OutboxClaim | null, OutboxPersistenceError>;
