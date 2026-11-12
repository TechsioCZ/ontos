import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Match, Option, Redacted, Result, Schema } from 'effect';

import { comgateVerifiedStatus, mapComgateStatus } from '../../src/integrations/comgate/comgate-evidence.ts';
import { compareComgatePushedStatus, verifyComgatePush } from '../../src/integrations/comgate/comgate-push.ts';
import type { ComgatePushedStatusComparison } from '../../src/integrations/comgate/comgate-push.ts';
import { ComgateTransIdSchema, decodeComgateStatusBody } from '../../src/integrations/comgate/comgate-wire.ts';
import { RawProviderNotificationSchema } from '../../src/integrations/psp/notification-envelope.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayExecutionTargetSchema } from '../../src/integrations/psp/psp-request.ts';

/**
 * Push bodies are the verbatim examples of https://apidoc.comgate.cz/en/push-notifikace (see
 * tests/fixtures/comgate/README.md). The secret is the documentation's example string.
 */
const fixtureDir = new URL('../fixtures/comgate/', import.meta.url);
const fixtureText = (name: string) => readFileSync(new URL(name, fixtureDir), 'utf-8');
type JsonObject = Readonly<Record<string, typeof Schema.Json.Type>>;
const fixtureJson = (name: string): JsonObject =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(fixtureText(name));

const secret = Redacted.make('gx4q8OV3TJt6noJnfhjqJKyX3Z6Ych0y');
const verifiedAt = DateTime.makeUnsafe('2026-11-12T10:00:05.000Z');
const operationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const { orderReference } = deriveProviderCorrelation(operationId);

const targetIn = (environment: 'LIVE' | 'SANDBOX', merchantId = '123456') =>
  Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
    binding: {
      _tag: 'GATEWAY_ACCOUNT',
      environment,
      providerAccountRef: `pab_${'1'.repeat(32)}`,
      providerFamily: 'COMGATE',
    },
    bindingId: '7d3e9a10-55b2-4f6c-8a1d-2b3c4d5e6f70',
    credentialRevision: 1,
    credentialSecretRef: 'comgate.live',
    legalEntityId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    merchantIdentity: { _tag: 'COMGATE', merchantId },
    notificationUrl: 'https://example.test/notify',
    returnUrl: Option.none(),
    tenantId: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
  });

const notification = (
  body: string,
  contentType: Option.Option<string> = Option.some('application/json'),
  environment: 'LIVE' | 'SANDBOX' = 'LIVE',
) =>
  Schema.decodeUnknownSync(RawProviderNotificationSchema)({
    environment,
    family: 'COMGATE',
    headers: { contentType, stripeSignature: Option.none() },
    providerAccountRef: `pab_${'1'.repeat(32)}`,
    query: { parentPaymentRef: Option.none(), paymentRef: Option.none() },
    rawBody: new TextEncoder().encode(body),
    receivedAt: DateTime.makeUnsafe('2026-11-12T10:00:04.000Z'),
    transportDeliveryRef: 'relay-delivery-1',
  });

const jsonPush = (overrides: JsonObject = {}) => JSON.stringify({ ...fixtureJson('push.json'), ...overrides });

const comparisonLabel = (comparison: ComgatePushedStatusComparison) =>
  Match.value(comparison).pipe(
    Match.tag('AGREES', ({ status }) => `AGREES:${status}`),
    Match.tag('DIFFERS', ({ lookup, pushed }) => `DIFFERS:${lookup}:${Option.getOrElse(pushed, () => '-')}`),
    Match.tag('UNCONFIRMED', ({ pushed }) => `UNCONFIRMED:${Option.getOrElse(pushed, () => '-')}`),
    Match.exhaustive,
  );

const verify = (
  raw: ReturnType<typeof notification>,
  target: ReturnType<typeof targetIn> = targetIn('LIVE'),
  presentedSecret: Redacted.Redacted = secret,
) =>
  verifyComgatePush({ notification: raw, secret: presentedSecret, target, verifiedAt }).pipe(
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result)
        ? { ok: true as const, value: result.success }
        : { error: result.failure, ok: false as const },
    ),
  );

