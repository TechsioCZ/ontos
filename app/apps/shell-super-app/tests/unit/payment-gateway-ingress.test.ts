import { readFileSync } from 'node:fs';

import { CaptureProviderNotificationPayloadSchema } from '@app/payment/api/capture-provider-notification-action';
import {
  PROVIDER_BINDING_ROUTE_OPERATIONS,
  ProviderBindingRouteResponseSchema,
} from '@app/payment/api/provider-binding-route';
import {
  RequestPaymentOperationRecoveryActionAlreadyCommittedProblemSchema,
  RequestPaymentOperationRecoveryActionConflictProblemSchema,
  RequestPaymentOperationRecoveryActionIneligibleProblemSchema,
} from '@app/payment/api/request-payment-operation-recovery-action';
import {
  PAYMENT_GATEWAY_RELAY_PATH_PREFIX,
  PAYMENT_NOTIFICATION_MAXIMUM_BYTES,
  PAYMENT_RECONCILIATION_CONFLICT_CODES,
  PAYMENT_RECONCILIATION_INELIGIBLE_CODES,
  PaymentReconciliationIneligibleProblemSchema,
} from '@app/payment/payment-gateway-relay';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApi } from '@modern-js/bff-effect/effect-client';
import { dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Effect, Exit, Layer, Logger, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { ShellCryptoLive } from '../../api/auth/gateway-issuer.ts';
import { PaymentGatewayDefectSeamLive } from '../../api/index.ts';
import { paymentRouteRefused } from '../../api/payment-gateway/contract.ts';
import type { PaymentRouteAuthorizationInput, PaymentRouteRefused } from '../../api/payment-gateway/contract.ts';
import {
  PaymentNotificationBoundaryLive,
  PaymentReconciliationBoundaryLive,
} from '../../api/payment-gateway/defect-boundary.ts';
import { PAYMENT_NOTIFICATION_RELAY_CREDENTIALS_VARIABLE } from '../../api/payment-gateway/relay-credentials.ts';
import {
  PaymentGatewayHostMountLive,
  PaymentGatewayRelay,
  PaymentGatewayRelayTransportLive,
  PaymentNotificationHandlersLive,
  PaymentReconciliationHandlersLive,
} from '../../api/payment-gateway/transport.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';

const host = 'https://shell.example.test';
/** The in-process Payment release base the relay hands the generated clients. */
const baseUrl = new URL('https://payment-owner-relay.invalid/module-api/payment/fixture-build/payment-api');
const tenantId = '50000000-0000-4000-8000-000000000001';
const unknownTenant = '50000000-0000-4000-8000-0000000000ff';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const bindingId = '70000000-0000-4000-8000-000000000001';
const routeKey = 'R'.repeat(43);
const relayKey = 'synthetic-relay-key-not-a-secret';
const reconciliationKey = 'synthetic-reconciliation-key-not-a-secret';
const assertionToken = 'synthetic-route-assertion';
const comgateSecret = 'synthetic-comgate-secret-value';
const stripeFixtures = new URL('../../../../verticals/payment/tests/fixtures/stripe-signature/', import.meta.url);
const StripeVectorsSchema = Schema.Struct({
  bodyFile: Schema.String,
  secret: Schema.String,
  timestamp: Schema.Number,
  validV1: Schema.String,
});
const stripeVectors = Schema.decodeUnknownSync(Schema.fromJsonString(StripeVectorsSchema))(
  readFileSync(new URL('vectors.json', stripeFixtures), 'utf-8'),
);
const stripeBody = new Uint8Array(readFileSync(new URL(stripeVectors.bodyFile, stripeFixtures)));
const stripeHeader = `t=${stripeVectors.timestamp},v1=${stripeVectors.validV1}`;

const route = Schema.decodeUnknownSync(ProviderBindingRouteResponseSchema)({
  bindingId,
  bindingRef: `pab_${'a'.repeat(32)}`,
  bindingStatus: 'CURRENT',
  environment: 'SANDBOX',
  legalEntityId,
  operations: PROVIDER_BINDING_ROUTE_OPERATIONS,
  providerFamily: 'STRIPE',
  routeRevision: 2,
  tenantId,
});
const recoveryResult = {
  executorWorkAdmitted: false,
  heldForReconciliation: true,
  modeDowngraded: false,
  operationId: '81000000-0000-4000-8000-000000000001',
  operationKey: 'collect-1',
  operationKind: 'COLLECT',
  operationOutcome: 'INDETERMINATE',
  originalCompositionRevision: 'c'.repeat(64),
  paymentId: '82000000-0000-4000-8000-000000000001',
  previousOutcome: 'INDETERMINATE',
  providerReplay: 'NOT_PROVEN',
  recoveryId: '83000000-0000-4000-8000-000000000001',
  recoveryMode: 'AUTHORITATIVE_LOOKUP',
  requestedAt: '2026-11-12T10:00:00.000Z',
};
const recoveryPayload = {
  operationId: recoveryResult.operationId,
  paymentId: recoveryResult.paymentId,
  reason: 'Gateway reconciliation round 1',
  trigger: 'OUTCOME_OVERDUE',
};

const OwnerBodySchema = Schema.Record(Schema.String, Schema.Json);
interface OwnerCall {
  readonly authorization: string | null;
  readonly body: typeof OwnerBodySchema.Type;
  readonly idempotencyKey: string | null;
  readonly url: string;
}

const problemResponse = (status: number, body: typeof OwnerBodySchema.Type) =>
  Response.json(
    { detail: 'Owner refusal.', status, title: 'Owner refusal', type: 'https://ontos.dev/problems/owner', ...body },
    { headers: { 'content-type': 'application/problem+json' }, status },
  );

const fixtureApi = HttpApi.make(ShellAuthenticationApi.identifier)
  .add(ShellAuthenticationApi.groups.paymentNotifications)
  .add(ShellAuthenticationApi.groups.paymentReconciliation);

const start = (
  options: {
    readonly authorize?: (input: PaymentRouteAuthorizationInput) => Effect.Effect<typeof route, PaymentRouteRefused>;
    readonly credentials?: string;
    /** The owner answer; `connection-reset` fails the transport like a lost connection. */
    readonly owner?: (call: OwnerCall) => Response | 'connection-reset';
  } = {},
) => {
  const authorizations: PaymentRouteAuthorizationInput[] = [];
  const ownerCalls: OwnerCall[] = [];
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.layer([
    Logger.make((log) => {
      logs.push(Logger.formatStructured.log(log));
    }),
  ]);
  const relay = Layer.succeed(PaymentGatewayRelay, {
    authorize: (input) => {
      authorizations.push(input);
      return (options.authorize?.(input) ?? Effect.succeed(route)).pipe(
        Effect.map((answer) => ({
          assertion: Redacted.make(assertionToken),
          baseUrl,
          compositionRevision: 'fixture-revision',
          route: answer,
        })),
      );
    },
  });
  const ownerFetch: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init);
    const call = {
      authorization: incoming.headers.get('authorization'),
      body: Schema.decodeUnknownSync(Schema.fromJsonString(OwnerBodySchema))(await incoming.text()),
      idempotencyKey: incoming.headers.get('idempotency-key'),
      url: incoming.url,
    };
    ownerCalls.push(call);
    const answer = options.owner?.(call);
    if (answer === 'connection-reset') {
      throw new TypeError('connection reset');
    }
    if (answer !== undefined) {
      return answer;
    }
    return call.url.endsWith('/payment/actions/request-payment-operation-recovery')
      ? Response.json(recoveryResult)
      : Response.json({ _tag: 'CAPTURED', notificationId: '84000000-0000-4000-8000-000000000001' });
  };
  const configuration = ConfigProvider.fromUnknown(
    options.credentials === undefined ? {} : { [PAYMENT_NOTIFICATION_RELAY_CREDENTIALS_VARIABLE]: options.credentials },
  );
  const handlers = Layer.mergeAll(PaymentNotificationHandlersLive, PaymentReconciliationHandlersLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        relay,
        Layer.mergeAll(PaymentNotificationBoundaryLive, PaymentReconciliationBoundaryLive).pipe(
          Layer.provide(PaymentGatewayDefectSeamLive),
        ),
        Layer.succeed(FetchHttpClient.Fetch, ownerFetch),
        Layer.succeed(ConfigProvider.ConfigProvider, configuration),
        ShellCryptoLive,
        logger,
      ),
    ),
  );
  const runtime = assembleEffectBffRuntime({
    api: fixtureApi,
    handlers,
    transport: PaymentGatewayRelayTransportLive.pipe(Layer.provide(PaymentGatewayHostMountLive)),
  }).createHandler({
    dataPlatform: { batch: { enabled: false }, enabled: false },
    openapi: { path: '/openapi.json' },
  });
  return {
    authorizations,
    dispose: runtime.dispose,
    logs,
    ownerCalls,
    request: (path: string, init: RequestInit = {}) =>
      dispatchEffectBffRequest((request) => runtime.handler(request), new Request(host + path, init), {
        prefix: PAYMENT_GATEWAY_RELAY_PATH_PREFIX,
      }),
  };
};

