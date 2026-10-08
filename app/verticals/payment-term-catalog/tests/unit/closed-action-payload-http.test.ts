import { ActionRuntime, GatewayAssertionRedemptionService } from '@app/core-runtime';
import type { ActionRuntimeService, GatewayAssertionRedemption } from '@app/core-runtime';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient as stableFetchHttpClient } from 'effect/unstable/http';
import { exportJWK, generateKeyPair } from 'jose';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { createPaymentTermActionApiLive } from '../../api/create-payment-term-action-server.ts';
import { acceptPaymentTermSourceStatementActionApiLive } from '../../api/accept-payment-term-source-statement-action-server.ts';
import { paymentTermCatalogApi } from '../../shared/api.ts';
import {
  CreatePaymentTermActionAuthenticationProblemSchema,
  CreatePaymentTermActionInvalidProblemSchema,
} from '../../shared/apis/create-payment-term-action.ts';
import {
  AcceptPaymentTermSourceStatementActionAuthenticationProblemSchema,
  AcceptPaymentTermSourceStatementActionInvalidProblemSchema,
} from '../../shared/apis/accept-payment-term-source-statement-action.ts';

const baseUrl = 'https://payment-term-catalog.closed-payload.test';
const createPayment = {
  activeFrom: '2026-01-01T00:00:00.000Z',
  code: 'NET_30',
  description: 'Due in thirty days.',
  name: 'Net 30',
  reason: 'Approved catalog definition',
  semantics: {
    calculationRuleVersion: 2,
    calendarRule: 'CALENDAR_DAYS',
    days: 30,
    dueDateAnchor: 'INVOICE_ISSUE_DATE',
    kind: 'NET_DAYS',
  },
} as const;
const acceptSourceStatement = {
  businessObservedAt: '2026-10-07T10:00:00.000Z',
  externalBusinessSystemId: 'erp-primary',
  integrationRoute: 'erp-definitions',
  mapping: { kind: 'EXISTING', paymentTermId: '22222222-2222-4222-8222-222222222222' },
  namespace: 'invoice-terms',
  reason: 'Authoritative source statement',
  semantics: { evidence: 'Unsupported provider condition', kind: 'UNSUPPORTED' },
  sourceCode: 'NET14',
  sourceRecordId: 'term-14',
  sourceRevision: 1,
  sourceStatementId: 'statement-1',
} as const;

const unusedActionRuntime: ActionRuntimeService = {
  resolveActionCommit: () => Effect.die('The Action runtime is outside this transport proof'),
  runAction: () => Effect.die('The Action runtime is outside this transport proof'),
};
const unusedRedemption: GatewayAssertionRedemption = {
  consume: () => Effect.die('Assertion redemption is outside this transport proof'),
};

const mountCreateAction = Effect.fn('ClosedActionPayloadTest.mount')(function* mountCreateAction() {
  const { publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk = { ...(yield* Effect.promise(() => exportJWK(publicKey))), alg: 'EdDSA', kid: 'closed-payload' };
  const environment = {
    ONTOS_GATEWAY_ISSUER: 'https://shell.closed-payload.test',
    ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ keys: [publicJwk] }),
  };
  const api = HttpApi.make('PaymentTermCatalogApi').add(paymentTermCatalogApi.groups.createPaymentTermAction);
  const actionRuntime = Layer.succeed(ActionRuntime, unusedActionRuntime);
  const redemption = Layer.succeed(GatewayAssertionRedemptionService, unusedRedemption);
  const handlers = createPaymentTermActionApiLive.pipe(
    Layer.provide(ActionPrincipalVerifierLive),
    Layer.provide(ActiveApplicationCompositionSourceLive),
    Layer.provide(stableFetchHttpClient.layer),
    Layer.provide(Layer.mergeAll(actionRuntime, redemption)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
  );
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(handlers),
          Layer.provideMerge(RequestSchemaProblemLive),
          Layer.provideMerge(actionRuntime),
          Layer.provideMerge(redemption),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
  );
});

