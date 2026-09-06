// @effect-diagnostics asyncFunction:off globalDate:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { GatewayAssertionRedemption, TrustedPrincipalContext } from '@app/core-runtime';
import { GatewayAssertionReplayError, loadDatabaseConnectionPair } from '@app/core-runtime';
import { GATEWAY_ASSERTION_TTL_SECONDS, GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Redacted } from 'effect';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { verifyActionPrincipal } from '../../api/auth/action-principal.ts';
import { makeGatewayAssertionRedemption } from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { contactsRelations, gatewayAssertionRedemptions } from '../../src/db/schema.ts';

const now = 1_800_000_000;
const issuer = 'https://shell.authorization-matrix.test';

const principal = (credential: 'api_key' | 'session'): TrustedPrincipalContext => ({
  authBindingId:
    credential === 'session'
      ? 'a1000000-0000-4000-8000-000000000001'
      : 'a1000000-0000-4000-8000-000000000002',
  authContextRef:
    credential === 'session'
      ? 'better-auth-session:authorization-matrix'
      : 'better-auth-api-key:authorization-matrix',
  authMethod: credential,
  principalId: 'a2000000-0000-4000-8000-000000000001',
  tenantId: 'a3000000-0000-4000-8000-000000000001',
});

const makeBoundary = async () => {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const environment = {
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
      keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'authorization-matrix', use: 'sig' }],
    }),
  };
  const consumed = new Set<string>();
  let writes = 0;
  const redemption: GatewayAssertionRedemption = {
    consume: ({ audience, issuer: assertionIssuer, jti }) => {
      const key = `${assertionIssuer}\0${audience}\0${jti}`;
      return consumed.has(key)
        ? Effect.fail(new GatewayAssertionReplayError({ reason: 'already consumed' }))
        : Effect.sync(() => {
            consumed.add(key);
            writes += 1;
          });
    },
  };
  const issue = async (
    credential: 'api_key' | 'session',
    options: { readonly audience?: string; readonly issuedAt?: number } = {},
  ) => {
    const audience = options.audience ?? 'contacts';
    const issuedAt = options.issuedAt ?? now;
    const expiresAt = issuedAt + GATEWAY_ASSERTION_TTL_SECONDS;
    const assertionPrincipal = principal(credential);
    const token = await new SignJWT({
      principal: assertionPrincipal,
      ver: GATEWAY_ASSERTION_VERSION,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'authorization-matrix', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(assertionPrincipal.principalId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(privateKey);
    return { expiresAt, token };
  };
  const verifyEffect = (token: string) =>
    verifyActionPrincipal(`Bearer ${token}`, {
      currentTimeSeconds: Effect.succeed(now + 1),
      environment,
      redemption,
    });
  const verify = async (token: string) => await Effect.runPromise(verifyEffect(token));
  return { issue, verify, verifyEffect, writes: () => writes };
};

for (const credential of ['session', 'api_key'] as const) {
  test(`${credential} Shell assertions cross the Contacts receiver once and fresh retries remain valid`, async () => {
    const boundary = await makeBoundary();
    const first = await boundary.issue(credential);
    const verifiedFirst = await boundary.verify(first.token);
    assert.equal(verifiedFirst.authMethod, credential);
    await assert.rejects(
      boundary.verify(first.token),
      (error: { readonly _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const retry = await boundary.issue(credential);
    const verifiedRetry = await boundary.verify(retry.token);
    assert.equal(verifiedRetry.authMethod, credential);
    assert.equal(boundary.writes(), 2);
  });

  test(`${credential} expired and wrong-audience assertions fail before redemption`, async () => {
    const boundary = await makeBoundary();
    const expired = await boundary.issue(credential, { issuedAt: now - 1000 });
    const wrongAudience = await boundary.issue(credential, { audience: 'billing' });
    const failures = await Promise.all([
      Effect.runPromise(Effect.flip(boundary.verifyEffect(expired.token))),
      Effect.runPromise(Effect.flip(boundary.verifyEffect(wrongAudience.token))),
    ]);
    assert.deepEqual(
      failures.map(({ _tag }) => _tag),
      ['ActionPrincipalExpiredError', 'ActionPrincipalScopeError'],
    );
    assert.equal(boundary.writes(), 0);
    const serialized = JSON.stringify(failures);
    assert.doesNotMatch(
      serialized,
      new RegExp([expired.token, wrongAudience.token].join('|'), 'u'),
    );
    assert.doesNotMatch(serialized, /a2000000|a3000000/u);
  });

  test(`${credential} concurrent replay admits exactly one Contacts request`, async () => {
    const boundary = await makeBoundary();
    const assertion = await boundary.issue(credential);
    const outcomes = await Promise.allSettled([
      boundary.verify(assertion.token),
      boundary.verify(assertion.token),
    ]);
    assert.deepEqual(outcomes.map(({ status }) => status).toSorted(), ['fulfilled', 'rejected']);
    assert.equal(boundary.writes(), 1);
  });
}

test('owner-local redemption atomically rejects replay and prunes expired rows', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const pool = new Pool({ connectionString: Redacted.value(connections.admin.connectionString) });
  const database = drizzle({ client: pool, relations: contactsRelations });
  const redemption = makeGatewayAssertionRedemption(database);
  const databaseIssuer = 'https://shell.redemption-cleanup.test';
  const futureExpiry = Math.floor(Date.now() / 1000) + 300;
  const cleanup = () =>
    database
      .delete(gatewayAssertionRedemptions)
      .where(eq(gatewayAssertionRedemptions.issuer, databaseIssuer));
  try {
    await cleanup();
    await database.insert(gatewayAssertionRedemptions).values({
      audience: 'contacts',
      expiresAt: new Date(0),
      issuer: databaseIssuer,
      jti: randomUUID(),
    });
    const firstJti = randomUUID();
    const first = {
      audience: 'contacts',
      expiresAtEpochSeconds: futureExpiry,
      issuer: databaseIssuer,
      jti: firstJti,
    };
    await Effect.runPromise(redemption.consume(first));
    const replay = await Effect.runPromise(Effect.flip(redemption.consume(first)));
    assert.equal(replay._tag, 'GatewayAssertionReplayError');

    const concurrent = { ...first, jti: randomUUID() };
    const outcomes = await Promise.allSettled([
      Effect.runPromise(redemption.consume(concurrent)),
      Effect.runPromise(redemption.consume(concurrent)),
    ]);
    assert.deepEqual(outcomes.map(({ status }) => status).toSorted(), ['fulfilled', 'rejected']);
    const rows = await database
      .select({ jti: gatewayAssertionRedemptions.jti })
      .from(gatewayAssertionRedemptions)
      .where(eq(gatewayAssertionRedemptions.issuer, databaseIssuer));
    assert.deepEqual(rows.map(({ jti }) => jti).toSorted(), [firstJti, concurrent.jti].toSorted());
  } finally {
    await cleanup();
    await pool.end();
  }
});
