import { randomUUID } from 'node:crypto';

import {
  ActionPermissionDenied,
  ActionRuntime,
  GatewayAssertionRedemptionService,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makeCatalogApiRuntime } from '../../api/index.ts';
import { decideProductTypeUnnecessaryAction } from '../../src/actions/decide-product-type-unnecessary.action.ts';
import { DecideProductTypeUnnecessaryPayloadSchema } from '../../shared/actions/decide-product-type-unnecessary.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '33333333-3333-4333-8333-333333333333';
const productId = '22222222-2222-4222-8222-222222222222';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const payload = {
  decisionState: 'CONFIRMED',
  evidenceRefs: ['catalog-review:123'],
  expectedAxisRevision: 0,
  expectedDecisionRevision: 0,
  expectedProductRevision: 1,
  expectedValueRevisionTokens: [],
  expectedVariantRevisionTokens: [],
  productRef,
  reason: 'No attributes or axes needed',
  structuredAttributesRequired: false,
  variantAxesRequired: false,
} as const;
const endpoint = 'http://localhost/catalog/actions/decide-product-type-unnecessary';

describe('Decide Product Type unnecessary HTTP Action', () => {
  it.live('routes authenticated tenant-scoped execution and maps permission denial', () =>
    Effect.gen(function* actionHttp() {
      expect(Schema.is(DecideProductTypeUnnecessaryPayloadSchema)(payload)).toBe(true);
      const issuer = 'https://shell.catalog-untyped-action.test';
      const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
      const publicJwk = {
        ...(yield* Effect.promise(() => exportJWK(publicKey))),
        alg: 'EdDSA',
        kid: 'catalog-untyped-action-test',
        use: 'sig',
      };
      const token = yield* Effect.promise(() =>
        new SignJWT({
          principal: {
            authBindingId: '66666666-6666-4666-8666-666666666666',
            authContextRef: 'better-auth-session:catalog-untyped-action-test',
            authMethod: 'session',
            principalId,
            tenantId,
          },
          ver: 1,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience('catalog')
          .setSubject(principalId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .setJti(randomUUID())
          .sign(privateKey),
      );
      let calls = 0;
      let denied = false;
      const actionRuntime: ActionRuntimeService = {
        resolveActionCommit: () => Effect.die('No commit resolution expected'),
        runAction: (input) => {
          calls += 1;
          expect(input.registration).toBe(decideProductTypeUnnecessaryAction);
          expect(input.principal).toMatchObject({ principalId, tenantId });
          expect(input.payload).toMatchObject({ decisionState: 'CONFIRMED', productRef });
          if (denied) {
            return Effect.fail(
              new ActionPermissionDenied({
                code: 'action_permission_denied',
                reason: 'Not an executor',
              }),
            );
          }
          return Effect.succeed({ decisionRevision: 1, decisionState: 'CONFIRMED', productRef });
        },
      };
      const readRuntime: ReadRuntimeService = { runRead: () => Effect.die('No read expected') };
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
      const request = (authorization?: string) => {
        const headers = new Headers({
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
          'x-correlation-id': 'catalog-untyped-http-test',
        });
        if (authorization !== undefined) {
          headers.set('authorization', authorization);
        }
        return new Request(endpoint, {
          body: JSON.stringify(Schema.encodeUnknownSync(DecideProductTypeUnnecessaryPayloadSchema)(payload)),
          headers,
          method: 'POST',
        });
      };
      const missingAuth = yield* Effect.promise(() => runtime.handler(request()));
      expect(missingAuth.status).toBe(401);
      expect(calls).toBe(0);
      const allowed = yield* Effect.promise(() => runtime.handler(request(`Bearer ${token}`)));
      expect(allowed.status, yield* Effect.promise(() => allowed.clone().text())).toBe(200);
      expect(yield* Effect.promise(() => allowed.json())).toMatchObject({
        decisionRevision: 1,
        decisionState: 'CONFIRMED',
        productRef,
      });
      denied = true;
      const forbidden = yield* Effect.promise(() => runtime.handler(request(`Bearer ${token}`)));
      expect(forbidden.status).toBe(403);
      expect(calls).toBe(2);
    }),
  );
});
