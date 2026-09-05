import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
  ACTION_GATEWAY_AUDIENCE,
  createActionPrincipalVerifier,
} from '../../api/auth/action-principal.ts';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const issuer = 'https://shell.ontos.test';
const now = 1_700_000_000;
const principal = {
  authBindingId: 'a1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:test-session',
  authMethod: 'session' as const,
  principalId: 'a2000000-0000-4000-8000-000000000001',
  tenantId: 'a3000000-0000-4000-8000-000000000001',
};

interface AssertionOptions {
  readonly audience?: string;
  readonly expiresAt?: number | false;
  readonly includePrivateKeyMaterial?: boolean;
  readonly issuedAt?: number;
  readonly jti?: string;
  readonly kid?: string;
}

const makeAssertion = ({
  audience = ACTION_GATEWAY_AUDIENCE,
  expiresAt = now + 300,
  includePrivateKeyMaterial = false,
  issuedAt = now,
  jti = 'b1000000-0000-4000-8000-000000000001',
  kid = 'party-test',
}: AssertionOptions = {}) =>
  Effect.gen(function* makeAssertionEffect() {
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      ext: true,
      kid,
      use: 'sig',
      x5t: 'public-sha1-thumbprint',
      'x5t#S256': 'public-sha256-thumbprint',
      x5u: `https://shell.ontos.test/certificates/${kid}.pem`,
    };
    if (includePrivateKeyMaterial) {
      Object.assign(publicJwk, { d: 'private-key-material-must-not-cross-the-boundary' });
    }
    let signer = new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(principal.principalId)
      .setIssuedAt(issuedAt);
    if (expiresAt !== false) {
      signer = signer.setExpirationTime(expiresAt);
    }
    const token = yield* Effect.promise(() => signer.setJti(jti).sign(privateKey));
    return {
      environment: {
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: encodeJson({ keys: [publicJwk] }),
      },
      publicJwk,
      token,
    };
  });

const makeCountingResolver = () => {
  let calls = 0;
  const inputs: Parameters<typeof createLocalJWKSet>[0][] = [];
  const createResolver: typeof createLocalJWKSet = (jwks) => {
    calls += 1;
    inputs.push(jwks);
    return createLocalJWKSet(jwks);
  };
  return {
    createResolver,
    get calls() {
      return calls;
    },
    inputs,
  };
};

test('reuses one validated resolver while rechecking request configuration and clocks', () =>
  Effect.runPromise(
    Effect.gen(function* reuseResolverEffect() {
      const assertion = yield* makeAssertion();
      const resolver = makeCountingResolver();
      const verify = createActionPrincipalVerifier(resolver.createResolver);
      const environment = { ...assertion.environment };
      let currentTime = now + 1;
      const options = {
        currentTimeSeconds: Effect.sync(() => currentTime),
        environment,
      };

      assert.deepStrictEqual(yield* verify(`Bearer ${assertion.token}`, options), principal);
      assert.deepStrictEqual(yield* verify(`Bearer ${assertion.token}`, options), principal);
      assert.strictEqual(resolver.calls, 1);
      assert.deepStrictEqual(resolver.inputs[0], {
        keys: [
          {
            alg: 'EdDSA',
            crv: 'Ed25519',
            kid: 'party-test',
            kty: 'OKP',
            use: 'sig',
            x: assertion.publicJwk.x,
          },
        ],
      });

      environment.ONTOS_GATEWAY_ISSUER = 'https://other.ontos.test';
      const scopeFailure = yield* Effect.flip(verify(`Bearer ${assertion.token}`, options));
      assert.strictEqual(scopeFailure._tag, 'ActionPrincipalScopeError');
      environment.ONTOS_GATEWAY_ISSUER = issuer;
      currentTime = now + 331;
      const expiredFailure = yield* Effect.flip(verify(`Bearer ${assertion.token}`, options));
      assert.strictEqual(expiredFailure._tag, 'ActionPrincipalExpiredError');
      currentTime = Number.NaN;
      const clockFailure = yield* Effect.flip(verify(`Bearer ${assertion.token}`, options));
      assert.strictEqual(clockFailure._tag, 'ActionPrincipalConfigurationError');
      assert.strictEqual(resolver.calls, 1);

      const privateAssertion = yield* makeAssertion({ includePrivateKeyMaterial: true });
      const privateFailure = yield* Effect.flip(
        verify(`Bearer ${privateAssertion.token}`, {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: privateAssertion.environment,
        }),
      );
      assert.strictEqual(privateFailure._tag, 'ActionPrincipalConfigurationError');
      assert.strictEqual(resolver.calls, 1);
    }),
  ));

