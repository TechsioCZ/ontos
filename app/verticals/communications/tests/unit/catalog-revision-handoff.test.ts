import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { decideMessageHandoffs } from '../../src/domain/privacy/handoff-decision.ts';
import { MessageHandoffDecision } from '../../src/domain/privacy/suppression.ts';
import type { MessageHandoffDecisionCase } from '../../src/domain/privacy/suppression.ts';
import {
  FIXTURE_ORIGINAL_ROLE,
  FIXTURE_SECONDARY_ROLE,
  fixtureSlot,
  fixtureType,
  requiredTwoSlotTypeWith,
} from './support/catalog-fixtures.ts';
import { currentSource, handoffItem, privacyAllowed, privacyGateDouble } from './support/privacy-fixtures.ts';
import { binding, evaluationInput, gateDouble, usable } from './support/recipient-fixtures.ts';
import { feedOfHandoff, feedSummary } from './support/required-feed.ts';

/**
 * [R-D15, #1394 domain review, #1396 BR-14, T3-03] A catalog revision bump never invalidates a decision by itself: the recipient
 * rule that governed the decision is pinned with it, the message stays valid while that rule is still the approved one, and only
 * a change of THAT rule stops it, with its own non-recipient reason. A recipient problem is never claimed for a catalog change.
 */
const forA = binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a');
const forB = binding(FIXTURE_SECONDARY_ROLE, 'recipient-b', 'contact-b');
const indivisible = {
  approvalRuleKey: 'fixture.rule.indivisible',
  mode: 'INDIVISIBLE',
  slotKeys: ['primary', 'secondary'],
} as const;

/** The messages decided under `decided`, rechecked now against the approved type `current`. */
const recheck = (
  decided: ReturnType<typeof fixtureType>,
  current: ReturnType<typeof fixtureType>,
  recipients: readonly (readonly [typeof forA, string])[] = [[forA, 'primary']],
) => {
  const decidedInput = evaluationInput(
    decided,
    recipients.map(([recipient]) => recipient),
  );
  const currentInput = evaluationInput(
    current,
    recipients.map(([recipient]) => recipient),
  );
  const recipientGate = gateDouble({ 'contact-a': usable(), 'contact-b': usable('b@example.test') });
  const privacyGate = privacyGateDouble({ 'recipient-a': privacyAllowed, 'recipient-b': privacyAllowed });
  return decideMessageHandoffs(
    { recipient: currentInput, source: currentSource },
    recipients.map(([recipient, slotKey]) => handoffItem(decidedInput, recipient, slotKey)),
  ).pipe(Effect.provide(Layer.mergeAll(recipientGate.layer, privacyGate.layer)));
};

/** What became of one message, as a plain word. */
const kindOf = (decision: MessageHandoffDecisionCase) =>
  MessageHandoffDecision.$match(decision, {
    AlreadyHandedOff: () => 'AlreadyHandedOff',
    Proceed: () => 'Proceed',
    ReconciliationRequired: () => 'ReconciliationRequired',
    Suppressed: () => 'Suppressed',
  });

/** The closed reasons a message stopped under, nothing when it did not stop. */
const reasonsOf = (decision: MessageHandoffDecisionCase | undefined) =>
  decision !== undefined && MessageHandoffDecision.$is('Suppressed')(decision)
    ? decision.reasons.map(({ category, cause, proven }) => ({ category, cause, proven }))
    : [];

describe('a new revision of the type keeps a decided message valid while its recipient rule is unchanged (R-D15)', () => {
  it.effect('a wording-only bump of a REQUIRED type leaves its pending message proceeding', () =>
    Effect.gen(function* wordingOnly() {
      const decided = fixtureType({ requiredness: 'REQUIRED' });
      const reworded = fixtureType({ meaning: 'A reworded fictional meaning.', requiredness: 'REQUIRED', revision: 2 });
      const [decision] = yield* recheck(decided, reworded);

      expect(decision === undefined ? undefined : kindOf(decision)).toBe('Proceed');
    }),
  );

  it.effect(
    'an unchanged group rule keeps the members of an indivisible audience together under a later revision',
    () =>
      Effect.gen(function* sameGroup() {
        const decided = requiredTwoSlotTypeWith({ audience: indivisible });
        const next = requiredTwoSlotTypeWith({ audience: indivisible, revision: 2 });
        const decisions = yield* recheck(decided, next, [
          [forA, 'primary'],
          [forB, 'secondary'],
        ]);

        expect(decisions.map(kindOf)).toEqual(['Proceed', 'Proceed']);
      }),
  );
});

