// expect-count: 10
// Action/Read runtimes and the permission service repeat identity by hand (audit A6).
import { Context, Effect, Layer } from 'effect';

declare const input: {
	registration: { descriptor: { actionKey: string; readKey: string } };
	correlationId: string;
};
declare const invocation: { actionInvocationId: string };
declare const transport: { correlationId: string };

export const runAction = Effect.gen(function* runActionEffect() {
	yield* Effect.annotateLogs(Effect.logError('Action permission denied'), {
		actionKey: input.registration.descriptor.actionKey,
		correlationId: transport.correlationId,
		invocationId: invocation.actionInvocationId,
	});
	yield* Effect.annotateLogs(Effect.logError('Unexpected governed read defect'), {
		correlationId: transport.correlationId,
		readKey: input.registration.descriptor.readKey,
	});
});

export const checkActionPermission = Effect.succeed('allowed').pipe(
	Effect.withSpan('SpiceDB.checkActionPermission', {
		attributes: {
			actionKey: input.registration.descriptor.actionKey,
			correlationId: input.correlationId,
		},
	}),
);

export const unavailable = Effect.fail('unavailable').pipe(
	Effect.withSpan('SpiceDB.checkActionPermission', {
		attributes: { actionKey: input.registration.descriptor.actionKey, correlationId: input.correlationId },
	}),
);

export const AresLayer = Layer.effect(
	Context.GenericTag('Ares'),
	Effect.succeed(1).pipe(
		Effect.annotateLogs({
			correlationId: input.correlationId,
			ico: '12345678',
			operation: 'subject',
			provider: 'ares',
		}),
		Effect.withSpan('Contacts.ARES.subject'),
	),
);
