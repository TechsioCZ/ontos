import type { PgClient } from '@effect/sql-pg';
import { Clock, Crypto, Effect, Encoding, Redacted, Schema } from 'effect';
import type { PlatformError } from 'effect';

import { makeGatewayScopeGrantRegistrar } from '../auth/gateway-scope-grant.ts';
import type { GatewayScopeGrantUnavailableError } from '../auth/gateway-scope-grant.ts';

export interface SyntheticGatewayAssertionInput {
  readonly audience: string;
  readonly expiresAtEpochSeconds: number;
  readonly jti: string;
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** The principal must be an active principal of the tenant; registration refuses anything else. */
export interface RegisterTestGatewayScopeGrantInput {
  readonly audience: string;
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly ttlSeconds?: number;
}

export interface RegisteredTestGatewayScopeGrant {
  readonly assertion: Redacted.Redacted;
  readonly expiresAtEpochSeconds: number;
  readonly jti: string;
}

const DEFAULT_TTL_SECONDS = 300;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * A compact `header.payload.signature` string with the shape `trust.register_gateway_scope_grant`
 * accepts. The signature is not a real signature: the database stores only the assertion digest.
 */
export const makeSyntheticGatewayAssertion = Effect.fn('GatewayScopeGrantTesting.makeSyntheticAssertion')(
  function* makeSyntheticGatewayAssertionEffect(
    input: SyntheticGatewayAssertionInput,
  ): Effect.fn.Return<Redacted.Redacted, Schema.SchemaError> {
    const header = Encoding.encodeBase64Url(yield* encodeJson({ alg: 'none', typ: 'ontos-test-gateway' }));
    const payload = Encoding.encodeBase64Url(
      yield* encodeJson({
        aud: input.audience,
        exp: input.expiresAtEpochSeconds,
        jti: input.jti,
        principal:
          input.legalEntityId === undefined
            ? { principalId: input.principalId, tenantId: input.tenantId }
            : { legalEntityId: input.legalEntityId, principalId: input.principalId, tenantId: input.tenantId },
        sub: input.principalId,
      }),
    );
    const signature = Encoding.encodeBase64Url(`synthetic:${input.jti}`);
    return Redacted.make(`${header}.${payload}.${signature}`);
  },
);

/**
 * Registers a synthetic assertion through the production registrar on an issuer client (a
 * `shell_gateway_issuer` login), exactly as Shell does before the token leaves the issuer. The jti
 * comes from the ambient `Crypto` service.
 */
export const registerTestGatewayScopeGrant = Effect.fn('GatewayScopeGrantTesting.register')(
  function* registerTestGatewayScopeGrantEffect(
    issuer: PgClient.PgClient,
    input: RegisterTestGatewayScopeGrantInput,
  ): Effect.fn.Return<
    RegisteredTestGatewayScopeGrant,
    GatewayScopeGrantUnavailableError | PlatformError.PlatformError | Schema.SchemaError,
    Crypto.Crypto
  > {
    const crypto = yield* Crypto.Crypto;
    const jti = yield* crypto.randomUUIDv4;
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const expiresAtEpochSeconds = nowSeconds + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    const tenantScopedInput: SyntheticGatewayAssertionInput = {
      audience: input.audience,
      expiresAtEpochSeconds,
      jti,
      principalId: input.principalId,
      tenantId: input.tenantId,
    };
    const assertionInput: SyntheticGatewayAssertionInput =
      input.legalEntityId === undefined
        ? tenantScopedInput
        : { ...tenantScopedInput, legalEntityId: input.legalEntityId };
    const assertion = yield* makeSyntheticGatewayAssertion(assertionInput);
    yield* makeGatewayScopeGrantRegistrar(issuer).register({ ...assertionInput, assertion });
    return { assertion, expiresAtEpochSeconds, jti };
  },
);

/**
 * Deletes every gateway scope grant of `tenantIds` through an admin client. Grants live in
 * `trust.gateway_scope_grants`, which no runtime role may delete from, so tests clean them by tenant.
 */
export const deleteTestGatewayScopeGrants = (admin: PgClient.PgClient, tenantIds: readonly string[]) =>
  Effect.forEach(
    tenantIds,
    (tenantId) => admin`delete from trust.gateway_scope_grants where tenant_id = ${tenantId}::uuid`,
    { concurrency: 1, discard: true },
  );

/** Registers a scope finalizer that deletes the gateway scope grants of `tenantIds` through `admin`. */
export const addTestGatewayScopeGrantCleanup = (admin: PgClient.PgClient, tenantIds: readonly string[]) =>
  Effect.addFinalizer(() => deleteTestGatewayScopeGrants(admin, tenantIds).pipe(Effect.orDie));
