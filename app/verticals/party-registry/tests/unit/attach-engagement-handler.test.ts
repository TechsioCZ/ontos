import assert from 'node:assert/strict';
import test from 'node:test';

import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { Effect, Result } from 'effect';

import { EngagementProfileConflict } from '../../shared/domain/engagement-profile.ts';
import { handleAttachEngagement } from '../../src/actions/attach-engagement-handler.ts';

test('engagement creation runs only after successful validation and preserves the result', () =>
  runEffectTestPromise(
    Effect.gen(function* createsAfterValidation() {
      const calls: string[] = [];
      const payload = { partyId: 'party' };
      const profile = { profileId: 'profile' };
      const result = yield* handleAttachEngagement(payload, {
        services: {
          validate: (input) =>
            Effect.sync(() => {
              assert.equal(input, payload);
              calls.push('validate');
            }),
          create: (input) =>
            Effect.sync(() => {
              assert.equal(input, payload);
              calls.push('create');
              return profile;
            }),
        },
      });
      assert.equal(result, profile);
      assert.deepEqual(calls, ['validate', 'create']);
    })
  ));

test('engagement validation failure retains its typed error and prevents persistence', () =>
  runEffectTestPromise(
    Effect.gen(function* rejectsBeforeCreation() {
      const conflict = new EngagementProfileConflict({
        code: 'contacts_party_type_mismatch',
        reason: 'The Party has the wrong engagement type',
      });
      let created = false;
      const result = yield* handleAttachEngagement(
        {},
        {
          services: {
            validate: () => Effect.fail(conflict),
            create: () =>
              Effect.sync(() => {
                created = true;
              }),
          },
        }
      ).pipe(Effect.result);
      assert.equal(created, false);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure, conflict);
    })
  ));
