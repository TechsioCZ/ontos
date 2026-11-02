import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  OutboxDeadDeliveryCommandError,
  decodeOutboxDeadDeliveryListArguments,
  decodeOutboxDeadDeliveryResolutionArguments,
} from '../outbox-dead-delivery.mts';
import type { OutboxDeadDeliveryResolutionFlags } from '../outbox-dead-delivery.mts';

const valid: OutboxDeadDeliveryResolutionFlags = {
  messageId: '6f1c2a40-0d4b-4c6e-9a51-3b2f0e7d8c91',
  operator: 'ops@example.test',
  reason: 'Order reconciled with the buyer by phone; approval was revised after commit.',
  tenantId: '0b8e7f52-41f6-4f1d-8c2e-6a5d9b3c7e10',
  workerKey: 'commerce.order.finalize-order-work',
};

const rejects = (flags: OutboxDeadDeliveryResolutionFlags) =>
  decodeOutboxDeadDeliveryResolutionArguments(flags).pipe(
    Effect.flip,
    Effect.map((error) => Schema.is(OutboxDeadDeliveryCommandError)(error)),
  );

describe('outbox dead-delivery operator arguments', () => {
  it.effect('accepts one exact delivery with a recorded operator and reason, trimming both', () =>
    Effect.gen(function* acceptsExactDelivery() {
      const decoded = yield* decodeOutboxDeadDeliveryResolutionArguments({
        ...valid,
        operator: `  ${valid.operator} `,
        reason: ` ${valid.reason}  `,
      });
      expect(decoded).toEqual(valid);
    }),
  );

  it.effect('rejects identifiers that do not name one exact delivery', () =>
    Effect.gen(function* rejectsIdentifiers() {
      for (const invalid of [
        { ...valid, tenantId: 'tenant-1' },
        { ...valid, messageId: valid.messageId.toUpperCase() },
        { ...valid, messageId: `${valid.messageId} ` },
        { ...valid, workerKey: 'commerce' },
        { ...valid, workerKey: 'commerce.order.' },
        { ...valid, workerKey: 'Commerce.order.finalize' },
        { ...valid, workerKey: 'commerce.order.finalize_order' },
      ]) {
        expect(yield* rejects(invalid)).toBe(true);
      }
    }),
  );

  it.effect('requires a single-line operator and reason within the recorded bounds', () =>
    Effect.gen(function* rejectsEvidence() {
      for (const invalid of [
        { ...valid, operator: '   ' },
        { ...valid, reason: '' },
        { ...valid, reason: 'line one\nline two' },
        { ...valid, operator: 'o'.repeat(201) },
        { ...valid, reason: 'r'.repeat(2001) },
      ]) {
        expect(yield* rejects(invalid)).toBe(true);
      }
      expect(
        (yield* decodeOutboxDeadDeliveryResolutionArguments({ ...valid, reason: 'r'.repeat(2000) })).reason,
      ).toHaveLength(2000);
    }),
  );

  it.effect('bounds the list filter', () =>
    Effect.gen(function* boundsList() {
      expect(yield* decodeOutboxDeadDeliveryListArguments({ limit: 100 })).toEqual({ limit: 100 });
      expect(
        yield* decodeOutboxDeadDeliveryListArguments({
          limit: 1,
          tenantId: valid.tenantId,
          trackedRevision: 'a'.repeat(64),
        }),
      ).toEqual({ limit: 1, tenantId: valid.tenantId, trackedRevision: 'a'.repeat(64) });
      for (const invalid of [
        { limit: 0 },
        { limit: 501 },
        { limit: 1.5 },
        { limit: 10, tenantId: 'tenant' },
        { limit: 10, trackedRevision: 'A'.repeat(64) },
      ]) {
        const failure = yield* decodeOutboxDeadDeliveryListArguments(invalid).pipe(Effect.flip);
        expect(Schema.is(OutboxDeadDeliveryCommandError)(failure)).toBe(true);
      }
    }),
  );
});
