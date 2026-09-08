import { Effect, Predicate } from 'effect';

interface PrincipalResolverService {
	readonly resolve: (id: string) => Effect.Effect<string>;
}

interface SupportLifecycleResolver {
	readonly verifySupportImpersonationStarted: (id: string) => Effect.Effect<boolean>;
}

/**
 * False positive reproduction — `apps/shell-super-app/api/auth/service.ts:68`.
 *
 * A capability probe on a `Context.Service` object whose members are Effect-returning functions. A
 * service is not a decoded document; it can never be produced by `Schema.decodeUnknownEffect`, so the
 * rule's remedy ("declare the key in the shared Schema.Struct") is inapplicable. The Effect-native fix
 * is a second Context tag / optional service, which is a different rule's concern.
 */
export const hasSupportLifecycleVerifier = (
	resolver: PrincipalResolverService,
): resolver is PrincipalResolverService & SupportLifecycleResolver =>
	'verifySupportImpersonationStarted' in resolver &&
	Predicate.isFunction(resolver.verifySupportImpersonationStarted);
