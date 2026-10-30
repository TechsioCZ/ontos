import { createHash } from 'node:crypto';
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { verifyDsrLegacyPreimage } from '../support/dsr-legacy-artifacts.ts';

const source = new TextEncoder().encode('immutable historical owner source\n');
const pin = createHash('sha256').update(source).digest('hex');

describe('pre-1271 owner source provenance', () => {
  it.effect('accepts an exact fixture, SHA-256 pin and Git blob', () =>
    Effect.gen(function* exactPreimage() {
      expect(Result.isSuccess(yield* Effect.result(verifyDsrLegacyPreimage(source, pin, source)))).toBe(true);
    }),
  );
  it.effect('accepts a pinned fixture when a shallow checkout has no historical blob', () =>
    Effect.gen(function* shallowCheckout() {
      expect(Result.isSuccess(yield* Effect.result(verifyDsrLegacyPreimage(source, pin)))).toBe(true);
    }),
  );
  it.effect('rejects a tampered fixture before building an owner', () =>
    Effect.gen(function* tamperedFixture() {
      const tampered = new TextEncoder().encode('modified historical owner source\n');
      expect(Result.isFailure(yield* Effect.result(verifyDsrLegacyPreimage(tampered, pin, source)))).toBe(true);
    }),
  );
  it.effect('rejects a wrong manifest pin', () =>
    Effect.gen(function* wrongPin() {
      expect(Result.isFailure(yield* Effect.result(verifyDsrLegacyPreimage(source, '0'.repeat(64), source)))).toBe(
        true,
      );
    }),
  );
  it.effect('rejects a history mismatch even when the fixture matches its manifest pin', () =>
    Effect.gen(function* historyMismatch() {
      const differentBlob = new TextEncoder().encode('different Git blob\n');
      const result = yield* Effect.result(verifyDsrLegacyPreimage(source, pin, differentBlob));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toBe('Historical fixture differs from the pinned Git blob');
      }
    }),
  );
});
