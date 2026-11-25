import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationRequestIdSchema } from '../../shared/communication-intake.ts';
import type { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import {
  FIXTURE_APPROVER_ROLE,
  FIXTURE_ORIGINAL_ROLE,
  FIXTURE_SECONDARY_ROLE,
  fixtureSlot,
  fixtureType,
} from '../unit/support/catalog-fixtures.ts';
import { privacyAllowed, privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { binding, unusable } from '../unit/support/recipient-fixtures.ts';
import { handoffDouble, communicationRequest } from '../support/intake-fixtures.ts';
import { decided, intakeWorld } from '../support/intake-world.ts';
import { kindOf, stepWith, stopsOf } from '../support/recovery-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';

/**
 * [#1395 BR-07 AC-05, #1396 BR-09 AC-05, #1393 POL-05] An approved indivisible audience is judged at the LAST stoppable handoff
 * over the WHOLE audience, never over the one member a worker happens to process: nothing of the group leaves unless every
 * member is ready, whatever order the Core worker delivers the members in. The shipped catalog approves no indivisible type, so
 * every type here is a labelled test registration; nothing proves a production type.
 */
const GROUP_RULE = { approvalRuleKey: 'fixture.rule.indivisible', mode: 'INDIVISIBLE' } as const;
const HELD = { category: 'AUDIENCE_GROUP_INCOMPLETE', cause: 'AUDIENCE_GROUP_INCOMPLETE', proven: true } as const;

/** Three single-recipient slots (a, b, c) in one required audience that is, or is not, indivisible. */
const threeSlotType = (indivisible: boolean) =>
  fixtureType({
    audience: indivisible ? { ...GROUP_RULE, slotKeys: ['primary', 'secondary', 'third'] } : { mode: 'INDIVIDUAL' },
    requiredness: 'REQUIRED',
    result: {
      kind: 'MESSAGE_INTENTS',
      slots: [
        fixtureSlot('primary', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE'),
        fixtureSlot('secondary', FIXTURE_SECONDARY_ROLE, 'EXACTLY_ONE'),
        fixtureSlot('third', FIXTURE_APPROVER_ROLE, 'EXACTLY_ONE'),
      ],
    },
  });

/** One single-recipient slot and one slot with EACH of its (two) matching approvers, all in one indivisible group. */
const approverGroupType = () =>
  fixtureType({
    audience: { ...GROUP_RULE, slotKeys: ['primary', 'approvers'] },
    requiredness: 'REQUIRED',
    result: {
      kind: 'MESSAGE_INTENTS',
      slots: [
        fixtureSlot('primary', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE'),
        fixtureSlot('approvers', FIXTURE_APPROVER_ROLE, 'EACH_MATCHING'),
      ],
    },
  });

const setup = (type: ReturnType<typeof fixtureType>, recipients: readonly string[]) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, { recipients, types: [type] })));

type World = Effect.Success<ReturnType<typeof setup>>;

/** One request whose original recipients fill the given roles (`[role, recipientId]`), decided through the public handler. */
const decideAudience = Effect.fn('AudienceGroupTest.decide')(function* decideRoles(
  world: World,
  roles: readonly (readonly [string, string])[],
) {
  const request = communicationRequest({
    bindings: roles.map(([role, id]) => binding(role, id)),
    tenantId: world.tenantId,
  });
  const result = decided(yield* world.runner.submit(world.tenantId, request));
  return {
    intents: result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents : [],
    requestId: CommunicationRequestIdSchema.make(result.requestId),
  };
});

const intentOf = (
  intents: readonly { readonly intentId: typeof MessageIntentIdSchema.Type; readonly slotKey: string }[],
  slotKey: string,
  index = 0,
) => {
  const found = intents.filter((intent) => intent.slotKey === slotKey)[index];
  return found === undefined ? Effect.die(`no intent decided for slot ${slotKey}`) : Effect.succeed(found.intentId);
};

const THREE = [
  [FIXTURE_ORIGINAL_ROLE, 'a'],
  [FIXTURE_SECONDARY_ROLE, 'b'],
  [FIXTURE_APPROVER_ROLE, 'c'],
] as const;

describe('the last stoppable handoff judges an indivisible audience as a whole (T2-01)', () => {
  it.live('a complete group hands every member off, in any delivery order', () =>
    Effect.gen(function* completeGroup() {
      const world = yield* setup(threeSlotType(true), ['a', 'b', 'c']);
      const handoff = handoffDouble();
      const { intents } = yield* decideAudience(world, THREE);
      expect(intents).toHaveLength(3);
      for (const slot of ['third', 'primary', 'secondary']) {
        expect((yield* stepWith(world, handoff, yield* intentOf(intents, slot))).kind).toBe('HANDED_OFF');
      }
      expect(handoff.calls).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'two of three members are ready and the third became ineligible: NOTHING leaves, each ready member stops as an incomplete group',
    () =>
      Effect.gen(function* partialAudience() {
        const world = yield* setup(threeSlotType(true), ['a', 'b', 'c']);
        const handoff = handoffDouble();
        const { intents } = yield* decideAudience(world, THREE);
        // between the decision and the last stoppable handoff the third recipient's contact ended
        world.recipientAuthority.answers.set('contact-c', unusable('PERMISSION_ABSENT'));
        for (const slot of ['primary', 'secondary']) {
          const intentId = yield* intentOf(intents, slot);
          expect(yield* stepWith(world, handoff, intentId)).toMatchObject({ kind: 'STOPPED', reasons: [HELD] });
          expect(yield* stopsOf(world, intentId)).toHaveLength(1);
        }
        // the ineligible member stops under its OWN reason, never as the group
        expect(yield* stepWith(world, handoff, yield* intentOf(intents, 'third'))).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'RECIPIENT_INVALID', proven: true }],
        });
        expect(handoff.calls).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('a member that already left stays as it happened; the member that cannot complete the group is held', () =>
    Effect.gen(function* alreadyHandedOff() {
      const world = yield* setup(threeSlotType(true), ['a', 'b', 'c']);
      const handoff = handoffDouble();
      const { intents } = yield* decideAudience(world, THREE);
      // the first worker ran while the group was still complete
      expect((yield* stepWith(world, handoff, yield* intentOf(intents, 'primary'))).kind).toBe('HANDED_OFF');
      world.privacy.answers.set('c', privacyNotAllowed());
      expect(yield* stepWith(world, handoff, yield* intentOf(intents, 'secondary'))).toMatchObject({
        kind: 'STOPPED',
        reasons: [HELD],
      });
      // nothing sends the accepted member again and nothing rewrites what happened to it
      expect(kindOf(yield* stepWith(world, handoff, yield* intentOf(intents, 'primary')))).toBe(
        'SKIPPED:ALREADY_FINISHED',
      );
      expect(handoff.calls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'a sibling that was stopped for good keeps the group incomplete even when its own gates would pass again',
    () =>
      Effect.gen(function* siblingStoppedForGood() {
        const world = yield* setup(threeSlotType(true), ['a', 'b', 'c']);
        const handoff = handoffDouble();
        const { intents } = yield* decideAudience(world, THREE);
        world.privacy.answers.set('c', privacyNotAllowed());
        expect(yield* stepWith(world, handoff, yield* intentOf(intents, 'third'))).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'PRIVACY_NOT_ALLOWED', proven: true }],
        });
        // the proven stop is final: a later ALLOWED does not reopen the sibling, so the group can never complete
        world.privacy.answers.set('c', privacyAllowed);
        expect(yield* stepWith(world, handoff, yield* intentOf(intents, 'primary'))).toMatchObject({
          kind: 'STOPPED',
          reasons: [HELD],
        });
        expect(handoff.calls).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'EACH_MATCHING in an indivisible group: one approver that became ineligible holds the single-recipient member and the other approver',
    () =>
      Effect.gen(function* eachMatching() {
        const world = yield* setup(approverGroupType(), ['a', 'b1', 'b2']);
        const handoff = handoffDouble();
        const { intents } = yield* decideAudience(world, [
          [FIXTURE_ORIGINAL_ROLE, 'a'],
          [FIXTURE_APPROVER_ROLE, 'b1'],
          [FIXTURE_APPROVER_ROLE, 'b2'],
        ]);
        expect(intents).toHaveLength(3);
        world.recipientAuthority.answers.set('contact-b2', unusable('PERMISSION_ABSENT'));
        expect(yield* stepWith(world, handoff, yield* intentOf(intents, 'primary'))).toMatchObject({
          kind: 'STOPPED',
          reasons: [HELD],
        });
        expect(yield* stepWith(world, handoff, yield* intentOf(intents, 'approvers', 0))).toMatchObject({
          kind: 'STOPPED',
          reasons: [HELD],
        });
        expect(handoff.calls).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'the same facts in the default INDIVIDUAL audience stay partial: nothing is atomic unless it is approved',
    () =>
      Effect.gen(function* individualIsNotAtomic() {
        const world = yield* setup(threeSlotType(false), ['a', 'b', 'c']);
        const handoff = handoffDouble();
        const { intents } = yield* decideAudience(world, THREE);
        world.recipientAuthority.answers.set('contact-c', unusable('PERMISSION_ABSENT'));
        expect((yield* stepWith(world, handoff, yield* intentOf(intents, 'primary'))).kind).toBe('HANDED_OFF');
        expect((yield* stepWith(world, handoff, yield* intentOf(intents, 'secondary'))).kind).toBe('HANDED_OFF');
        expect((yield* stepWith(world, handoff, yield* intentOf(intents, 'third'))).kind).toBe('STOPPED');
        expect(handoff.calls).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
