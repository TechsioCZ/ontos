// Near-miss identifiers: only the exact ambientKeys are threaded identity.
export interface SnakeScope {
	readonly correlation_id: string;
	readonly CorrelationId: string;
	readonly correlationID: string;
	readonly correlationIds: readonly string[];
	readonly traceIdHeader: string;
}

export const snake = (correlation_id: string, traceIds: readonly string[]) => `${correlation_id}${traceIds.length}`;

export const templated = (id: string) => `correlationId=${id}`;

// correlationId: string
export const commented = (id: string) => id;

export enum Kind {
	correlationId = 'correlationId',
}
