// expect-count: 6
import * as EffectModule from "effect/Effect";

export interface OutboxClaim {
	readonly outboxId: string;
}

export class OutboxPersistenceError extends Error {}

/** Bodyless members via an aliased outcome, in a .tsx file, through a submodule namespace import. */
type ClaimEffect = EffectModule.Effect<OutboxClaim | null, OutboxPersistenceError>;

export abstract class OutboxRepositoryBase {
	abstract claimNext(): ClaimEffect;
	abstract loadClaim(outboxId: string): Promise<OutboxClaim | undefined>;
	protected abstract peek(): EffectModule.Effect<OutboxClaim | null, OutboxPersistenceError>;
	abstract get pending(): Promise<OutboxClaim | undefined>;
}

export declare abstract class AmbientOutboxRepository {
	claimNext(): ClaimEffect;
	static loadClaim(outboxId: string): Promise<OutboxClaim | undefined>;
}
