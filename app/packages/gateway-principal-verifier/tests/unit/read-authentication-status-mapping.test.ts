import {
  ActiveApplicationCompositionService,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
  readVerifiedGatewayScopeAssertion,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { makeMicroverticalHttpPrincipalAuthentication } from '@app/core-runtime/http/principal-authentication';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { Effect, Redacted, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import {
  ActionPrincipalInvalidErrorSchema,
  ActionPrincipalScopeErrorSchema,
  ActionPrincipalUnavailableErrorSchema,
  bindGatewayPrincipalVerifier,
} from '../../src/server.ts';
import type { ActionPrincipalError } from '../../src/server.ts';

/**
 * Every receiving route that takes a gateway principal here is a governed read, and that transport
 * answers 401 for every authentication problem the verifier can raise: a spent assertion, an assertion
 * for another release, and an assertion for another audience are indistinguishable on the wire. Only a
 * redemption store that cannot answer is a 503. These tests pin the verifier's own contribution to that
 * mapping, so a 401 observed from an integration route is never read as proof of a duplicate redemption.
 */

const audience = 'commerce-customer-context';
const issuer = 'https://read-authentication-mapping.ontos.test';
const jti = '60000000-0000-4000-8000-0000000000b1';
const buildMarker = 'read-authentication-mapping-release';
const currentTimeSeconds = 1_700_000_001;
const issuedAt = 1_700_000_000;
const composition = makeApplicationCompositionSnapshotFixture([audience, 'party-registry'], buildMarker);

/** The namespace-carrying v2 context a portal session presents, as the acceptance issuer signs it. */
const principal = {
  authBindingId: '30000000-0000-4000-8000-0000000000b1',
  authContextRef: 'portal-session:40000000-0000-4000-8000-0000000000b1',
  authenticationNamespaceId: 'commerce.portal.identity.v1',
  authMethod: 'session' as const,
  legalEntityId: '70000000-0000-4000-8000-0000000000b1',
  principalId: '40000000-0000-4000-8000-0000000000b1',
  tenantId: '50000000-0000-4000-8000-0000000000b1',
};

interface ReleaseClaimOverrides {
  readonly compositionRevision?: string;
  readonly targetBuildMarker?: string;
}

const makeFixture = (assertionAudience: string = audience, overrides: ReleaseClaimOverrides = {}) =>
  Effect.gen(function* makeReadAuthenticationFixture() {
    const snapshot = yield* composition;
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('EdDSA', { crv: 'Ed25519' }));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'read-authentication-mapping',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: overrides.compositionRevision ?? snapshot.composition.revision,
        principal,
        targetBuildMarker: overrides.targetBuildMarker ?? buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'read-authentication-mapping', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(assertionAudience)
        .setSubject(principal.principalId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
        .setJti(jti)
        .sign(privateKey),
    );
    return {
      composition,
      environment: {
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          keys: [publicJwk],
        }),
      },
      token,
    };
  });

type ReadAuthenticationFixture = Effect.Success<ReturnType<typeof makeFixture>>;

const verifier = bindGatewayPrincipalVerifier(audience, { appId: audience, buildMarker });
type Redemption = Parameters<typeof verifier.verifyAndRedeem>[1]['redemption'];

const provideComposition = (fixture: ReadAuthenticationFixture) =>
  Effect.provideService(ActiveApplicationCompositionService, { load: fixture.composition });

const verifyAndRedeem = (fixture: ReadAuthenticationFixture, redemption: Redemption) =>
  verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
    currentTimeSeconds: Effect.succeed(currentTimeSeconds),
    environment: fixture.environment,
    redemption,
  });

/** A durable single-use store: the first presentation of (issuer, audience, jti) wins, every later one replays. */
const makeSingleUseRedemption = () => {
  const presented = new Set<string>();
  const consumptions: string[] = [];
  const redemption: Redemption & { readonly consumptions: readonly string[] } = {
    consume: (input) => {
      const key = `${input.issuer}|${input.audience}|${input.jti}`;
      consumptions.push(key);
      if (presented.has(key)) {
        return Effect.fail(new GatewayAssertionReplayError({ reason: 'already redeemed' }));
      }
      presented.add(key);
      return Effect.void;
    },
    consumptions,
  };
  return redemption;
};

