// Business keys that merely resemble an identity key must not be reported: the rule normalises keys
// case- and separator-insensitively and strips `x`/`http`/`otel`/`ontos` header prefixes, so these
// near misses pin that the normalisation is not over-eager.
import { Effect } from 'effect';

declare const value: string;

export const nearMisses = Effect.annotateLogs(Effect.logInfo('cycle'), {
	correlationIdSource: value,
	tenantIdentity: value,
	moduleIdentifier: value,
	readKeys: value,
	principal: value,
	sessionIdle: value,
	traceIdle: value,
	deploymentIdentifier: value,
	keyAction: value,
});

export const spanFacts = Effect.void.pipe(
	Effect.withSpan('Contacts.list.load', { attributes: { rowCount: 10 }, kind: 'server', root: true }),
);
