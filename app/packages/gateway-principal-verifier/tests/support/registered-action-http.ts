import { randomUUID } from 'node:crypto';

import { GatewayAssertionRedemptionService, GatewayAssertionReplayError } from '@app/core-runtime';
import type { VerticalRuntimeRegistration } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { Clock, ConfigProvider, Effect, Layer, Schema } from 'effect';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { GatewayPrincipalVerifierLive } from '../../src/server.ts';

/** The staff session every registered-Action HTTP fixture acts for. */
export const fixturePrincipal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;

const issuer = 'https://shell.registered-action-http.test';
const keyId = 'registered-action-http';

/** The owner whose registered Actions a test serves. */
export interface RegisteredActionOwner {
  /** The owner's API build identity (`ultramodernApiMarker`), the target a Shell assertion names. */
  readonly apiMarker: { readonly appId: string; readonly buildMarker: string };
  /** The audience the owner's verifier is bound to (`ACTION_GATEWAY_AUDIENCE`). */
  readonly audience: string;
  readonly ownerRegistration: VerticalRuntimeRegistration;
}

/**
 * The Shell gateway in front of an owner's registered Action routes, with the real Action runtime harness behind
 * them. `authorization` signs a fresh single-use assertion for the owner's audience, API build and composition, as
 * the Shell issues one per owner call; `requestLayer` is what the owner's routes read per request: the harness, the
 * owner's real gateway principal verifier trusting only this gateway's published key, and a redemption that admits
 * each assertion once.
 */
export const registeredActionGateway = (
  owner: RegisteredActionOwner,
  options: Omit<ActionTestHarnessOptions, 'applicationComposition' | 'expectedDeployment' | 'ownerRegistration'>,
) =>
  Effect.gen(function* openGateway() {
    const composition = yield* makeOwnerApplicationCompositionFixture({
      appId: owner.apiMarker.appId,
      buildMarker: owner.apiMarker.buildMarker,
      ownerRegistration: owner.ownerRegistration,
    });
    const compositionRevision = composition.snapshot.composition.revision;
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      applicationComposition: composition.applicationComposition,
      expectedDeployment: composition.expectedDeployment,
      ownerRegistration: owner.ownerRegistration,
      ...options,
    });
    const { privateKey, publicKey } = yield* Effect.promise(async () => await generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(async () => await exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: keyId,
      use: 'sig',
    };
    const publicJwks = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ keys: [publicJwk] });
    const redeemed = new Set<string>();
    const clock = yield* Clock.Clock;

    const authorization = Effect.gen(function* signAssertion() {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const token = yield* Effect.promise(
        async () =>
          await new SignJWT({
            compositionRevision,
            principal: { ...fixturePrincipal, authContextRef: `better-auth-session:${owner.audience}-http` },
            targetBuildMarker: owner.apiMarker.buildMarker,
            ver: GATEWAY_ASSERTION_VERSION,
          })
            .setProtectedHeader({ alg: 'EdDSA', kid: keyId, typ: 'JWT' })
            .setIssuer(issuer)
            .setAudience(owner.audience)
            .setSubject(fixturePrincipal.principalId)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .setJti(randomUUID())
            .sign(privateKey),
      );
      return `Bearer ${token}`;
    }).pipe(Effect.provideService(Clock.Clock, clock));

    const requestLayer = Layer.mergeAll(
      harness.layer,
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(ActiveApplicationCompositionService, composition.applicationComposition),
      Layer.succeed(GatewayAssertionRedemptionService, {
        consume: ({ jti }) =>
          redeemed.has(jti)
            ? Effect.fail(new GatewayAssertionReplayError({ reason: 'The assertion was already used' }))
            : Effect.sync(() => {
                redeemed.add(jti);
              }),
      }),
      GatewayPrincipalVerifierLive.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: publicJwks }),
          ),
        ),
      ),
    );

    return { authorization, compositionRevision, harness, requestLayer } as const;
  });

/** One owner write as the Shell relays it: the route, the encoded body and its idempotency key. */
export interface RelayedActionWrite {
  readonly body: string;
  readonly intent?: 'propose' | undefined;
  readonly key: string;
  readonly path: string;
}

/** POSTs a write to an owner route through `handle` with a fresh gateway assertion. */
export const relayActionWrite = (
  gateway: Effect.Success<ReturnType<typeof registeredActionGateway>>,
  handle: (request: Request) => Promise<Response>,
  write: RelayedActionWrite,
) =>
  Effect.gen(function* relayWrite() {
    const headers = new Headers({
      authorization: yield* gateway.authorization,
      'content-type': 'application/json',
      'idempotency-key': write.key,
      'x-composition-revision': gateway.compositionRevision,
      'x-correlation-id': write.key,
    });
    if (write.intent !== undefined) {
      headers.set('x-action-intent', write.intent);
    }
    const request = new Request(`https://owner.test${write.path}`, { body: write.body, headers, method: 'POST' });
    return yield* Effect.promise(async () => await handle(request));
  });
