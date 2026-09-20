import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { ConfigProvider, Effect } from 'effect';
import type { Layer } from 'effect';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, KeyObject } from 'jose';

import type { CoreDatabaseExecutor } from '../../../../packages/core-runtime/src/db/types.ts';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '../../../../packages/shared-contracts/src/gateway-context.ts';

/**
 * A portal gateway issuer for acceptance suites: an Ed25519 key pair, the verification material the
 * deployed verifier reads as configuration, and the namespace-carrying assertion a portal session
 * presents. The assertion lifetime is the real one, and its instant is read from the deployment's
 * own PostgreSQL clock: virtual time would place every assertion outside its own validity window,
 * and the database is the clock both sides of this acceptance already trust.
 */
export interface AcceptanceGatewayIssuer {
  readonly issuer: string;
  readonly keyId: string;
  readonly privateKey: CryptoKey | KeyObject;
  readonly publicJwk: JWK;
  /** The verification material, shaped for the deployed verifier's configuration keys. */
  readonly verificationLive: Layer.Layer<never>;
}

export const makeAcceptanceGatewayIssuer = Effect.fnUntraced(function* makeAcceptanceGatewayIssuer(
  issuer: string,
  keyId: string,
) {
  const pair = yield* Effect.promise(async () => await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
  const exported = yield* Effect.promise(async () => await exportJWK(pair.publicKey));
  const publicJwk: JWK = { ...exported, alg: 'EdDSA', kid: keyId, use: 'sig' };
  return {
    issuer,
    keyId,
    privateKey: pair.privateKey,
    publicJwk,
    verificationLive: ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      }),
    ),
  } satisfies AcceptanceGatewayIssuer;
});

export interface AcceptanceGatewayPrincipal {
  readonly authBindingId: string;
  readonly authContextRef: string;
  readonly authenticationNamespaceId: string;
  readonly authMethod: 'session';
  /** Omitted for a caller whose operation forbids a Legal Entity in its operational scope. */
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

interface EpochRow extends Record<string, unknown> {
  readonly epoch: string;
}

/** Mints one fresh, single-use version-2 gateway assertion for the given audience. */
export const issueAcceptanceGatewayAssertion = Effect.fnUntraced(function* issueAcceptanceGatewayAssertion(
  executor: Pick<CoreDatabaseExecutor, 'execute'>,
  gateway: AcceptanceGatewayIssuer,
  audience: string,
  principal: AcceptanceGatewayPrincipal,
) {
  const epochRows = yield* executor.execute<EpochRow>(
    sql`select floor(extract(epoch from statement_timestamp()))::bigint::text as epoch`,
    'objects',
  );
  const [epochRow] = epochRows;
  if (epochRow === undefined) {
    return yield* Effect.die('The acceptance gateway could not read the deployment clock');
  }
  const issuedAt = Math.trunc(Number(epochRow.epoch));
  return yield* Effect.promise(
    async () =>
      await new SignJWT({ principal, ver: EXTERNAL_GATEWAY_ASSERTION_VERSION })
        .setProtectedHeader({ alg: 'EdDSA', kid: gateway.keyId, typ: 'JWT' })
        .setAudience(audience)
        .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
        .setIssuedAt(issuedAt)
        .setIssuer(gateway.issuer)
        .setJti(randomUUID())
        .setSubject(principal.principalId)
        .sign(gateway.privateKey),
  );
});
