import { Effect, Result } from 'effect';
import { assert, it } from 'effect-rstest';

import { EngagementProfileConflict } from '../../shared/domain/engagement-profile.ts';
import { handleAttachEngagement } from '../../src/actions/attach-engagement-handler.ts';

it.effect(
  'engagement creation runs only after successful validation and preserves the result',
  () =>
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
);

it.effect(
  'engagement validation failure retains its typed error and prevents persistence',
  () =>
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
);