const credentials = JSON.stringify([{ apiKey: relayKey, tenantId }]);
const server = (options: Parameters<typeof start>[0] = {}) =>
  Effect.acquireRelease(
    Effect.sync(() => start({ credentials, ...options })),
    (fixture) => Effect.promise(fixture.dispose),
  );
const send = (fixture: ReturnType<typeof start>, path: string, init: RequestInit = {}) =>
  Effect.promise(async () => {
    const response = await fixture.request(path, init);
    return { body: await response.text(), headers: response.headers, status: response.status };
  });
const notificationPath = (family: string, tenant = tenantId, key = routeKey) =>
  `/api/payment/v1/notifications/${family}/${tenant}/${key}`;
const recoveryPath = `/api/payment/v1/reconciliation/${routeKey}/recoveries`;
const rawBodyOf = (call: OwnerCall | undefined) =>
  new Uint8Array(Buffer.from(Schema.decodeUnknownSync(Schema.String)(call?.body['rawBody']), 'base64'));
const postStripe = (fixture: ReturnType<typeof start>, body: BodyInit, contentType = 'application/json') =>
  send(fixture, notificationPath('stripe'), {
    body,
    headers: { 'content-type': contentType, 'stripe-signature': stripeHeader },
    method: 'POST',
  });

/** A valid JSON document of exactly `size` bytes. */
const paddedJson = (size: number) => new TextEncoder().encode(`{"pad":"${'x'.repeat(size - 10)}"}`);

