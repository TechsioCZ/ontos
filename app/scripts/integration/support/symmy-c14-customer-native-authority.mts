import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Schema } from 'effect';

const principalSchema = Schema.Struct({
  principalId: TrustedPrincipalContextSchema.fields.principalId,
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
});
export const customerFixtureUuid = Effect.gen(function* customerFixtureUuid() {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4();
});

/** Explicit native fixture authority only. Business owner records are never created here. */
export const seedCustomerFixtureProviderPrincipal = Effect.fn('SymmyC14Customer.seedPrincipal')(function* seedPrincipal(
  admin: PgClient.PgClient,
  tenantId: string,
  kind: 'integration' | 'service',
  providerUserId: string,
) {
  const principalId = yield* customerFixtureUuid;
  const issuerPrincipalId = yield* customerFixtureUuid;
  const bindingId = yield* customerFixtureUuid;
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
    values(${principalId},${tenantId},${kind},'active','INTERNAL_C14 current machine fixture principal'),
      (${issuerPrincipalId},${tenantId},'human','active','INTERNAL_C14 actual provider key issuer')`;
  yield* admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
    values(${bindingId},${tenantId},${issuerPrincipalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','user',${providerUserId},'active')`;
  return { ...(yield* Schema.decodeUnknownEffect(principalSchema)({ principalId, tenantId })), issuerPrincipalId };
});

export const bindCustomerFixtureProviderKey = Effect.fn('SymmyC14Customer.bindProviderKey')(function* bindProviderKey(
  admin: PgClient.PgClient,
  principal: typeof principalSchema.Type,
  providerKeyId: string,
) {
  const bindingId = yield* customerFixtureUuid;
  yield* admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
    values(${bindingId},${principal.tenantId},${principal.principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','api_key',${providerKeyId},'active')`;
});
