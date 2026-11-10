import { generateKeyPairSync, sign } from 'node:crypto';
import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  DatabaseConfig,
} from '@app/core-runtime';
import { makeGatewayPrincipalVerifierLayer } from '@app/gateway-principal-verifier/server';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, DateTime, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { describe, expect, it } from 'effect-rstest';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { createPromotionDraftActionApiLive } from '../../api/create-promotion-draft-action-server.ts';
import { publishPromotionActionApiLive } from '../../api/publish-promotion-action-server.ts';
import { provisionVoucherActionApiLive } from '../../api/provision-voucher-action-server.ts';
import { disableVoucherActionApiLive } from '../../api/disable-voucher-action-server.ts';
import { readPromotionsReadApiLive } from '../../api/read-promotions-read-server.ts';
import { readVouchersReadApiLive } from '../../api/read-vouchers-read-server.ts';
import { ProvisionVoucherActionConflictProblemSchema } from '../../shared/apis/provision-voucher-action.ts';
import type { ReadPromotionsRequestSchema } from '../../shared/apis/read-promotions.ts';
import { promotionApi } from '../../shared/api.ts';
import { CreatePromotionDraftPayloadSchema } from '../../shared/resources/promotion.ts';
import type { ProvisionVoucherPayloadSchema } from '../../shared/resources/voucher.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { publishPromotionAction } from '../../src/actions/publish-promotion.action.ts';
import { provisionVoucherAction } from '../../src/actions/provision-voucher.action.ts';
import { disableVoucherAction } from '../../src/actions/disable-voucher.action.ts';
import { executePublishPromotionWithAuthorization } from '../../src/api/publish-promotion-action-client.ts';
import { executeProvisionVoucherWithAuthorization } from '../../src/api/provision-voucher-action-client.ts';
import { executeDisableVoucherWithAuthorization } from '../../src/api/disable-voucher-action-client.ts';
import { createPromotionDraftAction } from '../../src/actions/create-promotion-draft.action.ts';
import { executeCreatePromotionDraftWithAuthorization } from '../../src/api/create-promotion-draft-action-client.ts';
import { executeReadPromotionsWithAuthorization } from '../../src/api/read-promotions-client.ts';
import { PromotionDatabaseLive, PromotionPgClientLive } from '../../src/database/client.ts';
import { createNativeManagementFixture } from '../support/management.fixture.ts';
import { nativeServices, nextId } from '../support/persistence.fixture.ts';

type HttpTestPayload =
  | typeof CreatePromotionDraftPayloadSchema.Encoded
  | typeof ProvisionVoucherPayloadSchema.Encoded
  | typeof ReadPromotionsRequestSchema.Type;
const baseUrl = 'https://promotion.native-http.test';
const issuer = 'https://gateway.native-http.test';
const kid = 'promotion-native-http';

