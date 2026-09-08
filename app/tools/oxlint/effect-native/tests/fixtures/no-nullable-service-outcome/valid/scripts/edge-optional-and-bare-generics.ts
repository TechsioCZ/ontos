export interface Mutation {
	readonly mutationId: string;
}

export class MutationError extends Error {}

/** Optional members, non-absence unions and a bare `Promise` must stay quiet. */
export interface MutationPorts {
	readonly load?: (mutationId: string) => Promise<Mutation>;
	readonly either: () => Promise<Mutation | MutationError>;
	readonly ready: () => Promise<void>;
	readonly raw: () => Promise;
	readonly literals: () => Promise<"pending" | "done">;
}
