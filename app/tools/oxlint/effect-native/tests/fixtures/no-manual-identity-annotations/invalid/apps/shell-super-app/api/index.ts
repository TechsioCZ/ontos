// expect-count: 7
// Shell BFF: every handler group repeats the same correlation annotation (audit A6, index.ts:724).
import { Effect, HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Cause } from 'effect';

declare const ShellApi: never;
declare const authenticationInternalProblem: () => never;
declare const tenantInternalProblem: () => never;

export const authenticationGroupLive = HttpApiBuilder.group(ShellApi, 'authentication', (handlers) =>
	handlers
		.handle('currentSession', ({ request }) =>
			Effect.succeed(1).pipe(
				Effect.catchCause((cause) =>
					Cause.hasDies(cause)
						? Effect.annotateLogs(Effect.logError('Unexpected defect', cause), {
								correlationId: request.headers['x-correlation-id'] ?? 'missing',
							}).pipe(Effect.andThen(Effect.fail(authenticationInternalProblem())))
						: Effect.failCause(cause),
				),
			),
		)
		.handle('switchTenant', ({ payload, request }) =>
			Effect.succeed(payload).pipe(
				Effect.catchCause((cause) =>
					Effect.annotateLogs(Effect.logError('Unexpected tenant switch defect', cause), {
						correlationId: request.headers['x-correlation-id'] ?? 'missing',
						tenantId: payload.tenantId,
						failureStage: 'switch',
					}).pipe(Effect.andThen(Effect.fail(tenantInternalProblem()))),
				),
			),
		)
		.handle('switchLegalEntity', ({ payload, request }) =>
			Effect.succeed(payload).pipe(
				Effect.annotateLogs({
					correlationId: request.headers['x-correlation-id'] ?? 'missing',
					legalEntityId: payload.legalEntityId,
					principalId: payload.principalId,
				}),
				Effect.withSpan('Shell.switchLegalEntity', {
					attributes: { impersonatorPrincipalId: payload.impersonatorPrincipalId, outcome: 'ok' },
					kind: 'server',
				}),
			),
		),
);
