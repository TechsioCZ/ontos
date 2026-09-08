// expect-count: 3
// The rule resolves `annotateLogs` when it is imported directly (`import { annotateLogs } from
// "effect/Effect"`), but the equivalent local binding taken off the namespace is invisible, so a
// one-line `const { annotateLogs } = Effect` sheds the rule while keeping the same anti-pattern.
import { Effect } from 'effect';

declare const identity: { correlationId: string; readKey: string; actionKey: string };

// 1: member reference held in a local const, then called.
const annotate = Effect.annotateLogs;
export const viaReference = annotate(Effect.logError('Unexpected defect'), {
	correlationId: identity.correlationId,
});

// 2 + 3: members destructured off the namespace.
const { annotateLogs, withSpan } = Effect;
export const viaDestructured = annotateLogs({ readKey: identity.readKey });
export const viaDestructuredSpan = Effect.void.pipe(
	withSpan('Contacts.read', { attributes: { actionKey: identity.actionKey } }),
);
