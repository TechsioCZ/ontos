// expect-count: 2
import { Effect } from "effect";

export interface OutboxClaim {
	readonly outboxId: string;
}

/** Test doubles that implement a nullable port keep the port nullable, so tests are linted too. */
export const fakeRepository = {
	claimNext: (): Effect.Effect<OutboxClaim | null, never> => Effect.succeed(null),
	loadClaim: async (): Promise<OutboxClaim | undefined> => undefined,
};
