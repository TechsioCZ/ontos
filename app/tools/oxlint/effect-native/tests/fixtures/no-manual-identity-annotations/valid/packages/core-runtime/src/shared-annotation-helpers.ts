// Shared annotation helpers and spreads are already one place; flagSpreadHelpers defaults to false.
import { Effect } from 'effect';

declare const claim: { claimId: string; attemptNumber: number };
declare const claimAnnotations: (claim: unknown, outcome?: string) => Record<string, unknown>;
declare const baseAnnotations: Record<string, unknown>;
declare const operationAttributes: (context: unknown) => Record<string, unknown>;
declare const readinessContext: unknown;

export const handlerDefect = Effect.annotateLogs(
	Effect.logError('Unexpected Outbox Worker handler defect'),
	claimAnnotations(claim, 'handler_defect'),
);

export const finalize = Effect.void.pipe(
	Effect.withSpan('OutboxWorker.finalize', { attributes: claimAnnotations(claim, 'finalized') }),
);

export const readiness = Effect.void.pipe(
	Effect.withSpan('ultramodern.api.contacts.readiness', {
		attributes: operationAttributes(readinessContext),
		kind: 'server',
	}),
);

export const spreadAnnotations = Effect.annotateLogs(Effect.logDebug('cycle'), {
	...baseAnnotations,
	batchSize: 10,
});

export const conditional = Effect.annotateLogs(
	Effect.logError('Unexpected Outbox persistence failure'),
	claim === undefined ? { outcome: 'persistence_failure' } : claimAnnotations(claim, 'persistence_failure'),
);
