// expect-count: 5
import { Predicate } from 'effect';

export interface PrincipalResolverService {
  readonly resolve: (id: string) => string;
}
export interface SupportLifecycleResolver {
  readonly verifySupportImpersonationStarted: () => boolean;
}
export interface Principal {
  readonly principalId: string;
}
export interface Admin {
  readonly role: 'admin';
}
export interface Owner {
  readonly role: 'owner';
}

// Callable capability probing is not a data refinement (silent); the five predicates below report.
const hasSupportLifecycleVerifier = (
  resolver: PrincipalResolverService,
): resolver is PrincipalResolverService & SupportLifecycleResolver =>
  'verifySupportImpersonationStarted' in resolver &&
  Predicate.isFunction(resolver.verifySupportImpersonationStarted);

const isTagged = <Value>(value: Value): value is Value & { readonly _tag: string } =>
  Predicate.isObjectKeyword(value) && value !== null && '_tag' in value;

// Assertion signatures are the same second authority, minus the boolean.
export function assertPrincipal(value: unknown): asserts value is Principal {
  if (!isTagged(value) || typeof (value as Principal).principalId !== 'string') {
    throw new TypeError('not a principal');
  }
}

export function assertPresent(value: unknown): asserts value {
  if (value === null || value === undefined) throw new TypeError('absent');
}

// Type-level positions are authorities too.
export interface AuthorizationGuards {
  readonly isAdmin: (value: unknown) => value is Admin;
  isOwner(value: unknown): value is Owner;
}

export const authGuards = { hasSupportLifecycleVerifier, isTagged };
