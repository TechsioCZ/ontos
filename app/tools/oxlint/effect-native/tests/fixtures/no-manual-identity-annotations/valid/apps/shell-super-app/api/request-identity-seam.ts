// The single outer HTTP instrumentation seam A6 asks for: matches `seamFiles`, so it may annotate once.
import { Effect } from '@modern-js/plugin-bff/effect-edge';

declare const handler: Effect.Effect<unknown>;
declare const request: { headers: Record<string, string | undefined> };

export const withRequestIdentity = handler.pipe(
	Effect.annotateLogs({
		correlationId: request.headers['x-correlation-id'] ?? 'missing',
		legalEntityId: request.headers['x-legal-entity-id'] ?? 'missing',
		principalId: request.headers['x-principal-id'] ?? 'missing',
		tenantId: request.headers['x-tenant-id'] ?? 'missing',
	}),
	Effect.withSpan('Shell.request', {
		attributes: {
			correlationId: request.headers['x-correlation-id'] ?? 'missing',
			tenantId: request.headers['x-tenant-id'] ?? 'missing',
		},
		kind: 'server',
	}),
);
