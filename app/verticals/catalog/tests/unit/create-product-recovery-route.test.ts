import { randomUUID } from 'node:crypto';

import {
  ActionAlreadyCommitted,
  ActionRuntime,
  GatewayAssertionRedemptionService,
  ReadHandlerUnavailable,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makeCatalogApiRuntime } from '../../api/index.ts';

const principal = {
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:catalog-recovery-route-test',
  authMethod: 'session',
  principalId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;
const invocationId = '33333333-3333-4333-8333-333333333333';

it.live('routes an authenticated recovery request with both governed runtimes available', () =>
  Effect.gen(function* invokeRecoveryRoute() {
    const issuer = 'https://shell.catalog-recovery-route.test';
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'catalog-recovery-route-test',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({ principal, ver: 1 })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'catalog-recovery-route-test', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('catalog')
        .setSubject(principal.principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(randomUUID())
        .sign(privateKey),
    );
    let readCalls = 0;
    const readRuntime: ReadRuntimeService = {
      runRead: () =>
        Effect.context().pipe(
          Effect.flatMap((context) => {
            expect(Context.getOrUndefined(context, ActionRuntime)).toBeDefined();
            readCalls += 1;
            return Effect.fail(
              new ReadHandlerUnavailable({
                code: 'read_handler_unavailable',
                reason: 'Route assembly proof stopped before persistence',
              }),
            );
          }),
        ),
    };
    const actionRuntime: ActionRuntimeService = {
      resolveActionCommit: () =>
        Effect.fail(
          new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
        ),
      runAction: () => Effect.die('unused'),
    };
    const assembled = makeCatalogApiRuntime(
      Layer.succeed(ReadRuntime, readRuntime),
      Layer.mergeAll(
        Layer.succeed(ActionRuntime, actionRuntime),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_ISSUER: issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              keys: [publicJwk],
            }),
          }),
        ),
      ),
      Layer.succeed(GatewayAssertionRedemptionService, { consume: () => Effect.void }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => assembled.createHandler()),
      (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
    );
    const response = yield* Effect.promise(() =>
      runtime.handler(
        new Request('http://localhost/reads/create-product-recovery', {
          body: JSON.stringify({ invocationId }),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-correlation-id': 'catalog-recovery-route-proof',
          },
          method: 'POST',
        }),
      ),
    );
    expect(response.status).toBe(503);
    expect(readCalls).toBe(1);
  }),
);