describe('a change of the recipient rule itself stops the decided message with its own non-recipient reason (R-D15)', () => {
  it.effect.each([
    ['its audience slot names another recipient role', fixtureSlot('primary', FIXTURE_SECONDARY_ROLE, 'EXACTLY_ONE')],
    ['its audience slot is now EACH_MATCHING', fixtureSlot('primary', FIXTURE_ORIGINAL_ROLE, 'EACH_MATCHING')],
  ] as const)('%s', ([, slot]) =>
    Effect.gen(function* slotChanged() {
      const changed = fixtureType({ result: { kind: 'MESSAGE_INTENTS', slots: [slot] }, revision: 2 });
      const [decision] = yield* recheck(fixtureType(), changed);

      // never an invalid recipient: no owner is asked and the stop is a catalog fact
      expect(reasonsOf(decision)).toEqual([
        { category: 'TYPE_RULE_CHANGED', cause: 'RECIPIENT_RULE_CHANGED', proven: true },
      ]);
    }),
  );

  it.effect('a removed slot, and an audience that is now an approved group, change the rule too', () =>
    Effect.gen(function* audienceChanged() {
      const removed = fixtureType({
        result: { kind: 'MESSAGE_INTENTS', slots: [fixtureSlot('other', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE')] },
        revision: 2,
      });
      const [gone] = yield* recheck(fixtureType(), removed);
      expect(reasonsOf(gone)[0]?.category).toBe('TYPE_RULE_CHANGED');

      const individual = requiredTwoSlotTypeWith();
      const grouped = requiredTwoSlotTypeWith({ audience: indivisible, revision: 2 });
      const decisions = yield* recheck(individual, grouped, [
        [forA, 'primary'],
        [forB, 'secondary'],
      ]);
      expect(decisions.map((decision) => reasonsOf(decision)[0]?.category)).toEqual([
        'TYPE_RULE_CHANGED',
        'TYPE_RULE_CHANGED',
      ]);
    }),
  );

  it.effect(
    'only the member whose slot changed is stopped; the other slot of an individual audience keeps proceeding',
    () =>
      Effect.gen(function* oneSlotChanged() {
        const decided = requiredTwoSlotTypeWith();
        const changed = requiredTwoSlotTypeWith({
          result: {
            kind: 'MESSAGE_INTENTS',
            slots: [
              fixtureSlot('primary', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE'),
              fixtureSlot('secondary', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE'),
            ],
          },
          revision: 2,
        });
        const decisions = yield* recheck(decided, changed, [
          [forA, 'primary'],
          [forB, 'secondary'],
        ]);

        expect(decisions.map(kindOf)).toEqual(['Proceed', 'Suppressed']);
      }),
  );

  it.effect('the source learns it as a required-message failure of the rule, and a reworded type is not one', () =>
    Effect.gen(function* feedOfRuleChange() {
      const changed = fixtureType({
        requiredness: 'REQUIRED',
        result: {
          kind: 'MESSAGE_INTENTS',
          slots: [fixtureSlot('primary', FIXTURE_SECONDARY_ROLE, 'EXACTLY_ONE')],
        },
        revision: 2,
      });
      const decisions = yield* recheck(fixtureType({ requiredness: 'REQUIRED' }), changed);

      expect(feedSummary(feedOfHandoff('REQUIRED', decisions))).toMatchObject({
        attentions: ['FAILURE'],
        reasons: ['TYPE_RULE_CHANGED'],
        requiredOutcome: 'FAILED',
        sourceImpact: 'SOURCE_OWNER_DECIDES',
      });
    }),
  );
});
