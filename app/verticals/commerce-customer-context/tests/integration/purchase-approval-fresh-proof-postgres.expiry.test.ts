import {
  PurchaseApprovalFinalBindingSchema,
  PurchasingApprovalRejected,
  TrustedRevalidatePurchaseApprovalInputSchema,
} from '../../shared/domain/purchasing-approval.ts';
import { randomUUID } from 'node:crypto';
import { DateTime, Deferred, Effect, Fiber, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import {
  extendedObservationSeconds,
  holdGenuineRequest,
  scenario,
  services,
  waitForExactBlock,
} from './purchase-approval-fresh-proof-postgres.fixture.ts';

for (const state of ['OLD_CLOCK', 'CURRENT'] as const) {
  it.live(
    state === 'OLD_CLOCK'
      ? 'OLD clock accepts an exact genuine P1 component replay after forced expiry with fresh incoming evidence'
      : 'CURRENT clock refuses an exact genuine P1 component replay after forced expiry with fresh incoming evidence',
    () =>
      Effect.scoped(
        Effect.gen(function* directOriginalFrameClockDiscriminator() {
          const test = yield* scenario(state);
          const intent = randomUUID();
          const first = yield* test.check(intent);
          const original = yield* test.readProofs();
          const [record] = original;
          assert.isOk(record !== undefined && record.actionInvocationId !== null && record.actorPrincipalId !== null);
          expect(record.actionInvocationId).toBe(first.revalidation.evidence.actionInvocationId);
          expect(record.actorPrincipalId).toBe(test.owner.principal.principalId);
          // Authorized durable replay of this exact P1, not an invented or unrelated invocation.
          test.setObservationWindow(extendedObservationSeconds);
          const frame = yield* test.prepareReplayFrame(intent);
          const encoded = yield* Schema.encodeEffect(TrustedRevalidatePurchaseApprovalInputSchema)(frame);
          expect(encoded.idempotencyKey).toBe(intent);
          expect(encoded.finalBinding).toEqual(
            yield* Schema.encodeEffect(PurchaseApprovalFinalBindingSchema)(test.binding),
          );
          expect(
            DateTime.isGreaterThan(frame.validUntil, DateTime.add(first.revalidation.validUntil, { seconds: 5 })),
          ).toBe(true);
          const held = yield* holdGenuineRequest(test);
          const replay = yield* test
            .directReplay(frame, record.actionInvocationId)
            .pipe(Effect.result, Effect.forkScoped);
          yield* waitForExactBlock(test, held.blocker, 'DIRECT', first.revalidation.validUntil);
          yield* test.expire(first.revalidation.validUntil);
          yield* Deferred.succeed(held.release, true);
          yield* Fiber.join(held.holder);
          expect(DateTime.isLessThan((yield* test.owner.nativeNow()).at, frame.validUntil)).toBe(true);
          const result = yield* Fiber.join(replay);
          if (state === 'OLD_CLOCK') {
            expect(Result.isSuccess(result)).toBe(true);
            if (Result.isSuccess(result)) {
              expect(result.success.revalidation.revalidationRef).toEqual(first.revalidation.revalidationRef);
              expect(result.success.revalidation.checkedAt).toEqual(first.revalidation.checkedAt);
              expect(result.success.revalidation.validUntil).toEqual(first.revalidation.validUntil);
            }
          } else {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(result.failure);
              expect(failure.code).toBe('OWNER_CONFIRMATION_EXPIRED');
            }
          }
          expect(yield* test.readProofs()).toEqual(original);
        }),
      ).pipe(Effect.provide(services)),
  );
}

it.live(
  'rejects fresh proof after actual buyer revocation and retains committed P1 history',
  () =>
    Effect.scoped(
      Effect.gen(function* revokedBuyerBetweenProofs() {
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        yield* test.expire(first.revalidation.validUntil);
        const revoked = yield* test.chain.revokeBuyer();
        expect(revoked.outcome).toBe('REVOKED');
        expect(revoked.grant.state).toBe('REVOKED');
        // Revocation is now one owner commit. No worker settlement or pending second permission store exists.
        const entries = test.authorityEntries();
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        expect(failure.code).toBe('BUYER_PERMISSION_DENIED');
        // Released preparation rejects the now-denied local buyer before asking the final owner.
        expect(test.authorityEntries()).toBe(entries);
        expect(yield* test.readProofs()).toEqual(original);
        expect(yield* test.readRequest()).toEqual(request);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

for (const change of ['POLICY', 'PROFILE'] as const) {
  it.live(`rejects fresh proof after actual ${change} change without rewriting P1 or request history`, () =>
    Effect.scoped(
      Effect.gen(function* changedOwnerStateBetweenProofs() {
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        yield* test.expire(first.revalidation.validUntil);
        if (change === 'POLICY') {
          const changed = yield* test.chain.changeLimit();
          expect(changed.status).toBe('CHANGED');
          expect(changed.previousPolicy?.revision).toBe(1);
          expect(changed.currentPolicy?.revision).toBe(2);
        } else {
          const suspended = yield* test.chain.suspendProfile();
          expect(suspended.outcome).toBe('PROFILE_SUSPENDED');
          expect(suspended.state).toBe('SUSPENDED');
          expect(suspended.revision).toBe(test.chain.profile.revision + 1);
        }
        const entries = test.authorityEntries();
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        // Real owner revisions changed; the Current source check refuses stale proposal evidence
        // before the TEST final authority can approve a binding. No denial flag stands in for mutation.
        expect(failure.code).toBe('CURRENT_STATE_INDETERMINATE');
        expect(failure.reason).toBe('Current owner source revisions no longer match the captured approval');
        expect(test.authorityEntries()).toBe(entries);
        expect(yield* test.readProofs()).toEqual(original);
        expect(yield* test.readRequest()).toEqual(request);
      }),
    ).pipe(Effect.provide(services)),
  );
}