const stripeHmac = (body: Uint8Array) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(stripeVectors.secret),
      { hash: 'SHA-256', name: 'HMAC' },
      false,
      ['sign'],
    );
    const prefix = new TextEncoder().encode(`${stripeVectors.timestamp}.`);
    const signed = new Uint8Array(prefix.length + body.length);
    signed.set(prefix, 0);
    signed.set(body, prefix.length);
    return Buffer.from(await crypto.subtle.sign('HMAC', key, signed)).toString('hex');
  });

describe('payment notification relay', () => {
  it.effect('relays exact Stripe bytes that still verify against their signature, under route-owned facts', () =>
    Effect.gen(function* exactStripeBytes() {
      const fixture = yield* server();
      const reply = yield* postStripe(fixture, stripeBody, 'application/json; charset=utf-8');
      expect(reply.status).toBe(200);
      expect(reply.body).toBe('OK');
      const [call] = fixture.ownerCalls;
      expect(call?.url).toBe(
        'https://payment-owner-relay.invalid/module-api/payment/fixture-build/payment-api/payment/actions/capture-provider-notification',
      );
      expect(call?.authorization).toBe(`Bearer ${assertionToken}`);
      const relayed = rawBodyOf(call);
      expect(relayed).toEqual(stripeBody);
      expect(yield* stripeHmac(relayed)).toBe(stripeVectors.validV1);
      expect(call?.body).toMatchObject({
        environment: 'SANDBOX',
        family: 'STRIPE',
        headers: { contentType: 'application/json; charset=utf-8', stripeSignature: stripeHeader },
        providerAccountRef: route.bindingRef,
        query: {},
      });
      expect(fixture.authorizations).toEqual([
        {
          apiKey: expect.anything(),
          notificationPath: Option.some({ providerFamily: 'STRIPE', tenantId }),
          routeKey,
          workload: 'payment.provider-notification-ingress',
        },
      ]);
      expect(Redacted.value(fixture.authorizations[0]?.apiKey ?? Redacted.make(''))).toBe(relayKey);
    }),
  );

  it.effect('keeps CRLF, unicode escapes and trailing whitespace byte for byte', () =>
    Effect.gen(function* exactCraftedBytes() {
      const fixture = yield* server();
      // Valid JSON only: the Modern BFF host refuses an unparsable `application/json` body before routing.
      const crafted = new TextEncoder().encode(
        '{\r\n  "id": "evt_\\u00e9\\ud83d\\ude00",\r\n  "note": "café 😀"\r\n}  \t\r\n',
      );
      const reply = yield* postStripe(fixture, crafted);
      expect(reply.status).toBe(200);
      const relayed = rawBodyOf(fixture.ownerCalls[0]);
      expect(relayed).toEqual(crafted);
      expect(yield* stripeHmac(relayed)).toBe(yield* stripeHmac(crafted));
    }),
  );

  it.effect('answers a body above 64 KiB with 413 and never calls authorization or capture', () =>
    Effect.gen(function* tooLarge() {
      const fixture = yield* server();
      const atLimit = yield* postStripe(fixture, paddedJson(PAYMENT_NOTIFICATION_MAXIMUM_BYTES));
      expect(atLimit.status).toBe(200);
      expect(rawBodyOf(fixture.ownerCalls[0])).toHaveLength(PAYMENT_NOTIFICATION_MAXIMUM_BYTES);
      const oversized = yield* postStripe(fixture, paddedJson(PAYMENT_NOTIFICATION_MAXIMUM_BYTES + 1));
      expect(oversized.status).toBe(413);
      expect(fixture.ownerCalls).toHaveLength(1);
      expect(fixture.authorizations).toHaveLength(1);
    }),
  );

  it.effect('relays Comgate form and JSON bodies byte-exact and replies with the Comgate acknowledgement', () =>
    Effect.gen(function* comgate() {
      const fixture = yield* server();
      const form = `transId=AB12-CD34-EF56&secret=${comgateSecret}&status=PAID&price=15995&curr=CZK`;
      const json = `{"transId":"AB12-CD34-EF56","secret":"${comgateSecret}","status":"PAID"}\n`;
      for (const [body, contentType] of [
        [form, 'application/x-www-form-urlencoded'],
        [json, 'application/json'],
      ] as const) {
        const reply = yield* send(fixture, notificationPath('comgate'), {
          body,
          headers: { 'content-type': contentType },
          method: 'POST',
        });
        expect(reply.status).toBe(200);
        expect(reply.body).toBe('code=0&message=OK');
      }
      expect(fixture.ownerCalls.map(rawBodyOf).map((bytes) => new TextDecoder().decode(bytes))).toEqual([form, json]);
      expect(fixture.ownerCalls.map((call) => call.body['headers'])).toEqual([
        { contentType: 'application/x-www-form-urlencoded' },
        { contentType: 'application/json' },
      ]);
      expect(
        fixture.authorizations.map((input) => input.notificationPath.pipe(Option.map((path) => path.providerFamily))),
      ).toEqual([Option.some('COMGATE'), Option.some('COMGATE')]);
    }),
  );

  it.effect('maps the GoPay callback query to the capture query with an empty body', () =>
    Effect.gen(function* gopay() {
      const fixture = yield* server();
      const reply = yield* send(fixture, `${notificationPath('gopay')}?id=3000006529&parent_id=3000006500&extra=1`);
      expect(reply.status).toBe(200);
      expect(reply.body).toBe('OK');
      const [call] = fixture.ownerCalls;
      expect(call?.body['query']).toEqual({ parentPaymentRef: '3000006500', paymentRef: '3000006529' });
      expect(call?.body['headers']).toEqual({});
      expect(rawBodyOf(call)).toHaveLength(0);
      expect(fixture.authorizations[0]?.notificationPath).toEqual(Option.some({ providerFamily: 'GOPAY', tenantId }));
    }),
  );

  it.effect('uses a fresh idempotency key and delivery reference for every attempt', () =>
    Effect.gen(function* freshAttempts() {
      const fixture = yield* server();
      yield* postStripe(fixture, stripeBody);
      yield* postStripe(fixture, stripeBody);
      const [first, second] = fixture.ownerCalls;
      expect(first?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
      expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
      expect(first?.body['transportDeliveryRef']).not.toBe(second?.body['transportDeliveryRef']);
      expect(fixture.authorizations).toHaveLength(2);
    }),
  );

  it.effect('acknowledges only recorded notifications and lets the provider retry everything else', () =>
    Effect.gen(function* resultMapping() {
      const notificationId = '84000000-0000-4000-8000-000000000001';
      const cases: readonly (readonly [() => Response | 'connection-reset', number])[] = [
        [() => Response.json({ _tag: 'CAPTURED', notificationId }), 200],
        [() => Response.json({ _tag: 'DUPLICATE', notificationId }), 200],
        [() => Response.json({ _tag: 'IGNORED', notificationId }), 200],
        [() => Response.json({ _tag: 'REJECTED', reason: 'SIGNATURE_INVALID' }), 400],
        [() => Response.json({ _tag: 'REJECTED', reason: 'MALFORMED' }), 400],
        [() => Response.json({ _tag: 'REJECTED', reason: 'BINDING_UNKNOWN' }), 404],
        [
          () =>
            problemResponse(503, {
              _tag: 'CaptureProviderNotificationActionUnavailableProblem',
              code: 'payment_unavailable',
              retryable: true,
            }),
          503,
        ],
        [
          () =>
            problemResponse(409, {
              _tag: 'CaptureProviderNotificationActionConflictProblem',
              code: 'action_request_hash_conflict',
            }),
          503,
        ],
        [() => Response.json({ _tag: 'CAPTURED' }), 503],
        [() => 'connection-reset', 503],
      ];
      for (const [owner, status] of cases) {
        const fixture = yield* server({ owner });
        const reply = yield* postStripe(fixture, stripeBody);
        expect(reply.status).toBe(status);
        expect(reply.body).not.toContain('evt_c17');
      }
    }),
  );

  it.effect('answers an unknown tenant credential and an unknown route with the same 404', () =>
    Effect.gen(function* indistinguishable() {
      const fixture = yield* server({
        authorize: (input) => (input.routeKey === routeKey ? Effect.succeed(route) : paymentRouteRefused('not_found')),
        credentials: JSON.stringify([
          { apiKey: 'synthetic-malformed-entry', tenantId: 'not-a-tenant' },
          { apiKey: relayKey, tenantId },
          { apiKey: 'synthetic-duplicate-a', tenantId: '50000000-0000-4000-8000-000000000002' },
          { apiKey: 'synthetic-duplicate-b', tenantId: '50000000-0000-4000-8000-000000000002' },
        ]),
      });
      const unknownTenantReply = yield* postStripe(fixture, stripeBody).pipe(
        Effect.andThen(() =>
          send(fixture, notificationPath('stripe', unknownTenant), {
            body: stripeBody,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }),
        ),
      );
      const duplicateReply = yield* send(fixture, notificationPath('stripe', '50000000-0000-4000-8000-000000000002'), {
        body: stripeBody,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const unknownRouteReply = yield* send(fixture, notificationPath('stripe', tenantId, 'U'.repeat(43)), {
        body: stripeBody,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(unknownTenantReply.status).toBe(404);
      expect(unknownRouteReply.status).toBe(404);
      expect([duplicateReply.status, duplicateReply.body]).toEqual([unknownRouteReply.status, unknownRouteReply.body]);
      expect(unknownTenantReply.body).toBe(unknownRouteReply.body);
      expect(fixture.authorizations.map((input) => input.routeKey)).toEqual([routeKey, 'U'.repeat(43)]);
      expect(fixture.ownerCalls).toHaveLength(1);
    }),
  );

  it.effect('answers a missing credential configuration with 404 and a route family mismatch with 404', () =>
    Effect.gen(function* missingConfiguration() {
      const unconfigured = yield* Effect.acquireRelease(
        Effect.sync(() => start()),
        (fixture) => Effect.promise(fixture.dispose),
      );
      expect((yield* postStripe(unconfigured, stripeBody)).status).toBe(404);
      expect(unconfigured.authorizations).toHaveLength(0);
      const familyMismatch = yield* server({ authorize: () => paymentRouteRefused('not_found') });
      expect((yield* send(familyMismatch, `${notificationPath('gopay')}?id=1`)).status).toBe(404);
    }),
  );

  it.effect('answers a refused or unavailable relay authority with the retryable 503', () =>
    Effect.gen(function* refusedAuthority() {
      for (const reason of ['unauthenticated', 'forbidden', 'unavailable'] as const) {
        const fixture = yield* server({ authorize: () => paymentRouteRefused(reason) });
        const reply = yield* postStripe(fixture, stripeBody);
        expect(reply.status).toBe(503);
        expect(fixture.ownerCalls).toHaveLength(0);
      }
    }),
  );

  it.effect('logs a defect by class only: no body byte, provider secret, signature or key reaches a log or reply', () =>
    Effect.gen(function* sanitizedDefect() {
      const fixture = yield* server({
        authorize: (input) =>
          Effect.die(`defect carrying ${Redacted.value(input.apiKey)} ${comgateSecret} ${stripeHeader} ${routeKey}`),
      });
      const reply = yield* send(fixture, notificationPath('comgate'), {
        body: `transId=AB12&secret=${comgateSecret}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      });
      expect(reply.status).toBe(503);
      const observed = JSON.stringify(fixture.logs) + reply.body;
      for (const secret of [relayKey, comgateSecret, stripeVectors.validV1, routeKey, 'transId=AB12']) {
        expect(observed).not.toContain(secret);
      }
      expect(fixture.logs.some((log) => log.level === 'ERROR')).toBe(true);
    }),
  );
});

type RecoveryRequestBody = typeof recoveryPayload & { readonly requestedMode?: string; readonly tenantId?: string };
const recover = (fixture: ReturnType<typeof start>, payload: RecoveryRequestBody = recoveryPayload) =>
  send(fixture, recoveryPath, {
    body: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'payment.gateway-reconciliation:81000000-0000-4000-8000-000000000001:r1',
      'x-api-key': reconciliationKey,
    },
    method: 'POST',
  });

describe('payment reconciliation relay', () => {
  it.effect('calls A10 under the route scope and forwards the idempotency key unchanged', () =>
    Effect.gen(function* recovered() {
      const fixture = yield* server();
      const reply = yield* recover(fixture);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toEqual(recoveryResult);
      const [call] = fixture.ownerCalls;
      expect(call?.url).toBe(
        'https://payment-owner-relay.invalid/module-api/payment/fixture-build/payment-api/payment/actions/request-payment-operation-recovery',
      );
      expect(call?.idempotencyKey).toBe('payment.gateway-reconciliation:81000000-0000-4000-8000-000000000001:r1');
      expect(call?.authorization).toBe(`Bearer ${assertionToken}`);
      expect(call?.body).toEqual(recoveryPayload);
      const [authorization] = fixture.authorizations;
      expect(authorization?.workload).toBe('payment.provider-reconciliation');
      expect(authorization?.routeKey).toBe(routeKey);
      expect(authorization?.notificationPath).toEqual(Option.none());
      expect(Redacted.value(authorization?.apiKey ?? Redacted.make(''))).toBe(reconciliationKey);
    }),
  );

  it.effect('maps relay refusals: bad key 401, wrong workload 403, route of another tenant 404', () =>
    Effect.gen(function* refusals() {
      for (const [reason, status] of [
        ['unauthenticated', 401],
        ['forbidden', 403],
        ['not_found', 404],
        ['unavailable', 503],
      ] as const) {
        const fixture = yield* server({ authorize: () => paymentRouteRefused(reason) });
        const reply = yield* recover(fixture);
        expect(reply.status).toBe(status);
        expect(reply.body).not.toContain(reconciliationKey);
        expect(fixture.ownerCalls).toHaveLength(0);
      }
    }),
  );

  it.effect('passes A10 refusals through with their codes and answers everything undetermined with 503', () =>
    Effect.gen(function* a10Refusals() {
      const cases: readonly (readonly [() => Response | 'connection-reset', number, string | undefined])[] = [
        [
          () =>
            problemResponse(409, {
              _tag: 'RequestPaymentOperationRecoveryActionConflictProblem',
              code: 'payment_recovery_operation_already_resolved',
            }),
          409,
          'payment_recovery_operation_already_resolved',
        ],
        [
          () =>
            problemResponse(409, {
              _tag: 'RequestPaymentOperationRecoveryActionAlreadyCommittedProblem',
              code: 'action_already_committed',
              invocationId: 'invocation-1',
              resolution: 'REFRESH_GOVERNED_READS',
              retryCommand: false,
            }),
          409,
          'action_already_committed',
        ],
        [
          () =>
            problemResponse(422, {
              _tag: 'RequestPaymentOperationRecoveryActionIneligibleProblem',
              code: 'payment_reconciliation_evidence_not_qualified',
            }),
          422,
          'payment_reconciliation_evidence_not_qualified',
        ],
        [
          () =>
            problemResponse(403, {
              _tag: 'RequestPaymentOperationRecoveryActionForbiddenProblem',
              code: 'operation_context_denied',
            }),
          403,
          undefined,
        ],
        [
          () =>
            problemResponse(404, {
              _tag: 'RequestPaymentOperationRecoveryActionNotFoundProblem',
              code: 'payment_operation_not_found',
            }),
          404,
          undefined,
        ],
        [
          () =>
            problemResponse(503, {
              _tag: 'RequestPaymentOperationRecoveryActionCommitIndeterminateProblem',
              invocationId: 'invocation-1',
              resolution: 'RESOLVE_COMMIT',
              retryCommand: false,
            }),
          503,
          undefined,
        ],
        [
          () => problemResponse(401, { _tag: 'RequestPaymentOperationRecoveryActionAuthenticationProblem' }),
          503,
          undefined,
        ],
        [
          () =>
            Response.json(
              {
                _tag: 'ActionProposalAccepted',
                expiresAt: '2026-11-13T10:00:00.000Z',
                proposalId: crypto.randomUUID(),
              },
              { status: 202 },
            ),
          403,
          undefined,
        ],
        [() => 'connection-reset', 503, undefined],
      ];
      for (const [answer, status, code] of cases) {
        const fixture = yield* server({ owner: answer });
        const reply = yield* recover(fixture);
        expect(reply.status).toBe(status);
        if (code !== undefined) {
          expect(JSON.parse(reply.body)).toMatchObject({ code });
        }
      }
    }),
  );

  it.effect('refuses an excess or weakened payload as request_invalid before any authority', () =>
    Effect.gen(function* invalidRequests() {
      const fixture = yield* server();
      const weakened = yield* recover(fixture, { ...recoveryPayload, requestedMode: 'AUTHORITATIVE_LOOKUP' });
      const foreignTenant = yield* recover(fixture, { ...recoveryPayload, tenantId });
      for (const reply of [weakened, foreignTenant]) {
        expect(reply.status).toBe(422);
        expect(JSON.parse(reply.body)).toMatchObject({ code: 'request_invalid' });
      }
      expect(fixture.authorizations).toHaveLength(0);
    }),
  );
});

const capturePayloadOfSize = (size: number) => ({
  environment: 'SANDBOX',
  family: 'STRIPE',
  headers: {},
  providerAccountRef: route.bindingRef,
  query: {},
  rawBody: Buffer.from(new Uint8Array(size)).toString('base64'),
  transportDeliveryRef: 'delivery-1',
});

describe('relay contract pins', () => {
  it('keeps the relay body limit equal to the captured notification limit', () => {
    const decode = Schema.decodeUnknownExit(CaptureProviderNotificationPayloadSchema);
    expect(Exit.isSuccess(decode(capturePayloadOfSize(PAYMENT_NOTIFICATION_MAXIMUM_BYTES)))).toBe(true);
    expect(Exit.isFailure(decode(capturePayloadOfSize(PAYMENT_NOTIFICATION_MAXIMUM_BYTES + 1)))).toBe(true);
  });

  it('keeps the relay 409 and 422 code lists equal to the A10 problem schemas', () => {
    expect([...PAYMENT_RECONCILIATION_CONFLICT_CODES].toSorted()).toEqual(
      [
        ...RequestPaymentOperationRecoveryActionConflictProblemSchema.fields.code.literals,
        RequestPaymentOperationRecoveryActionAlreadyCommittedProblemSchema.fields.code.literal,
      ].toSorted(),
    );
    expect([...PAYMENT_RECONCILIATION_INELIGIBLE_CODES].toSorted()).toEqual(
      [...RequestPaymentOperationRecoveryActionIneligibleProblemSchema.fields.code.literals].toSorted(),
    );
    expect([...PaymentReconciliationIneligibleProblemSchema.fields.code.literals].toSorted()).toEqual(
      [...PAYMENT_RECONCILIATION_INELIGIBLE_CODES, 'request_invalid'].toSorted(),
    );
  });
});
