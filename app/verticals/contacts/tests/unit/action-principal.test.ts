// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Effect, Redacted } from 'effect';
import {
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime';
import type { GatewayAssertionRedemption } from '@app/core-runtime';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
  ACTION_GATEWAY_AUDIENCE,
  createActionPrincipalVerifier,
  verifyActionPrincipal,
} from '../../api/auth/action-principal.ts';
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

const consumed = new Set<string>();
const redemption: GatewayAssertionRedemption = {
  consume: ({ audience, issuer: assertionIssuer, jti }) =>
    Effect.gen(function* consumeTestAssertion() {
      const key = `${assertionIssuer}\0${audience}\0${jti}`;
      if (consumed.has(key)) {
        return yield* new GatewayAssertionReplayError({ reason: 'unusable' });
      }
      consumed.add(key);
    }),
};

const makeAssertion = async (
  audience: string = ACTION_GATEWAY_AUDIENCE,
  includePrivateKeyMaterial = false,
  claims: {
    readonly expiresAt?: number | false;
    readonly includeJti?: boolean;
    readonly issuedAt?: number;
  } = {},
) => {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    ext: true,
    kid: 'contacts-test',
    use: 'sig',
    x5t: 'public-sha1-thumbprint',
    'x5t#S256': 'public-sha256-thumbprint',
    x5u: 'https://shell.ontos.test/certificates/contacts-test.pem',
  };
  if (includePrivateKeyMaterial) {
    Object.assign(publicJwk, { d: 'private-key-material-must-not-cross-the-boundary' });
  }
  let signer = new SignJWT({ principal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'contacts-test', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(principal.principalId)
    .setIssuedAt(claims.issuedAt ?? now);
  if (claims.expiresAt !== false) {
    signer = signer.setExpirationTime(claims.expiresAt ?? now + 300);
  }
  if (claims.includeJti !== false) {
    signer = signer.setJti(randomUUID());
  }
  const token = await signer.sign(privateKey);
  return {
    environment: {
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    },
    publicJwk,
    token,
  };
};

const acceptingRedemption: GatewayAssertionRedemption = {
  consume: () => Effect.void,
};

test('reuses one real resolver but checks issuer, clock, and redemption on every execution', async (t) => {
  const assertion = await makeAssertion();
  const createResolver = t.mock.fn(createLocalJWKSet);
  const verify = createActionPrincipalVerifier(createResolver);
  const consume = t.mock.fn(() => Effect.void);
  const environment = { ...assertion.environment };
  let currentTime = now + 1;
  const verification = verify(`Bearer ${assertion.token}`, {
    currentTimeSeconds: Effect.sync(() => currentTime),
    environment,
    redemption: { consume },
  });
  assert.deepEqual(await Effect.runPromise(verification), principal);
  assert.deepEqual(await Effect.runPromise(verification), principal);
  assert.deepEqual(await Effect.runPromise(verification), principal);
  assert.equal(createResolver.mock.callCount(), 1);
  assert.equal(consume.mock.callCount(), 3);

  environment.ONTOS_GATEWAY_ISSUER = 'https://other.ontos.test';
  const scopeFailure = await Effect.runPromise(Effect.flip(verification));
  assert.equal(scopeFailure._tag, 'ActionPrincipalScopeError');
  environment.ONTOS_GATEWAY_ISSUER = issuer;
  currentTime = now + 331;
  const expiredFailure = await Effect.runPromise(Effect.flip(verification));
  assert.equal(expiredFailure._tag, 'ActionPrincipalExpiredError');
  currentTime = Number.NaN;
  const clockFailure = await Effect.runPromise(Effect.flip(verification));
  assert.equal(clockFailure._tag, 'ActionPrincipalConfigurationError');
  assert.equal(createResolver.mock.callCount(), 1);
  assert.equal(consume.mock.callCount(), 3);
});

test('same-kid replacement rejects old signatures and evicts the previous resolver', async (t) => {
  const original = await makeAssertion();
  const replacement = await makeAssertion();
  assert.equal(original.publicJwk.kid, replacement.publicJwk.kid);
  assert.notEqual(original.publicJwk.x, replacement.publicJwk.x);
  const createResolver = t.mock.fn(createLocalJWKSet);
  const verify = createActionPrincipalVerifier(createResolver);
  const environment = { ...original.environment };
  const options = {
    currentTimeSeconds: Effect.succeed(now + 1),
    environment,
    redemption: acceptingRedemption,
  };
  assert.deepEqual(await Effect.runPromise(verify(`Bearer ${original.token}`, options)), principal);
  environment.ONTOS_GATEWAY_PUBLIC_JWKS = replacement.environment.ONTOS_GATEWAY_PUBLIC_JWKS;
  const oldSignatureFailure = await Effect.runPromise(
    Effect.flip(verify(`Bearer ${original.token}`, options)),
  );
  assert.equal(oldSignatureFailure._tag, 'ActionPrincipalInvalidError');
  assert.deepEqual(
    await Effect.runPromise(verify(`Bearer ${replacement.token}`, options)),
    principal,
  );
  assert.equal(createResolver.mock.callCount(), 2);
  environment.ONTOS_GATEWAY_PUBLIC_JWKS = original.environment.ONTOS_GATEWAY_PUBLIC_JWKS;
  assert.deepEqual(await Effect.runPromise(verify(`Bearer ${original.token}`, options)), principal);
  assert.equal(createResolver.mock.callCount(), 3);
});

test('independent verifier factories do not share their resolver caches', async (t) => {
  const assertion = await makeAssertion();
  const createResolver = t.mock.fn(createLocalJWKSet);
  const first = createActionPrincipalVerifier(createResolver);
  const second = createActionPrincipalVerifier(createResolver);
  const options = {
    currentTimeSeconds: Effect.succeed(now + 1),
    environment: assertion.environment,
    redemption: acceptingRedemption,
  };
  const outcomes = await Promise.all(
    [first, second, first, second].map(
      async (verify) => await Effect.runPromise(verify(`Bearer ${assertion.token}`, options)),
    ),
  );
  assert.deepEqual(outcomes, [principal, principal, principal, principal]);
  assert.equal(createResolver.mock.callCount(), 2);
});

test('invalid configuration after a valid request cannot use or replace the cached resolver', async (t) => {
  const assertion = await makeAssertion();
  const createResolver = t.mock.fn(createLocalJWKSet);
  const verify = createActionPrincipalVerifier(createResolver);
  const consume = t.mock.fn(() => Effect.void);
  const options = {
    currentTimeSeconds: Effect.succeed(now + 1),
    environment: assertion.environment,
    redemption: { consume },
  };
  assert.deepEqual(
    await Effect.runPromise(verify(`Bearer ${assertion.token}`, options)),
    principal,
  );
  const invalidKeys = [
    { alg: 'RS256' },
    { kty: 'RSA' },
    { crv: 'X25519' },
    { use: 'enc' },
    { kid: '' },
    { kid: null },
    { x: '' },
    { d: 'private-material' },
    { d: null },
    { key_ops: ['sign'] },
  ];
  const invalidEnvironments = [
    { ...assertion.environment, ONTOS_GATEWAY_ISSUER: 'not-a-url' },
    { ...assertion.environment, ONTOS_GATEWAY_ISSUER: 'file:///issuer' },
    { ONTOS_GATEWAY_PUBLIC_JWKS: assertion.environment.ONTOS_GATEWAY_PUBLIC_JWKS },
    { ONTOS_GATEWAY_ISSUER: issuer },
    { ...assertion.environment, ONTOS_GATEWAY_PUBLIC_JWKS: '{invalid-json' },
    { ...assertion.environment, ONTOS_GATEWAY_PUBLIC_JWKS: '{"keys":[]}' },
    {
      ...assertion.environment,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [assertion.publicJwk, assertion.publicJwk],
      }),
    },
    ...invalidKeys.map((overrides) => ({
      ...assertion.environment,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [{ ...assertion.publicJwk, ...overrides }],
      }),
    })),
  ];
  await Promise.all(
    invalidEnvironments.map(async (environment) => {
      const failure = await Effect.runPromise(
        Effect.flip(verify(`Bearer ${assertion.token}`, { ...options, environment })),
      );
      assert.equal(failure._tag, 'ActionPrincipalConfigurationError');
    }),
  );
  const invalidBearers = [
    [undefined, 'ActionPrincipalMissingError'],
    ['Basic invalid', 'ActionPrincipalInvalidError'],
    ['Bearer ', 'ActionPrincipalInvalidError'],
  ] as const;
  await Promise.all(
    invalidBearers.map(async ([authorization, tag]) => {
      const failure = await Effect.runPromise(
        Effect.flip(verify(authorization, { ...options, environment: {} })),
      );
      assert.equal(failure._tag, tag);
    }),
  );
  assert.equal(createResolver.mock.callCount(), 1);
  assert.equal(consume.mock.callCount(), 1);
  assert.deepEqual(
    await Effect.runPromise(verify(`Bearer ${assertion.token}`, options)),
    principal,
  );
  assert.equal(createResolver.mock.callCount(), 1);
  assert.equal(consume.mock.callCount(), 2);
});

