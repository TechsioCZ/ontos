// expect-count: 6
import { Effect } from "effect";

export interface Mutation {
	readonly mutationId: string;
}

export class MutationError extends Error {}

export declare function loadMutation(mutationId: string): Promise<Mutation | undefined>;

export interface MutationLoader {
	(mutationId: string): Promise<Mutation | null>;
	new (mutationId: string): Promise<Mutation | undefined>;
}

declare namespace OutboxScaffold {
	interface Ports {
		readonly claimNext: () => Effect.Effect<Mutation | null, MutationError>;
		peek(): Promise<Mutation | undefined>;
	}
}

declare module "outbox-worker" {
	interface Repository {
		load(mutationId: string): Promise<Mutation | undefined>;
	}
}
