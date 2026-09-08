// FALSE POSITIVE regression fixture (adversarial review).
//
// Real site reproduced: packages/core-runtime/src/outbox/repository.ts:56 (`OutboxClaim`).
//
// `OutboxClaim` is a persisted row projection, not a threaded DTO: its `correlationId` is selected
// straight out of the `actionInvocations` table (`.select({ correlationId:
// actionInvocations.correlationId })`, repository.ts:243) and surfaces in a *background worker*
// fiber, in a different process from the request that produced it. Ambient context cannot cross a
// durable database queue, so the row must carry the id; the worker then installs it as ambient.
// The audit's "existing patterns to preserve" list explicitly blesses the outbox/Drizzle
// persistence shapes, and a Drizzle column projection is the same category as the blessed
// JSONB/serialization boundary.
export interface OutboxClaim {
	readonly attemptId: string;
	readonly correlationId?: string;
	readonly deliveryId: string;
	readonly payloadJson: unknown;
	readonly tenantId: string;
}

export const projectClaim = (row: {
	readonly attemptId: string;
	readonly correlationId: null | string;
	readonly deliveryId: string;
	readonly payloadJson: unknown;
	readonly tenantId: string;
}): OutboxClaim => ({ ...row, correlationId: row.correlationId ?? undefined });
