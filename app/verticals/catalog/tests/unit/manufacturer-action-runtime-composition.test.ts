import { randomUUID } from 'node:crypto';

import { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makeCatalogApiRuntime } from '../../api/index.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const principal = {
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:catalog-manufacturer-runtime-test',
  authMethod: 'session',
  principalId,
  tenantId,
} as const;
const subject = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const basis = {
  evidenceRefs: ['manufacturer-declaration'],
  reason: 'Source declaration verified',
  relationId: '33333333-3333-4333-8333-333333333333',
  subject,
};

it.live('makes the governed Core read available to all manufacturer Action HTTP routes', () =>
  Effect.gen(function* verifyManufacturerActionRuntimeComposition() {
    const issuer = 'https://shell.catalog-manufacturer-runtime.test';
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'catalog-manufacturer-runtime-test',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({ principal, ver: 1 })
        .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('catalog')
        .setSubject(principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(randomUUID())
        .sign(privateKey),
    );
    let actionCalls = 0;
    const readRuntime: ReadRuntimeService = { runRead: () => Effect.die('not needed in composition proof') };
    const actionRuntime: ActionRuntimeService = {
      resolveActionCommit: () => Effect.die('not needed in composition proof'),
      runAction: () =>
        Effect.context().pipe(
          Effect.flatMap((context) => {
            expect(Context.getOrUndefined(context, ReadRuntime)).toBe(readRuntime);
            actionCalls += 1;
            return Effect.die('stopped after runtime composition proof');
          }),
        ),
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
    const target = {
      kind: 'LEGAL_ENTITY',
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: '77777777-7777-4777-8777-777777777777',
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
    };
    const requests = [
      { payload: { ...basis, effectivePeriod: {}, target }, slug: 'set' },
      { payload: { ...basis, effectivePeriod: {}, expectedRevision: 1, target }, slug: 'change' },
      { payload: { ...basis, expectedRevision: 1 }, slug: 'remove' },
    ];
    for (const { payload, slug } of requests) {
      const response = yield* Effect.promise(() =>
        runtime.handler(
          new Request(`http://localhost/catalog/actions/${slug}-product-manufacturer`, {
            body: JSON.stringify(payload),
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'idempotency-key': randomUUID(),
              'x-correlation-id': `catalog-manufacturer-${slug}`,
            },
            method: 'POST',
          }),
        ),
      );
      expect(response.status).toBe(500);
    }
    expect(actionCalls).toBe(3);
  }),
);