const mountAcceptSourceAction = Effect.fn('ClosedActionPayloadTest.mountAcceptSource')(
  function* mountAcceptSourceAction() {
    const { publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = { ...(yield* Effect.promise(() => exportJWK(publicKey))), alg: 'EdDSA', kid: 'closed-payload' };
    const environment = {
      ONTOS_GATEWAY_ISSUER: 'https://shell.closed-payload.test',
      ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        keys: [publicJwk],
      }),
    };
    const api = HttpApi.make('PaymentTermCatalogApi').add(
      paymentTermCatalogApi.groups.acceptPaymentTermSourceStatementAction,
    );
    const actionRuntime = Layer.succeed(ActionRuntime, unusedActionRuntime);
    const redemption = Layer.succeed(GatewayAssertionRedemptionService, unusedRedemption);
    const handlers = acceptPaymentTermSourceStatementActionApiLive.pipe(
      Layer.provide(ActionPrincipalVerifierLive),
      Layer.provide(ActiveApplicationCompositionSourceLive),
      Layer.provide(stableFetchHttpClient.layer),
      Layer.provide(Layer.mergeAll(actionRuntime, redemption)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(handlers),
            Layer.provideMerge(RequestSchemaProblemLive),
            Layer.provideMerge(actionRuntime),
            Layer.provideMerge(redemption),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
    );
  },
);

const browserRequest = (body: typeof createPayment | Readonly<{ unknownField: string }>) =>
  new Request(`${baseUrl}/payment-term-catalog/actions/create-payment-term`, {
    body: JSON.stringify(body),
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8',
      'content-type': 'application/json',
      'idempotency-key': 'closed-payload-create-1',
      origin: 'https://shell.closed-payload.test',
      referer: 'https://shell.closed-payload.test/cs/payment-terms',
      'sec-fetch-mode': 'cors',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'x-correlation-id': 'closed-payload-create',
    },
    method: 'POST',
  });

const emptyRequestContext = Context.makeUnsafe<unknown>(new Map());

type SourceRequestBody =
  | typeof acceptSourceStatement
  | (typeof acceptSourceStatement & { readonly actingPrincipalId: string });

const sourceRequest = (body: SourceRequestBody) =>
  new Request(`${baseUrl}/payment-term-catalog/actions/accept-payment-term-source-statement`, {
    body: JSON.stringify(body),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': 'closed-payload-source-1',
      'x-correlation-id': 'closed-payload-source',
    },
    method: 'POST',
  });

describe('closed Action payload at the HTTP edge', () => {
  it.effect('rejects an excess property with the declared invalid Problem and ignores browser headers', () =>
    Effect.gen(function* rejectExcessProperty() {
      const runtime = yield* mountCreateAction();

      // A valid body with full browser headers passes the codecs and reaches authentication.
      const accepted = yield* Effect.promise(() => runtime.handler(browserRequest(createPayment), emptyRequestContext));
      expect(accepted.status).toBe(401);
      yield* Effect.promise(() => accepted.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CreatePaymentTermActionAuthenticationProblemSchema)),
      );

      const rejected = yield* Effect.promise(() =>
        runtime.handler(browserRequest({ ...createPayment, unknownField: 'excess' }), emptyRequestContext),
      );
      expect(rejected.status).toBe(400);
      yield* Effect.promise(() => rejected.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CreatePaymentTermActionInvalidProblemSchema)),
      );
    }),
  );

  it.effect('rejects client-supplied source principal identity before the Action runtime', () =>
    Effect.gen(function* rejectSourceIdentitySpoofing() {
      const runtime = yield* mountAcceptSourceAction();
      const accepted = yield* Effect.promise(() =>
        runtime.handler(sourceRequest(acceptSourceStatement), emptyRequestContext),
      );
      expect(accepted.status).toBe(401);
      yield* Effect.promise(() => accepted.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AcceptPaymentTermSourceStatementActionAuthenticationProblemSchema)),
      );

      const rejected = yield* Effect.promise(() =>
        runtime.handler(
          sourceRequest({
            ...acceptSourceStatement,
            actingPrincipalId: '99999999-9999-4999-8999-999999999999',
          }),
          emptyRequestContext,
        ),
      );
      expect(rejected.status).toBe(400);
      yield* Effect.promise(() => rejected.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AcceptPaymentTermSourceStatementActionInvalidProblemSchema)),
      );
    }),
  );
});
