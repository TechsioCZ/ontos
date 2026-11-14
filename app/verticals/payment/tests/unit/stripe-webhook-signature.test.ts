import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Redacted, Result, Schema } from 'effect';

import { verifyStripeSignature } from '../../src/integrations/stripe/stripe-webhook-signature.ts';

/**
 * Vectors were generated with `openssl dgst -sha256 -hmac` from the algorithm documented at
 * https://docs.stripe.com/webhooks#verify-manually, not with the implementation under test (#1157).
 */
const fixtureDir = new URL('../fixtures/stripe-signature/', import.meta.url);
const VectorsSchema = Schema.Struct({
  bodyFile: Schema.String,
  secret: Schema.String,
  tamperedBodyV1: Schema.String,
  timestamp: Schema.Number,
  validV1: Schema.String,
  zeroV1: Schema.String,
});
const rawVectors: unknown = JSON.parse(readFileSync(new URL('vectors.json', fixtureDir), 'utf-8'));
const vectors = Schema.decodeUnknownSync(VectorsSchema)(rawVectors);
const rawBody = new Uint8Array(readFileSync(new URL(vectors.bodyFile, fixtureDir)));
const secret = Redacted.make(vectors.secret);
const toleranceSeconds = 300;

const verifiedAtAt = (epochSeconds: number) => DateTime.makeUnsafe(epochSeconds * 1000);

const run = (header: string, body: Uint8Array = rawBody, verifiedAtSeconds: number = vectors.timestamp) =>
  verifyStripeSignature({
    header,
    rawBody: body,
    secret,
    toleranceSeconds,
    verifiedAt: verifiedAtAt(verifiedAtSeconds),
  }).pipe(
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result)
        ? { ok: true as const, value: result.success }
        : { error: result.failure, ok: false as const },
    ),
  );

const accepted = { ok: true, value: { timestamp: vectors.timestamp } };

const header = (...parts: readonly string[]) => parts.join(',');

describe('#1154 Stripe webhook v1 signature verification', () => {
  it.effect('#1157 Valid Stripe signature is accepted', () =>
    Effect.gen(function* validSignature() {
      const outcome = yield* run(header(`t=${vectors.timestamp}`, `v1=${vectors.validV1}`));
      expect(outcome).toEqual(accepted);
    }),
  );

  it.effect('#1157 Tampered body is rejected', () =>
    Effect.gen(function* tamperedBody() {
      const tampered = new TextEncoder().encode(new TextDecoder().decode(rawBody).replace('"czk"', '"eur"'));
      const outcome = yield* run(header(`t=${vectors.timestamp}`, `v1=${vectors.validV1}`), tampered);
      expect(outcome).toMatchObject({
        error: { _tag: 'GatewayNotificationRejected', reason: 'SIGNATURE_INVALID' },
        ok: false,
      });
    }),
  );

  it.effect('#1157 Signature computed over a tampered body is rejected for the original body', () =>
    Effect.gen(function* wrongTamperedSignature() {
      const outcome = yield* run(header(`t=${vectors.timestamp}`, `v1=${vectors.tamperedBodyV1}`));
      expect(outcome).toMatchObject({ error: { reason: 'SIGNATURE_INVALID' }, ok: false });
    }),
  );

  it.effect('#1157 Stale timestamp is rejected', () =>
    Effect.gen(function* staleTimestamp() {
      const outcome = yield* run(
        header(`t=${vectors.timestamp}`, `v1=${vectors.validV1}`),
        rawBody,
        vectors.timestamp + toleranceSeconds + 1,
      );
      expect(outcome).toMatchObject({ error: { reason: 'SIGNATURE_STALE' }, ok: false });
    }),
  );

  it.effect('#1157 Timestamp exactly at the tolerance boundary is accepted', () =>
    Effect.gen(function* boundary() {
      const outcome = yield* run(
        header(`t=${vectors.timestamp}`, `v1=${vectors.validV1}`),
        rawBody,
        vectors.timestamp + toleranceSeconds,
      );
      expect(outcome).toEqual(accepted);
    }),
  );

  it.effect('#1157 Multiple v1 values with one valid signature pass', () =>
    Effect.gen(function* multipleV1() {
      const outcome = yield* run(header(`t=${vectors.timestamp}`, `v1=${vectors.zeroV1}`, `v1=${vectors.validV1}`));
      expect(outcome).toEqual(accepted);
    }),
  );

  it.effect('#1157 v0-only signature fails', () =>
    Effect.gen(function* v0Only() {
      const outcome = yield* run(header(`t=${vectors.timestamp}`, `v0=${vectors.validV1}`));
      expect(outcome).toMatchObject({ error: { reason: 'MALFORMED' }, ok: false });
    }),
  );

  it.effect('#1157 Unknown keys are ignored alongside a valid v1', () =>
    Effect.gen(function* unknownKeys() {
      const outcome = yield* run(
        header(`t=${vectors.timestamp}`, 'x=ignored', `v1=${vectors.validV1}`, `v0=${vectors.zeroV1}`),
      );
      expect(outcome).toEqual(accepted);
    }),
  );

  it.effect('#1157 Malformed header without a timestamp fails', () =>
    Effect.gen(function* missingTimestamp() {
      const outcome = yield* run(`v1=${vectors.validV1}`);
      expect(outcome).toMatchObject({ error: { reason: 'MALFORMED' }, ok: false });
    }),
  );

  it.effect('#1157 Malformed header without a v1 fails', () =>
    Effect.gen(function* missingV1() {
      const outcome = yield* run(`t=${vectors.timestamp}`);
      expect(outcome).toMatchObject({ error: { reason: 'MALFORMED' }, ok: false });
    }),
  );

  it.effect('#1157 Malformed header with a non-hex v1 fails', () =>
    Effect.gen(function* nonHexV1() {
      const outcome = yield* run(header(`t=${vectors.timestamp}`, `v1=${'z'.repeat(64)}`));
      expect(outcome).toMatchObject({ error: { reason: 'MALFORMED' }, ok: false });
    }),
  );

  it.effect('#1157 Malformed header with a non-integer timestamp fails', () =>
    Effect.gen(function* nonIntegerTimestamp() {
      const outcome = yield* run(header('t=12.5', `v1=${vectors.validV1}`));
      expect(outcome).toMatchObject({ error: { reason: 'MALFORMED' }, ok: false });
    }),
  );

  it.effect('#1157 Wrong secret is rejected as an invalid signature', () =>
    Effect.gen(function* wrongSecret() {
      const outcome = yield* verifyStripeSignature({
        header: header(`t=${vectors.timestamp}`, `v1=${vectors.validV1}`),
        rawBody,
        secret: Redacted.make('whsec_c17_other_secret'),
        toleranceSeconds,
        verifiedAt: verifiedAtAt(vectors.timestamp),
      }).pipe(
        Effect.result,
        Effect.map((result) => Result.isFailure(result) && result.failure.reason),
      );
      expect(outcome).toBe('SIGNATURE_INVALID');
    }),
  );
});
