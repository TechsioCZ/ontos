import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { EngagementProfilePersistenceUnavailable } from '../../shared/domain/engagement-profile.ts';
import { handleEngagementLifecycle } from '../../src/actions/engagement-lifecycle-handler.ts';

const payload = { profileRef: { resourceId: '10000000-0000-4000-8000-000000000001' } };

for (const state of ['active', 'archived'] as const) {
  const handle = handleEngagementLifecycle<typeof payload, string>(state);

  test(`engagement transition to ${state} forwards the reference and returns the persisted value`, () =>
    runEffectTestPromise(
      Effect.gen(function* verifyTransition() {
        const value = yield* handle(payload, {
          services: {
            transition: (profileId) => {
              assert.equal(profileId, payload.profileRef.resourceId);
              return Effect.succeed({ _tag: 'found', value: 'persisted-profile' });
            },
          },
        });
        assert.equal(value, 'persisted-profile');
      }),
    ));

  test(`engagement conflict reports the requested ${state} state`, () =>
    runEffectTestPromise(
      Effect.gen(function* verifyConflict() {
        const reason = yield* handle(payload, {
          services: {
            transition: () => Effect.succeed({ _tag: 'conflict', value: 'existing-profile' }),
          },
        }).pipe(
          Effect.catchTag('EngagementProfileConflict', (error) => Effect.succeed(error.reason)),
        );
        assert.equal(reason, `The engagement profile is already ${state}`);
      }),
    ));

  test(`engagement transition to ${state} retains the missing profile identity`, () =>
    runEffectTestPromise(
      Effect.gen(function* verifyMissing() {
        const profileId = yield* handle(payload, {
          services: { transition: () => Effect.succeed({ _tag: 'not_found' }) },
        }).pipe(
          Effect.catchTag('EngagementProfileNotFound', (error) => Effect.succeed(error.profileId)),
        );
        assert.equal(profileId, payload.profileRef.resourceId);
      }),
    ));

  test(`engagement transition to ${state} preserves the typed persistence failure`, () =>
    runEffectTestPromise(
      Effect.gen(function* verifyPersistenceFailure() {
        const failure = new EngagementProfilePersistenceUnavailable({
          code: 'contacts_engagement_profile_persistence_unavailable',
          reason: 'Storage unavailable',
        });
        const result = yield* handle(payload, {
          services: { transition: () => Effect.fail(failure) },
        }).pipe(
          Effect.catchTag('EngagementProfilePersistenceUnavailable', (error) =>
            Effect.succeed(error),
          ),
        );
        assert.equal(result, failure);
      }),
    ));
}