describe('#1157 Comgate push verification', () => {
  it.effect('#1157 Comgate push with wrong secret is rejected', () =>
    Effect.gen(function* wrongSecret() {
      for (const wrong of ['gx4q8OV3TJt6noJnfhjqJKyX3Z6Ych0Y', 'gx4q8OV3TJt6noJnfhjqJKyX3Z6Ych0', 'x']) {
        const result = yield* verify(notification(jsonPush({ secret: wrong })));
        expect(result).toMatchObject({
          error: { _tag: 'GatewayNotificationRejected', family: 'COMGATE', reason: 'SECRET_MISMATCH' },
          ok: false,
        });
      }
      const otherBindingSecret = yield* verify(notification(jsonPush()), targetIn('LIVE'), Redacted.make('other'));
      expect(otherBindingSecret.ok ? undefined : otherBindingSecret.error.reason).toBe('SECRET_MISMATCH');
      const withoutSecret = JSON.stringify(
        Object.fromEntries(Object.entries(fixtureJson('push.json')).filter(([key]) => key !== 'secret')),
      );
      const missing = yield* verify(notification(withoutSecret));
      expect(missing.ok ? undefined : missing.error.reason).toBe('MALFORMED');
    }),
  );

  it.effect('#1157 Comgate push test flag mismatch is rejected', () =>
    Effect.gen(function* testFlagMismatch() {
      const testPushToLive = yield* verify(notification(jsonPush({ test: 'true' })));
      expect(testPushToLive.ok ? undefined : testPushToLive.error.reason).toBe('ENVIRONMENT_MISMATCH');

      const livePushToSandbox = yield* verify(
        notification(jsonPush(), Option.some('application/json'), 'SANDBOX'),
        targetIn('SANDBOX'),
      );
      expect(livePushToSandbox.ok ? undefined : livePushToSandbox.error.reason).toBe('ENVIRONMENT_MISMATCH');

      const addressedToOtherEnvironment = yield* verify(
        notification(jsonPush({ test: 'true' }), Option.some('application/json'), 'SANDBOX'),
        targetIn('LIVE'),
      );
      expect(addressedToOtherEnvironment.ok ? undefined : addressedToOtherEnvironment.error.reason).toBe(
        'ENVIRONMENT_MISMATCH',
      );

      const sandbox = yield* verify(
        notification(jsonPush({ test: 'true' }), Option.some('application/json'), 'SANDBOX'),
        targetIn('SANDBOX'),
      );
      expect(sandbox.ok).toBe(true);
    }),
  );

  it.effect('#1157 Pushed status differing from lookup is recorded, lookup wins', () =>
    Effect.gen(function* pushedDiffers() {
      const result = yield* verify(notification(jsonPush({ refId: orderReference, status: 'PAID' })));
      expect(result.ok).toBe(true);
      const trigger = result.ok ? result.value : undefined;
      expect(trigger?.authenticity).toBe('SHARED_SECRET_VERIFIED');
      expect(trigger?.claimedStatus).toEqual(Option.some('PAID'));
      expect(trigger?.actionable).toBe(true);
      expect(trigger?.signedObject).toEqual(Option.none());
      expect(trigger?.providerRefs).toEqual([{ _tag: 'COMGATE_TRANSACTION', transId: 'AB12-EF34-IJ56' }]);
      expect(trigger?.deliveryIdentity).toBe('comgate:AB12-EF34-IJ56:PAID');
      expect(JSON.stringify(trigger)).not.toContain('gx4q8OV3TJt6noJnfhjqJKyX3Z6Ych0y');
      // #1155: no byte of the body (which carries the shop secret) is handed to the capture for storage.
      expect(trigger?.retainedBody).toEqual(new Uint8Array(0));

      // The lookup that follows says CANCELLED: the push is not rejected, the difference is recorded,
      // and the evidence comes only from the lookup.
      const transId = Schema.decodeUnknownSync(ComgateTransIdSchema)('AB12-EF34-IJ56');
      const answer = decodeComgateStatusBody(
        JSON.stringify({
          ...fixtureJson('status-paid.json'),
          refId: orderReference,
          status: 'CANCELLED',
          transId: 'AB12-EF34-IJ56',
        }),
      );
      const binding = { merchantId: '123456', test: false };
      const comparison = compareComgatePushedStatus({
        claimedStatus: trigger?.claimedStatus ?? Option.none(),
        lookupStatus: comgateVerifiedStatus({ answer, binding, transId }),
      });
      expect(comparisonLabel(comparison)).toBe('DIFFERS:CANCELLED:PAID');

      const findings = yield* mapComgateStatus({
        answer,
        binding,
        expected: { _tag: 'COLLECT', amount: { amountMinor: 10_000, currency: 'CZK' }, operationId },
        observedAt: verifiedAt,
        transId,
      });
      expect(findings[0]?.finding).toBe('NOT_EFFECTED');

      expect(
        comparisonLabel(
          compareComgatePushedStatus({ claimedStatus: Option.some('PAID'), lookupStatus: Option.some('PAID') }),
        ),
      ).toBe('AGREES:PAID');
      expect(
        comparisonLabel(
          compareComgatePushedStatus({ claimedStatus: Option.some('PAID'), lookupStatus: Option.none() }),
        ),
      ).toBe('UNCONFIRMED:PAID');
    }),
  );

  it.effect('#1157 Content type with parameters and urlencoded pushes are accepted', () =>
    Effect.gen(function* contentTypes() {
      const charset = yield* verify(notification(jsonPush(), Option.some('Application/JSON; charset=UTF-8')));
      expect(charset.ok).toBe(true);
      const form = yield* verify(
        notification(fixtureText('push.txt'), Option.some('application/x-www-form-urlencoded; charset=utf-8')),
      );
      expect(form.ok).toBe(true);
      expect(form.ok ? form.value.claimedStatus : Option.none()).toEqual(Option.some('PAID'));

      for (const [body, contentType] of [
        [jsonPush(), Option.some('text/plain')],
        [jsonPush(), Option.none()],
        [fixtureText('push.txt'), Option.some('application/json')],
        [`${fixtureText('push.txt')}&status=CANCELLED`, Option.some('application/x-www-form-urlencoded')],
        ['{', Option.some('application/json')],
      ] as const) {
        const result = yield* verify(notification(body, contentType));
        expect(result.ok ? undefined : result.error.reason).toBe('MALFORMED');
      }
    }),
  );

  it.effect('#1156 Push for another merchant is rejected', () =>
    Effect.gen(function* otherMerchant() {
      const result = yield* verify(notification(jsonPush({ merchant: '654321' })));
      expect(result.ok ? undefined : result.error.reason).toBe('MERCHANT_MISMATCH');
      const numeric = yield* verify(notification(jsonPush({ merchant: 123_456 })));
      expect(numeric.ok).toBe(true);
    }),
  );
});
