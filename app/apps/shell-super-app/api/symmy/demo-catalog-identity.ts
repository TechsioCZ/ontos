import { Effect } from 'effect';
import { symmyUnavailableProblem } from './contract.ts';
import type { SymmySourceReadScope } from './source-read-projections.ts';

export const symmyDemoCatalogScopeIdentity = (scope: SymmySourceReadScope) =>
  JSON.stringify([
    scope.tenantId,
    scope.legalEntityId,
    scope.issuerId,
    scope.sourceNamespace,
    scope.sourceRouteId ?? scope.routeId,
  ]);

export const symmyDemoCatalogDigest = (value: string) =>
  Effect.tryPromise({
    catch: () => symmyUnavailableProblem,
    try: async () => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
      return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    },
  });

export const symmyDemoCategoryPrefix = (scope: SymmySourceReadScope) =>
  symmyDemoCatalogDigest(symmyDemoCatalogScopeIdentity(scope)).pipe(Effect.map((hash) => `symmy-${hash}-`));

/** Opaque native category identity scoped to the enrolled source and selected company. */
export const symmyDemoCategoryId = (scope: SymmySourceReadScope, code: string) =>
  Effect.gen(function* categoryId() {
    const prefix = yield* symmyDemoCategoryPrefix(scope);
    return `${prefix}${yield* symmyDemoCatalogDigest(code)}`;
  });
