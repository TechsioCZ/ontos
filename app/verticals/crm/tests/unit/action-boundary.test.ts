import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { verifyActionPrincipal } from '../../api/auth/action-principal.ts';
import { makeActionGateway } from '../../src/api/action-gateway.ts';

const issuer = 'https://shell.example.test';
const now = 1_700_000_000;
const principal = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:crm-foundation-test',
  authMethod: 'session' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};

const makeAssertionFixture = async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid: 'crm-test',
    use: 'sig',
  };
  const issue = (audience: string) =>
    new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'crm-test', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(principal.principalId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti('60000000-0000-4000-8000-000000000001')
      .sign(privateKey);
  return {
    environment: {
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    },
    issue,
  };
};

test('accepts only fresh Shell assertions scoped to deployment audience crm', async () => {
  const fixture = await makeAssertionFixture();
  const verify = async (audience: string) =>
    Effect.runPromise(
      verifyActionPrincipal(`Bearer ${await fixture.issue(audience)}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: fixture.environment,
      }),
    );

  assert.deepEqual(await verify('crm'), principal);
  await assert.rejects(
    verify('crm.core'),
    (error: { readonly _tag?: string }) => error._tag === 'ActionPrincipalScopeError',
  );
});

test('obtains a new crm assertion for every governed operation attempt', async () => {
  const audiences: string[] = [];
  let assertions = 0;
  const gateway = makeActionGateway(({ audience }) => {
    audiences.push(audience);
    assertions += 1;
    return Effect.succeed({
      expiresAt: '2030-01-01T00:00:00.000Z',
      token: `assertion-${assertions}`,
    });
  });

  const first = await Effect.runPromise(
    gateway.invoke((authorization) => Effect.succeed(authorization)),
  );
  const second = await Effect.runPromise(
    gateway.invoke((authorization) => Effect.succeed(authorization)),
  );

  assert.equal(first, 'Bearer assertion-1');
  assert.equal(second, 'Bearer assertion-2');
  assert.deepEqual(audiences, ['crm', 'crm']);
});
