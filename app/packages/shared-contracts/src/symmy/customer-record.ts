import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Config, Effect, Schema } from 'effect';

const MAX_SOURCE_RECORD_LENGTH = 200;
const derivedRecord = /^symmy-customer:[0-9a-f]{64}$/u;
export const symmyCustomerRecordSeed = (customerId: string): string => `customer-record\u0000${customerId}`;

/** Preserve the exact main mapping, including every previously admitted literal prefixed id. */
export const symmyCustomerRecordProjection = <T>(
  customerId: string,
  literal: (id: string) => T,
  derive: (seed: string, name: (hash: string) => string) => T,
): T =>
  customerId.length <= MAX_SOURCE_RECORD_LENGTH && customerId === customerId.trim()
    ? literal(customerId)
    : derive(symmyCustomerRecordSeed(customerId), (hash) => `symmy-customer:${hash}`);
export const symmyCustomerSourceRecordId = <E>(
  customerId: string,
  digest: (value: string) => Effect.Effect<string, E>,
) =>
  symmyCustomerRecordProjection<Effect.Effect<string, E>>(customerId, Effect.succeed, (seed, name) =>
    digest(seed).pipe(Effect.map(name)),
  );
const originSchema = Schema.Struct({
  issuer: Schema.NonEmptyString,
  namespace: Schema.NonEmptyString,
  recordType: Schema.NonEmptyString,
  tenantId: Schema.toEncoded(TenantIdSchema),
});
const claimSchema = Schema.Struct({
  ...originSchema.fields,
  recordId: Schema.toEncoded(
    Schema.String.check(Schema.isPattern(derivedRecord)).pipe(Schema.brand('SymmyAmbiguousCustomerRecordId')),
  ),
  wireDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
const provenance = Config.schema(
  Schema.fromJsonString(Schema.Array(claimSchema)),
  'ONTOS_SYMMY_CUSTOMER_RECORD_PROVENANCE',
).pipe(Config.withDefault([]));

/** Main's literal and derived id ranges overlap only here. No observation of a prefix is proof of its origin.
 * An exact source-owned identity is required on both intake and lookup; an absent or contradictory claim admits neither.
 * The claim is at the source's tenant/issuer/namespace/type, unchanged by a route replacement or a fresh request key. */
export const symmyCustomerRecordProven = Effect.fn('SymmyCustomerRecord.proven')(function* proven<E>(
  origin: typeof originSchema.Type,
  customerId: string,
  recordId: string,
  digest: (value: string) => Effect.Effect<string, E>,
) {
  if (!derivedRecord.test(recordId)) {
    return true;
  }
  const claims = (yield* provenance).filter(
    (claim) =>
      claim.tenantId === origin.tenantId &&
      claim.issuer === origin.issuer &&
      claim.namespace === origin.namespace &&
      claim.recordType === origin.recordType &&
      claim.recordId === recordId,
  );
  return claims.length === 1 && claims[0]?.wireDigest === (yield* digest(symmyCustomerRecordSeed(customerId)));
});