test('replaces the resolver when a same-kid JWKS rotates', () =>
  Effect.runPromise(
    Effect.gen(function* rotateResolverEffect() {
      const original = yield* makeAssertion({ jti: 'b1000000-0000-4000-8000-000000000002' });
      const replacement = yield* makeAssertion({ jti: 'b1000000-0000-4000-8000-000000000003' });
      assert.strictEqual(original.publicJwk.kid, replacement.publicJwk.kid);
      assert.notStrictEqual(original.publicJwk.x, replacement.publicJwk.x);

      const resolver = makeCountingResolver();
      const verify = createActionPrincipalVerifier(resolver.createResolver);
      const environment = { ...original.environment };
      const options = {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment,
      };

      assert.deepStrictEqual(yield* verify(`Bearer ${original.token}`, options), principal);
      environment.ONTOS_GATEWAY_PUBLIC_JWKS = replacement.environment.ONTOS_GATEWAY_PUBLIC_JWKS;
      const oldSignatureFailure = yield* Effect.flip(verify(`Bearer ${original.token}`, options));
      assert.strictEqual(oldSignatureFailure._tag, 'ActionPrincipalInvalidError');
      assert.deepStrictEqual(yield* verify(`Bearer ${replacement.token}`, options), principal);
      assert.strictEqual(resolver.calls, 2);

      environment.ONTOS_GATEWAY_PUBLIC_JWKS = original.environment.ONTOS_GATEWAY_PUBLIC_JWKS;
      assert.deepStrictEqual(yield* verify(`Bearer ${original.token}`, options), principal);
      assert.strictEqual(resolver.calls, 3);
    }),
  ));

test('keeps an in-flight request on its local resolver during rotation', () =>
  Effect.runPromise(
    Effect.gen(function* concurrentRotationEffect() {
      const original = yield* makeAssertion({ jti: 'b1000000-0000-4000-8000-000000000004' });
      const replacement = yield* makeAssertion({ jti: 'b1000000-0000-4000-8000-000000000005' });
      const resolver = makeCountingResolver();
      const verify = createActionPrincipalVerifier(resolver.createResolver);

      const outcomes = yield* Effect.all(
        [
          verify(`Bearer ${original.token}`, {
            currentTimeSeconds: Effect.sleep('1 millis').pipe(Effect.as(now + 1)),
            environment: original.environment,
          }),
          verify(`Bearer ${replacement.token}`, {
            currentTimeSeconds: Effect.succeed(now + 1),
            environment: replacement.environment,
          }),
        ],
        { concurrency: 'unbounded' },
      );
      assert.deepStrictEqual(outcomes, [principal, principal]);
      assert.strictEqual(resolver.calls, 2);
    }),
  ));

test('keeps resolver caches isolated between verifier factories under concurrency', () =>
  Effect.runPromise(
    Effect.gen(function* isolateResolverEffect() {
      const assertion = yield* makeAssertion();
      const resolver = makeCountingResolver();
      const first = createActionPrincipalVerifier(resolver.createResolver);
      const second = createActionPrincipalVerifier(resolver.createResolver);
      const options = {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: assertion.environment,
      };

      const outcomes = yield* Effect.all(
        [
          first(`Bearer ${assertion.token}`, options),
          second(`Bearer ${assertion.token}`, options),
          first(`Bearer ${assertion.token}`, options),
          second(`Bearer ${assertion.token}`, options),
        ],
        { concurrency: 'unbounded' },
      );
      assert.deepStrictEqual(outcomes, [principal, principal, principal, principal]);
      assert.strictEqual(resolver.calls, 2);
    }),
  ));