it.effect('a governed read consumes exactly one redemption per presentation and refuses the next', () =>
  Effect.gen(function* consumeOncePerPresentation() {
    const fixture = yield* makeFixture();
    const redemption = makeSingleUseRedemption();

    const verified = yield* verifyAndRedeem(fixture, redemption).pipe(provideComposition(fixture));
    expect(redemption.consumptions).toEqual([`${issuer}|${audience}|${jti}`]);
    expect(readVerifiedGatewayScopeAssertion(verified)?.audience).toBe(audience);
    expect(verified).toEqual(principal);

    const replay = yield* verifyAndRedeem(fixture, redemption).pipe(provideComposition(fixture), Effect.flip);
    expect(redemption.consumptions).toEqual([`${issuer}|${audience}|${jti}`, `${issuer}|${audience}|${jti}`]);
    expect(Schema.is(ActionPrincipalInvalidErrorSchema)(replay)).toBe(true);
  }),
);

it.effect('reading an assertion without redeeming it never spends the credential', () =>
  Effect.gen(function* readWithoutRedeeming() {
    const fixture = yield* makeFixture();
    const redemption = makeSingleUseRedemption();
    yield* verifier
      .verify(Redacted.make(`Bearer ${fixture.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: fixture.environment,
      })
      .pipe(provideComposition(fixture));
    expect(redemption.consumptions).toEqual([]);
  }),
);

/** The exact authentication problems the governed-read transport declares, keyed by its HTTP status. */
const authenticationProblems = {
  authentication: () => 401 as const,
  unavailable: () => 503 as const,
};
const asGovernedReadTransport = (
  verification: Effect.Effect<TrustedPrincipalContext, ActionPrincipalError, ActiveApplicationCompositionService>,
) =>
  makeMicroverticalHttpPrincipalAuthentication(() => verification)(
    Redacted.make('Bearer read-authentication-status-mapping'),
    authenticationProblems,
  ).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request('https://commerce-customer-context.test/reads/example')),
    ),
    Effect.flip,
  );

const observedStatus = (fixture: ReadAuthenticationFixture, redemption: Redemption) =>
  asGovernedReadTransport(verifyAndRedeem(fixture, redemption)).pipe(provideComposition(fixture));

it.effect(
  'the governed-read transport reports 401 for a replay and for a release mismatch, and 503 only when unavailable',
  () =>
    Effect.gen(function* classifyAuthenticationProblems() {
      const current = yield* makeFixture();
      const otherRelease = yield* makeFixture(audience, { targetBuildMarker: 'some-other-release' });
      const otherRevision = yield* makeFixture(audience, { compositionRevision: 'f'.repeat(64) });
      const otherAudience = yield* makeFixture('another-audience');
      const neverReached: Redemption = { consume: () => Effect.void };

      const observed = [
        { problem: 'target build marker mismatch', status: yield* observedStatus(otherRelease, neverReached) },
        { problem: 'composition revision mismatch', status: yield* observedStatus(otherRevision, neverReached) },
        { problem: 'audience mismatch', status: yield* observedStatus(otherAudience, neverReached) },
        {
          problem: 'durable replay',
          status: yield* observedStatus(current, {
            consume: () => Effect.fail(new GatewayAssertionReplayError({ reason: 'already redeemed' })),
          }),
        },
        {
          problem: 'redemption store unavailable',
          status: yield* observedStatus(current, {
            consume: () => Effect.fail(new GatewayAssertionRedemptionUnavailableError({ reason: 'store down' })),
          }),
        },
      ];
      expect(observed).toEqual([
        { problem: 'target build marker mismatch', status: 401 },
        { problem: 'composition revision mismatch', status: 401 },
        { problem: 'audience mismatch', status: 401 },
        { problem: 'durable replay', status: 401 },
        { problem: 'redemption store unavailable', status: 503 },
      ]);

      const releaseFailure = yield* verifier
        .verify(Redacted.make(`Bearer ${otherRelease.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: otherRelease.environment,
        })
        .pipe(provideComposition(otherRelease), Effect.flip);
      expect(Schema.is(ActionPrincipalScopeErrorSchema)(releaseFailure)).toBe(true);

      const unavailableFailure = yield* verifyAndRedeem(current, {
        consume: () => Effect.fail(new GatewayAssertionRedemptionUnavailableError({ reason: 'store down' })),
      }).pipe(provideComposition(current), Effect.flip);
      expect(Schema.is(ActionPrincipalUnavailableErrorSchema)(unavailableFailure)).toBe(true);
    }),
);
