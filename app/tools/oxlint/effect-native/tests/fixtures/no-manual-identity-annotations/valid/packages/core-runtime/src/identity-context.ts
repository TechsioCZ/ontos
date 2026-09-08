// Identity-named keys outside an Effect annotation call: Schema, service inputs, Context.Reference.
import { Context, Effect, Schema } from 'effect';

export const RequestIdentity = Schema.Struct({
	actionKey: Schema.String,
	correlationId: Schema.String,
	legalEntityId: Schema.String,
	principalId: Schema.String,
	readKey: Schema.String,
	tenantId: Schema.String,
});

export class CurrentRequestIdentity extends Context.Reference<CurrentRequestIdentity>()(
	'@app/core-runtime/identity/CurrentRequestIdentity',
	{ defaultValue: () => ({ correlationId: 'unavailable', tenantId: 'unknown' }) },
) {}

declare const checkPermission: (input: { actionKey: string; correlationId: string }) => Effect.Effect<boolean>;

export const check = Effect.gen(function* checkEffect() {
	const identity = yield* CurrentRequestIdentity;
	return yield* checkPermission({ actionKey: 'contacts.createCustomer', correlationId: identity.correlationId });
});

export const row = { correlationId: 'c-1', moduleId: 'm-1', tenantId: 't-1' };
