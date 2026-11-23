import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Option, Schema } from 'effect';
import { symmyUnavailableProblem } from './contract.ts';
import type { SymmySourceReadScope } from './source-read-projections.ts';

const encodeScopeIdentity = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.OptionFromNullOr(Schema.String), Schema.String, Schema.String, Schema.String]),
  ),
);

export const symmyDemoCatalogScopeIdentity = (scope: SymmySourceReadScope) =>
  encodeScopeIdentity([
    scope.tenantId,
    Option.fromUndefinedOr(scope.legalEntityId),
    scope.issuerId,
    scope.sourceNamespace,
    scope.sourceRouteId ?? scope.routeId,
  ]).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));

export const symmyDemoCatalogDigest = (value: string) => Effect.sync(() => bytesToHex(sha256(utf8ToBytes(value))));

export const symmyDemoCategoryPrefix = (scope: SymmySourceReadScope) =>
  symmyDemoCatalogScopeIdentity(scope).pipe(
    Effect.flatMap(symmyDemoCatalogDigest),
    Effect.map((hash) => `symmy-${hash}-`),
  );

/** Opaque native category identity scoped to the enrolled source and selected company. */
export const symmyDemoCategoryId = Effect.fn('SymmyDemoCatalog.categoryId')(function* categoryId(
  scope: SymmySourceReadScope,
  code: string,
) {
  const prefix = yield* symmyDemoCategoryPrefix(scope);
  return `${prefix}${yield* symmyDemoCatalogDigest(code)}`;
});
