/**
 * FALSE POSITIVE regression fixture (currently reported — this file is expected to be silent).
 *
 * Reproduces `apps/shell-super-app/src/api/auth-client.ts:278` (`createNonHumanPrincipal`).
 *
 * `createNonHumanPrincipal` is not a factory: it is a browser-side HTTP *mutation* whose `create`
 * prefix is the CRUD verb of the remote operation, not a constructor. Its `IdentityClientOptions`
 * parameter is `{ idempotencyKey } & { cookie?, locale? }` — per-call request values, not
 * collaborators, so "make each collaborator a `Context.Service` the body `yield*`s" is inapplicable.
 * The proof that the report is name-coincidence rather than structure: `changePrincipalStatus`
 * below has the byte-identical `(payload, options: IdentityClientOptions)` shape and the identical
 * `.pipe(` body, and is silent only because its name does not start with make/create/build/define.
 */
import { Effect } from 'effect';

export interface ShellAuthenticationClientOptions {
	readonly cookie?: string;
	readonly locale?: string;
}

export interface IdentityClientOptions extends ShellAuthenticationClientOptions {
	readonly idempotencyKey: string;
}

const identityHeaders = (options: IdentityClientOptions) => ({
	'idempotency-key': options.idempotencyKey,
});

declare const createShellAuthenticationClient: (
	options: ShellAuthenticationClientOptions,
) => Effect.Effect<{
	readonly identity: {
		readonly changePrincipalStatus: (request: unknown) => Effect.Effect<PrincipalMutationResponse>;
		readonly createNonHumanPrincipal: (request: unknown) => Effect.Effect<PrincipalMutationResponse>;
	};
}>;

export interface PrincipalMutationResponse {
	readonly principalId: string;
}

export const createNonHumanPrincipal = (
	payload: { readonly displayName: string },
	options: IdentityClientOptions,
): Effect.Effect<PrincipalMutationResponse> =>
	createShellAuthenticationClient(options).pipe(
		Effect.flatMap((client) =>
			client.identity.createNonHumanPrincipal({ headers: identityHeaders(options), payload }),
		),
	);

/** Byte-identical shape, silent today purely because of the name prefix. */
export const changePrincipalStatus = (
	payload: { readonly newStatus: string },
	options: IdentityClientOptions,
): Effect.Effect<PrincipalMutationResponse> =>
	createShellAuthenticationClient(options).pipe(
		Effect.flatMap((client) =>
			client.identity.changePrincipalStatus({ headers: identityHeaders(options), payload }),
		),
	);
