// expect-count: 2
// The rule advertises computed namespace access (`Effect["annotateLogs"]`) and already owns a
// `literalString` helper that understands single-quasi template literals, but `memberName` only
// accepts a string `Literal`, so the backtick spelling of the very same access evades it.
import { Effect } from 'effect';

declare const identity: { correlationId: string; tenantId: string };

export const templateAnnotate = Effect[`annotateLogs`](Effect.void, {
	correlationId: identity.correlationId,
});

export const templateSpan = Effect.void.pipe(
	Effect[`withSpan`]('Contacts.read', { attributes: { tenantId: identity.tenantId } }),
);
