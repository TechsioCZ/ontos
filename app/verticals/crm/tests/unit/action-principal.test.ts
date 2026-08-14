// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Effect } from 'effect';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { ACTION_GATEWAY_AUDIENCE, verifyActionPrincipal } from '../../api/auth/action-principal.ts';
import { makeActionGateway } from '../../src/api/action-gateway.ts';

const issuer = 'https://shell.ontos.test';
const now = 1_700_000_000;
const principal = {
  authBindingId: 'a1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:test-session',
  authMethod: 'session' as const,
  principalId: 'a2000000-0000-4000-8000-000000000001',
  tenantId: 'a3000000-0000-4000-8000-000000000001',
};

const makeAssertion = async (audience: string = ACTION_GATEWAY_AUDIENCE) => {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = await exportJWK(publicKey);
  const token = await new SignJWT({ principal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'crm-test', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(principal.principalId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(randomUUID())
    .sign(privateKey);
  return {
    environment: {
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'crm-test', use: 'sig' }],
      }),
    },
    token,
  };
};

test('verifies a signed CRM-audience assertion into trusted principal context', async () => {
  const assertion = await makeAssertion();
  assert.deepEqual(
    await Effect.runPromise(
      verifyActionPrincipal(`Bearer ${assertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: assertion.environment,
      }),
    ),
    principal,
  );
});

test('sanitizes missing, wrong-audience, and malformed assertion failures', async () => {
  const assertion = await makeAssertion('billing');
  const failures = await Promise.all([
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal(undefined, {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
        }),
      ),
    ),
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal(`Bearer ${assertion.token}`, {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
        }),
      ),
    ),
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal('Bearer not-a-jwt', {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
        }),
      ),
    ),
  ]);
  assert.deepEqual(
    failures.map((failure) => failure._tag),
    ['ActionPrincipalMissingError', 'ActionPrincipalScopeError', 'ActionPrincipalInvalidError'],
  );
  assert.equal(JSON.stringify(failures).includes(assertion.token), false);
});

test('acquires a fresh CRM assertion for every gateway invocation', async () => {
  let issued = 0;
  const gateway = makeActionGateway(() =>
    Effect.sync(() => {
      issued += 1;
      return { expiresAt: now + 300, token: `token-${issued}` };
    }),
  );
  assert.equal(await Effect.runPromise(gateway.invoke(Effect.succeed)), 'Bearer token-1');
  assert.equal(await Effect.runPromise(gateway.invoke(Effect.succeed)), 'Bearer token-2');
  assert.equal(issued, 2);
});
