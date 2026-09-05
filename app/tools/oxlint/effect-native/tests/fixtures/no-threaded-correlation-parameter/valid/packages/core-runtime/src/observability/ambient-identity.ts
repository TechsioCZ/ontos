// The A6 target shape: identity is ambient, read with `yield*`, and reaches spans/annotations.
import { Context, Effect } from 'effect';
import { Effect as E } from 'effect';
import * as Schema from 'effect/Schema';

export class RequestIdentity extends Context.Reference<RequestIdentity>()('RequestIdentity', {
	defaultValue: () => ({ correlationId: 'unknown', traceId: 'unknown' }),
}) {}

export const RequestIdentityFields = Schema.Struct({
	correlationId: Schema.String,
	traceId: Schema.String,
});

export const currentScope = Effect.gen(function* () {
	const { correlationId, traceId } = yield* RequestIdentity;
	yield* Effect.annotateLogs({ correlationId, traceId });
	return yield* E.withSpan('scope', { attributes: { correlationId, traceId } });
});

export const forwardPrincipal = (identity: { readonly principalId: string }) => identity.principalId;

export const readIdentity = Effect.gen(function* () {
	const identity = yield* RequestIdentity;
	return { annotated: identity.correlationId, trace: identity.traceId };
});
