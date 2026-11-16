import { describe, expect, it } from 'effect-rstest';
import { DateTime, Option, Schema } from 'effect';

import {
  idempotencyKeyHashOf,
  ProviderDispatchRecordSchema,
  replayRequestOf,
} from '../../src/integrations/psp/dispatch-ledger.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';

const operationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const correlation = deriveProviderCorrelation(operationId);
const preparedAt = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');
const expiresAt = DateTime.makeUnsafe('2026-11-13T10:00:00.000Z');
const body = new TextEncoder().encode('mode=payment&line_items[0][quantity]=1');
const headers = [
  { name: 'content-type', value: 'application/x-www-form-urlencoded' },
  { name: 'idempotency-key', value: correlation.idempotencyKey },
];

const stripeRecord = (overrides: Partial<typeof ProviderDispatchRecordSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(ProviderDispatchRecordSchema)({
    bindingId: '7d3e9a10-55b2-4f6c-8a1d-2b3c4d5e6f70',
    credentialRevision: 1,
    customerRedirectUrl: Option.none(),
    endpointRef: Option.some('stripe:POST:/v1/checkout/sessions'),
    environment: 'SANDBOX',
    idempotencyKeyHash: Option.some(idempotencyKeyHashOf(correlation.idempotencyKey)),
    materialHash: 'a'.repeat(64),
    notSentReason: Option.none(),
    operationId,
    operationKind: 'COLLECT',
    orderReference: correlation.orderReference,
    paymentId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    preparedAt: Option.some(preparedAt),
    providerAccountRef: `pab_${'1'.repeat(32)}`,
    providerFamily: 'STRIPE',
    providerPaymentRef: Option.none(),
    providerRefundRef: Option.none(),
    refundBaseline: Option.none(),
    replayExpiresAt: Option.some(expiresAt),
    replayStartsAt: Option.some(preparedAt),
    requestBody: Option.some(body),
    requestHash: Option.some('b'.repeat(64)),
    requestHeaders: Option.some(headers),
    respondedAt: Option.none(),
    returnToken: Option.some('AbCdEfGhIjKlMnOpQrStUv'),
    state: 'OUTCOME_UNKNOWN',
    targetOperationId: Option.none(),
    ...overrides,
  });

describe('#1158 Provider dispatch ledger replay request', () => {
  it('#1158 A persisted Stripe dispatch rebuilds the exact request, key and window', () => {
    const replay = replayRequestOf(stripeRecord());

    expect(replay).toEqual(
      Option.some({
        prepared: {
          body,
          endpointRef: 'stripe:POST:/v1/checkout/sessions',
          family: 'STRIPE',
          headers,
          idempotencyKey: Option.some(correlation.idempotencyKey),
          orderReference: correlation.orderReference,
          refundBaseline: Option.none(),
          replayWindowMs: Option.some(86_400_000),
          requestHash: 'b'.repeat(64),
        },
        window: { expiresAt, startsAt: preparedAt },
      }),
    );
  });

  it('#1158 Replay only for the exact same operation key', () => {
    expect(Option.isNone(replayRequestOf(stripeRecord({ idempotencyKeyHash: Option.some('c'.repeat(64)) })))).toBe(
      true,
    );
  });

  it('#1158 Dispatches without a persisted replay request never replay', () => {
    for (const overrides of [
      { replayExpiresAt: Option.none(), replayStartsAt: Option.none() },
      { requestBody: Option.none(), requestHeaders: Option.none() },
      { requestHeaders: Option.none() },
    ]) {
      expect(Option.isNone(replayRequestOf(stripeRecord(overrides)))).toBe(true);
    }
  });
});