test(
  'an in-flight request retains its resolver while another request rotates the cache',
  { timeout: 5000 },
  async (t) => {
    const original = await makeAssertion();
    const replacement = await makeAssertion();
    const createResolver = t.mock.fn(createLocalJWKSet);
    const verify = createActionPrincipalVerifier(createResolver);
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<number>();
    const pending = Effect.runPromise(
      verify(`Bearer ${original.token}`, {
        currentTimeSeconds: Effect.promise(async () => {
          entered.resolve(true);
          return await release.promise;
        }),
        environment: original.environment,
        redemption: acceptingRedemption,
      }),
    );
    await entered.promise;
    try {
      assert.deepEqual(
        await Effect.runPromise(
          verify(`Bearer ${replacement.token}`, {
            currentTimeSeconds: Effect.succeed(now + 1),
            environment: replacement.environment,
            redemption: acceptingRedemption,
          }),
        ),
        principal,
      );
      assert.equal(createResolver.mock.callCount(), 2);
    } finally {
      release.resolve(now + 1);
    }
    assert.deepEqual(await pending, principal);
    assert.equal(createResolver.mock.callCount(), 2);
  },
);

test('verifies a signed Contacts-audience assertion into trusted principal context', async () => {
  const assertion = await makeAssertion();
  assert.deepEqual(
    await Effect.runPromise(
      verifyActionPrincipal(`Bearer ${assertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: assertion.environment,
        redemption,
      }),
    ),
    principal,
  );
});

test('accepts public JWK metadata while rejecting private key material', async () => {
  const publicAssertion = await makeAssertion();
  assert.deepEqual(
    await Effect.runPromise(
      verifyActionPrincipal(`Bearer ${publicAssertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: publicAssertion.environment,
        redemption,
      }),
    ),
    principal,
  );

  const privateAssertion = await makeAssertion(ACTION_GATEWAY_AUDIENCE, true);
  const failure = await Effect.runPromise(
    Effect.flip(
      verifyActionPrincipal(`Bearer ${privateAssertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: privateAssertion.environment,
        redemption,
      }),
    ),
  );
  assert.equal(failure._tag, 'ActionPrincipalConfigurationError');
});

test('sanitizes missing, wrong-audience, and malformed assertion failures', async () => {
  const assertion = await makeAssertion('billing');
  const failures = await Promise.all([
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal(undefined, {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
          redemption,
        }),
      ),
    ),
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal(`Bearer ${assertion.token}`, {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
          redemption,
        }),
      ),
    ),
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal('Bearer not-a-jwt', {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
          redemption,
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

test('rejects sequential and concurrent replay while allowing exactly one redemption', async () => {
  const assertion = await makeAssertion();
  const options = {
    currentTimeSeconds: Effect.succeed(now + 1),
    environment: assertion.environment,
    redemption,
  };
  const outcomes = await Promise.allSettled([
    Effect.runPromise(verifyActionPrincipal(`Bearer ${assertion.token}`, options)),
    Effect.runPromise(verifyActionPrincipal(`Bearer ${assertion.token}`, options)),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).toSorted(), ['fulfilled', 'rejected']);
  const replay = await Effect.runPromise(
    Effect.flip(verifyActionPrincipal(`Bearer ${assertion.token}`, options)),
  );
  assert.equal(replay._tag, 'ActionPrincipalInvalidError');
});

test('redemption storage failure is a typed fail-closed unavailable response', async () => {
  const assertion = await makeAssertion();
  const failure = await Effect.runPromise(
    Effect.flip(
      verifyActionPrincipal(`Bearer ${assertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: assertion.environment,
        redemption: {
          consume: () =>
            Effect.fail(
              new GatewayAssertionRedemptionUnavailableError({ reason: 'database unavailable' }),
            ),
        },
      }),
    ),
  );
  assert.equal(failure._tag, 'ActionPrincipalUnavailableError');
  assert.doesNotMatch(failure.reason, /database/u);
});