describe('generated Promotion receiving HTTP boundary', () => {
  it.live('verifies real assertions, gates native writes and reads, and rejects invalid or foreign authority', () =>
    Effect.gen(function* nativeHttpAcceptance() {
      const test = yield* createNativeManagementFixture();
      const { fixture } = test;
      if (fixture.actionRuntime === undefined) {
        return yield* Effect.die('The native owner fixture must expose its actual Action runtime');
      }
      yield* Effect.forEach(
        [createPromotionDraftAction, publishPromotionAction, provisionVoucherAction, disableVoucherAction],
        (action) => fixture.grantActionExecution(action),
        { concurrency: 1 },
      );
      const keys = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
      const verifier = makeGatewayPrincipalVerifierLayer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
            keys: [{ ...keys.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
          }),
        }),
      );
      const authorization = Effect.fn('PromotionHttpTest.authorization')(function* authorization(
        changes: {
          readonly audience?: string;
          readonly buildMarker?: string;
          readonly compositionRevision?: string;
          readonly tenantId?: string;
        } = {},
      ) {
        const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
        const actor = { ...fixture.principal, tenantId: changes.tenantId ?? fixture.principal.tenantId };
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            aud: changes.audience ?? 'promotion',
            compositionRevision: changes.compositionRevision ?? test.snapshot.composition.revision,
            exp: now + 300,
            iat: now,
            iss: issuer,
            jti: yield* nextId,
            principal: actor,
            sub: actor.principalId,
            targetBuildMarker: changes.buildMarker ?? ultramodernApiMarker.buildMarker,
            ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
          }),
        ).toString('base64url');
        const content = `${header}.${payload}`;
        return `Bearer ${content}.${sign(null, Buffer.from(content), keys.privateKey).toString('base64url')}`;
      });
      const database = PromotionDatabaseLive.pipe(
        Layer.provide(PromotionPgClientLive),
        Layer.provide(Reactivity.layer),
        Layer.provide(Layer.succeed(DatabaseConfig, test.connections.runtime)),
      );
      const compositionSource = { available: true };
      const services = Layer.mergeAll(
        fixture.layer,
        Layer.succeed(ActionRuntime, fixture.actionRuntime),
        verifier,
        Layer.succeed(ActiveApplicationCompositionService, {
          load: Effect.suspend(() =>
            compositionSource.available
              ? Effect.succeed(test.authority.snapshot)
              : Effect.fail(
                  new ActiveApplicationCompositionUnavailableError({
                    cause: new Error('controlled private source diagnostic'),
                    reason: 'Native source outage',
                  }),
                ),
          ),
        }),
        GatewayAssertionRedemptionLive.pipe(Layer.provide(database)),
      );
      const api = HttpApi.make('PromotionApi')
        .add(promotionApi.groups.createPromotionDraftAction)
        .add(promotionApi.groups.publishPromotionAction)
        .add(promotionApi.groups.provisionVoucherAction)
        .add(promotionApi.groups.disableVoucherAction)
        .add(promotionApi.groups.readPromotions)
        .add(promotionApi.groups.readVouchers)
        .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
      const handlers = Layer.mergeAll(
        createPromotionDraftActionApiLive,
        publishPromotionActionApiLive,
        provisionVoucherActionApiLive,
        disableVoucherActionApiLive,
        readPromotionsReadApiLive,
        readVouchersReadApiLive,
      ).pipe(Layer.provide(services));
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(api).pipe(
              Layer.provide(handlers),
              Layer.provideMerge(services),
              Layer.provide(HttpServer.layerServices),
              Layer.provide(NodeCrypto.layer),
            ),
            { disableLogger: true },
          ),
        ),
        (value) => Effect.promise(() => value.dispose()).pipe(Effect.orDie),
      );
      const nativeFetch: typeof fetch = async (input, init) =>
        await app.handler(new Request(input, init), Context.empty());
      const promotionId = yield* nextId;
      const payload = yield* Schema.decodeUnknownEffect(CreatePromotionDraftPayloadSchema)({
        meaning: {
          activation: 'AUTOMATIC',
          benefit: { kind: 'PERCENTAGE', percentage: '10' },
          displayName: 'HTTP-owned draft',
          effectivePeriod: { from: DateTime.formatIso(yield* DateTime.now) },
          eligibility: {
            commercialScopes: [
              { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: fixture.principal.legalEntityId },
            ],
          },
          family: 'AUTOMATIC_CART',
          target: 'MERCHANDISE_CART',
        },
        promotionId,
        reason: 'Native HTTP acceptance',
      });
      const raw = Effect.fn('PromotionHttpTest.raw')(function* raw(
        path: string,
        body: HttpTestPayload,
        credential?: string,
      ) {
        const headers = new Headers({
          'content-type': 'application/json',
          'idempotency-key': yield* nextId,
          'x-correlation-id': yield* nextId,
        });
        if (credential !== undefined) {
          headers.set('authorization', credential);
        }
        return yield* Effect.promise(
          async () =>
            await app.handler(
              new Request(`${baseUrl}${path}`, { body: JSON.stringify(body), headers, method: 'POST' }),
              Context.empty(),
            ),
        );
      });
      const encodedPayload = yield* Schema.encodeEffect(CreatePromotionDraftPayloadSchema)(payload);
      for (const path of [
        '/promotion/actions/create-promotion-draft',
        '/reads/read-promotions',
        '/reads/read-vouchers',
      ]) {
        const body = path.includes('/actions/') ? encodedPayload : {};
        for (const credential of [
          undefined,
          'Bearer malformed',
          yield* authorization({ audience: 'catalog' }),
          yield* authorization({ buildMarker: 'foreign-deployment' }),
        ]) {
          const response = yield* raw(path, body, credential);
          expect(response.status).toBe(401);
          expect(response.headers.get('www-authenticate')).toBe('Bearer');
        }
      }
      const legacyImport = { ...encodedPayload, sourceRecordId: 'legacy:campaign:42' };
      const invalidImport = yield* raw(
        '/promotion/actions/create-promotion-draft',
        legacyImport,
        yield* authorization(),
      );
      expect(invalidImport.status).toBe(400);
      expect(yield* fixture.evidenceCount()).toBe(0);
      const created = yield* executeCreatePromotionDraftWithAuthorization(
        payload,
        yield* authorization(),
        yield* nextId,
        { baseUrl, compositionRevision: test.snapshot.composition.revision, idempotencyKey: yield* nextId },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      expect(created).toHaveProperty('promotionRef.resourceId', promotionId);
      const read = yield* executeReadPromotionsWithAuthorization({}, yield* authorization(), yield* nextId, {
        baseUrl,
        compositionRevision: test.snapshot.composition.revision,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      expect(read.promotions.map((record) => record.promotionId)).toContain(promotionId);
      expect(JSON.stringify(read)).not.toContain('Native HTTP acceptance');
      const voucherPromotionId = yield* nextId;
      const voucherPayload = yield* Schema.decodeUnknownEffect(CreatePromotionDraftPayloadSchema)({
        ...encodedPayload,
        meaning: {
          ...encodedPayload.meaning,
          activation: 'VOUCHER',
          family: 'PRODUCT_VOUCHER',
          target: 'PURCHASE_DEMAND_OCCURRENCE',
        },
        promotionId: voucherPromotionId,
      });
      yield* executeCreatePromotionDraftWithAuthorization(voucherPayload, yield* authorization(), yield* nextId, {
        baseUrl,
        compositionRevision: test.snapshot.composition.revision,
        idempotencyKey: yield* nextId,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      yield* executePublishPromotionWithAuthorization(
        { expectedVersion: 1, promotionId: voucherPromotionId, reason: 'HTTP permanent code acceptance' },
        yield* authorization(),
        yield* nextId,
        {
          baseUrl,
          compositionRevision: test.snapshot.composition.revision,
          idempotencyKey: yield* nextId,
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      const voucherId = yield* nextId;
      const provisioned = yield* executeProvisionVoucherWithAuthorization(
        {
          code: ' PERMANENT-HTTP ',
          promotionId: voucherPromotionId,
          reason: 'HTTP permanent code acceptance',
          voucherId,
        },
        yield* authorization(),
        yield* nextId,
        {
          baseUrl,
          compositionRevision: test.snapshot.composition.revision,
          idempotencyKey: yield* nextId,
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      expect(provisioned).toHaveProperty('voucherRef.resourceId', voucherId);
      yield* executeDisableVoucherWithAuthorization(
        { expectedDisabled: false, reason: 'HTTP permanent code acceptance', voucherId },
        yield* authorization(),
        yield* nextId,
        {
          baseUrl,
          compositionRevision: test.snapshot.composition.revision,
          idempotencyKey: yield* nextId,
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      const collision = yield* Effect.flip(
        executeProvisionVoucherWithAuthorization(
          {
            code: 'permanent-http',
            promotionId: voucherPromotionId,
            reason: 'HTTP permanent code acceptance',
            voucherId: yield* nextId,
          },
          yield* authorization(),
          yield* nextId,
          {
            baseUrl,
            compositionRevision: test.snapshot.composition.revision,
            idempotencyKey: yield* nextId,
          },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch)),
      );
      expect(Schema.is(ProvisionVoucherActionConflictProblemSchema)(collision)).toBe(true);
      expect(collision).toHaveProperty('status', 409);
      expect(collision).toHaveProperty('code', 'CODE_ALREADY_BOUND');
      expect(JSON.stringify(collision)).not.toContain('permanent-http');
      const noncanonicalReference = yield* raw(
        '/promotion/actions/provision-voucher',
        {
          code: 'case-http',
          promotionId: voucherPromotionId,
          reason: 'Canonical owner identity',
          voucherId: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF',
        },
        yield* authorization(),
      );
      expect(noncanonicalReference.status).toBe(400);
      const once = yield* authorization();
      expect((yield* raw('/reads/read-promotions', {}, once)).status).toBe(200);
      expect((yield* raw('/reads/read-promotions', {}, once)).status).toBe(401);
      const crossTenant = yield* raw('/reads/read-promotions', {}, yield* authorization({ tenantId: yield* nextId }));
      // A correctly signed identity still requires authorization to select this Tenant scope.
      expect(crossTenant.status).toBe(403);
      const installed = test.authority.snapshot;
      test.authority.snapshot = yield* makeApplicationCompositionSnapshotFixture([]);
      expect((yield* raw('/reads/read-promotions', {}, yield* authorization())).status).toBe(401);
      test.authority.snapshot = installed;
      compositionSource.available = false;
      const sourceOutage = yield* raw('/reads/read-promotions', {}, yield* authorization());
      expect(sourceOutage.status).toBe(503);
      const sourceProblem = yield* Effect.promise(async () => await sourceOutage.json());
      expect(sourceProblem).not.toHaveProperty('cause');
      expect(JSON.stringify(sourceProblem)).not.toContain('controlled private source diagnostic');
      expect(JSON.stringify(sourceProblem)).not.toContain('Native source outage');
      compositionSource.available = true;
      test.access.defaultAnswer.outcome = 'DENIED';
      expect((yield* raw('/reads/read-promotions', {}, yield* authorization())).status).toBe(403);
      expect(
        (yield* raw('/promotion/actions/create-promotion-draft', encodedPayload, yield* authorization())).status,
      ).toBe(403);
      test.access.defaultAnswer.outcome = 'UNAVAILABLE';
      expect((yield* raw('/reads/read-promotions', {}, yield* authorization())).status).toBe(503);
      expect(
        (yield* raw('/promotion/actions/create-promotion-draft', encodedPayload, yield* authorization())).status,
      ).toBe(503);
      return yield* Effect.void;
    }).pipe(Effect.provide(nativeServices)),
  );
});