test('missing, expired, and incomplete replay claims fail before redemption storage', async () => {
  const assertions = await Promise.all([
    makeAssertion(ACTION_GATEWAY_AUDIENCE, false, { includeJti: false }),
    makeAssertion(ACTION_GATEWAY_AUDIENCE, false, { expiresAt: now - 31, issuedAt: now - 331 }),
    makeAssertion(ACTION_GATEWAY_AUDIENCE, false, { expiresAt: false }),
  ]);
  let redemptionAttempts = 0;
  const countingRedemption: GatewayAssertionRedemption = {
    consume: () =>
      Effect.sync(() => {
        redemptionAttempts += 1;
      }),
  };
  const failures = await Promise.all(
    assertions.map(
      async (assertion) =>
        await Effect.runPromise(
          Effect.flip(
            verifyActionPrincipal(`Bearer ${assertion.token}`, {
              currentTimeSeconds: Effect.succeed(now + 1),
              environment: assertion.environment,
              redemption: countingRedemption,
            }),
          ),
        ),
    ),
  );
  assert.deepEqual(
    failures.map(({ _tag }) => _tag),
    ['ActionPrincipalInvalidError', 'ActionPrincipalExpiredError', 'ActionPrincipalInvalidError'],
  );
  assert.equal(redemptionAttempts, 0);
});

test('acquires a fresh Contacts assertion for every gateway invocation', async () => {
  let issued = 0;
  const gateway = makeActionGateway(() =>
    Effect.sync(() => {
      issued += 1;
      return { expiresAt: now + 300, token: `token-${issued}` };
    }),
  );
  const acquire = () => Effect.runPromise(gateway.invoke(Effect.succeed));
  assert.equal(Redacted.value(await acquire()), 'Bearer token-1');
  assert.equal(Redacted.value(await acquire()), 'Bearer token-2');
  assert.equal(issued, 2);
});
