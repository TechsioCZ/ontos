import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { requiredOutcomeOf } from '../../src/domain/catalog/required-outcome.ts';
import { assessRecipients, recipientFactOf } from '../../src/domain/recipient/assess-recipients.ts';
import type { RecipientEvaluationInput } from '../../src/domain/recipient/assess-recipients.ts';
import { recheckBeforeHandoff } from '../../src/domain/recipient/recheck-before-handoff.ts';
import type {
  HandoffCandidate,
  HandoffState,
  HandoffVerdictCase,
} from '../../src/domain/recipient/recheck-before-handoff.ts';
import {
  decideOrThrow,
  FIXTURE_ORIGINAL_ROLE,
  FIXTURE_SECONDARY_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureType,
  requiredTwoSlotTypeWith,
} from './support/catalog-fixtures.ts';
import {
  binding,
  evaluationInput,
  gateDouble,
  intentIdentity,
  NEW_ADDRESS,
  ORIGINAL_ADDRESS,
  unavailable,
  unusable,
  usable,
} from './support/recipient-fixtures.ts';
import type { OwnerAnswer } from './support/recipient-fixtures.ts';
import { outcomeSummary, requiredSummary, verdictSummaries } from './support/summaries.ts';

const indivisible = {
  approvalRuleKey: 'fixture.rule.indivisible',
  mode: 'INDIVISIBLE',
  slotKeys: ['primary', 'secondary'],
};
const groupType = requiredTwoSlotTypeWith({ audience: indivisible });
const individualType = requiredTwoSlotTypeWith();
const forA = binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a');
const forB = binding(FIXTURE_SECONDARY_ROLE, 'recipient-b', 'contact-b');

const decisionFor = (input: RecipientEvaluationInput, answers: Readonly<Record<string, OwnerAnswer>>) =>
  Effect.gen(function* decisionFromAssessments() {
    const evaluated = yield* assessRecipients(input).pipe(Effect.provide(gateDouble(answers).layer));
    return decideOrThrow(
      fixtureRegistry(input.type),
      input.request,
      fixtureContext(evaluated.map(({ assessment }) => recipientFactOf(assessment, input.request, 'ALLOWED'))),
    );
  });

describe('#1395 Rule: an indivisible audience group is an explicit per-type exception (BR-07, AC-05)', () => {
  it.effect(
    'Scenario: an approved indivisible group with one ineligible member prepares no message for the group',
    () =>
      Effect.gen(function* groupWithOneIneligible() {
        const input = evaluationInput(groupType, [forA, forB]);
        const decision = yield* decisionFor(input, {
          'contact-a': usable(),
          'contact-b': unusable('PERMISSION_ABSENT'),
        });

        expect(outcomeSummary(decision)).toMatchObject({
          candidates: [
            { kind: 'Suppressed', reason: 'AUDIENCE_GROUP_INCOMPLETE', resourceId: 'recipient-a' },
            { kind: 'Suppressed', reason: 'RECIPIENT_NOT_ELIGIBLE', resourceId: 'recipient-b' },
          ],
        });
        // The source learns the group obstacle: nothing prepared, so the failure is not partial.
        expect(requiredSummary(requiredOutcomeOf(decision))).toMatchObject({
          kind: 'Failed',
          partial: false,
          preparedSlots: [],
        });
      }),
  );

  it.effect('the same facts in the default individual audience stay partial: nothing is atomic unless approved', () =>
    Effect.gen(function* individualIsNotAtomic() {
      const input = evaluationInput(individualType, [forA, forB]);
      const decision = yield* decisionFor(input, { 'contact-a': usable(), 'contact-b': unusable('PERMISSION_ABSENT') });

      expect(outcomeSummary(decision)).toMatchObject({
        candidates: [
          { kind: 'Eligible', resourceId: 'recipient-a' },
          { kind: 'Suppressed', reason: 'RECIPIENT_NOT_ELIGIBLE', resourceId: 'recipient-b' },
        ],
      });
      expect(requiredSummary(requiredOutcomeOf(decision))).toMatchObject({ kind: 'Failed', partial: true });
    }),
  );

  it.effect('a complete indivisible group prepares every member', () =>
    Effect.gen(function* completeGroup() {
      const decision = yield* decisionFor(evaluationInput(groupType, [forA, forB]), {
        'contact-a': usable(),
        'contact-b': usable('b@example.test'),
      });

      expect(requiredSummary(requiredOutcomeOf(decision))).toMatchObject({ kind: 'Prepared' });
    }),
  );

  it.effect('a required member with no recipient at all holds the whole group back, not just its own slot', () =>
    Effect.gen(function* memberMissing() {
      const decision = yield* decisionFor(evaluationInput(groupType, [forA]), { 'contact-a': usable() });

      expect(outcomeSummary(decision)).toMatchObject({
        candidates: [{ kind: 'Suppressed', reason: 'AUDIENCE_GROUP_INCOMPLETE', resourceId: 'recipient-a' }],
        unresolvedSlots: [{ reason: 'RECIPIENT_AUTHORITY_MISSING', slotKey: 'secondary' }],
      });
    }),
  );

  it.effect('a member keeps its own, more specific stop reason instead of the group reason', () =>
    Effect.gen(function* specificReasonWins() {
      const decision = yield* decisionFor(evaluationInput(groupType, [forA, forB]), {
        'contact-a': unavailable('PERMISSION'),
        'contact-b': usable(),
      });

      expect(outcomeSummary(decision)).toMatchObject({
        candidates: [
          { kind: 'Suppressed', reason: 'RECIPIENT_AUTHORITY_UNAVAILABLE', resourceId: 'recipient-a' },
          { kind: 'Suppressed', reason: 'AUDIENCE_GROUP_INCOMPLETE', resourceId: 'recipient-b' },
        ],
      });
    }),
  );
});

const gateFor = (answers: Readonly<Record<string, OwnerAnswer>>) => gateDouble(answers);

const candidatesOf = (
  input: RecipientEvaluationInput,
  members: readonly (readonly [ReturnType<typeof binding>, string, HandoffState?])[],
): readonly HandoffCandidate[] =>
  members.map(([memberBinding, slotKey, handoff = 'STOPPABLE']) => ({
    binding: memberBinding,
    handoff,
    identity: intentIdentity(input, memberBinding, slotKey),
  }));

const kinds = (verdicts: readonly HandoffVerdictCase[]) => verdictSummaries(verdicts).map(({ kind }) => kind);

describe('#1395 Rule: the original recipient is re-checked before the last stoppable handoff (BR-03, AC-08)', () => {
  const single = fixtureType();

  it.effect(
    'Scenario: contact change race: the profile contact changes before handoff, the original is usable: it proceeds to the original endpoint',
    () =>
      Effect.gen(function* raceOriginalStillUsable() {
        const input = evaluationInput(single, [forA]);
        const gate = gateFor({ 'contact-a': usable(ORIGINAL_ADDRESS), 'contact-new': usable(NEW_ADDRESS) });
        const verdicts = yield* recheckBeforeHandoff(input, candidatesOf(input, [[forA, 'primary']])).pipe(
          Effect.provide(gate.layer),
        );

        expect(verdictSummaries(verdicts)).toEqual([{ address: ORIGINAL_ADDRESS, kind: 'Proceed' }]);
        expect(gate.queries.map(({ contact }) => contact.contactRef.resourceId)).toEqual(['contact-a']);
      }),
  );

  it.effect(
    'AC-02 Scenario: contact change race: the original endpoint ended meanwhile: the message stops, the new address is never used',
    () =>
      Effect.gen(function* raceOriginalEnded() {
        const input = evaluationInput(single, [forA]);
        const gate = gateFor({
          'contact-a': unusable('ORIGINAL_ENDPOINT_UNUSABLE'),
          'contact-new': usable(NEW_ADDRESS),
        });
        const verdicts = yield* recheckBeforeHandoff(input, candidatesOf(input, [[forA, 'primary']])).pipe(
          Effect.provide(gate.layer),
        );

        expect(kinds(verdicts)).toEqual(['Stopped']);
        expect(JSON.stringify(verdicts)).not.toContain(NEW_ADDRESS);
        expect(gate.queries).toHaveLength(1);
      }),
  );

  it.effect('AC-08 an unreachable authority stops the handoff: a stale earlier permission is never a substitute', () =>
    Effect.gen(function* unavailableAtHandoff() {
      const input = evaluationInput(single, [forA]);
      const verdicts = yield* recheckBeforeHandoff(input, candidatesOf(input, [[forA, 'primary']])).pipe(
        Effect.provide(gateFor({ 'contact-a': unavailable('SOURCE_OWNER') }).layer),
      );

      expect(verdictSummaries(verdicts)).toEqual([
        {
          assessment: { authority: 'SOURCE_OWNER', outcome: 'source-unavailable', recipient: 'recipient-a' },
          kind: 'Stopped',
        },
      ]);
    }),
  );

  it.effect(
    'Scenario: a retry that carries a different recipient is stopped: a new address is not a technical retry',
    () =>
      Effect.gen(function* retryWithNewRecipient() {
        const input = evaluationInput(single, [forA]);
        const swapped = binding(FIXTURE_ORIGINAL_ROLE, 'recipient-new', 'contact-new');
        const verdicts = yield* recheckBeforeHandoff(input, [
          { binding: swapped, handoff: 'STOPPABLE', identity: intentIdentity(input, forA, 'primary') },
        ]).pipe(Effect.provide(gateFor({ 'contact-new': usable(NEW_ADDRESS) }).layer));

        expect(verdictSummaries(verdicts)).toEqual([
          {
            assessment: {
              outcome: 'recipient-not-allowed',
              reason: 'RECIPIENT_IDENTITY_CHANGED',
              recipient: 'recipient-new',
            },
            kind: 'Stopped',
          },
        ]);
        expect(JSON.stringify(verdicts)).not.toContain(NEW_ADDRESS);
      }),
  );

  it.effect('an intent of another occurrence, tenant or type is stopped, never re-addressed', () =>
    Effect.gen(function* foreignIntent() {
      const input = evaluationInput(single, [forA]);
      const other = evaluationInput(single, [forA], { occurrenceId: 'fixture-occurrence-9' });
      const gate = gateFor({ 'contact-a': usable() });
      const verdicts = yield* recheckBeforeHandoff(input, [
        { binding: forA, handoff: 'STOPPABLE', identity: intentIdentity(other, forA, 'primary') },
      ]).pipe(Effect.provide(gate.layer));

      expect(verdicts[0]).toMatchObject({
        assessment: { reason: 'RECIPIENT_IDENTITY_CHANGED' },
      });
      expect(gate.queries).toEqual([]);
    }),
  );

  it.effect('an intent for a slot the pinned type does not have is stopped before any owner is asked', () =>
    Effect.gen(function* unknownSlot() {
      const input = evaluationInput(single, [forA]);
      const gate = gateFor({ 'contact-a': usable() });
      const verdicts = yield* recheckBeforeHandoff(input, candidatesOf(input, [[forA, 'removed-slot']])).pipe(
        Effect.provide(gate.layer),
      );

      expect(kinds(verdicts)).toEqual(['Stopped']);
      expect(gate.queries).toEqual([]);
    }),
  );
});

describe('#1395 Rule: an indivisible group at handoff holds together and never undoes a proven effect (BR-07)', () => {
  const groupInput = evaluationInput(groupType, [forA, forB]);

  it.effect('Scenario: one member ineligible at handoff: no stoppable member of the group is handed off', () =>
    Effect.gen(function* groupStoppedAtHandoff() {
      const verdicts = yield* recheckBeforeHandoff(
        groupInput,
        candidatesOf(groupInput, [
          [forA, 'primary'],
          [forB, 'secondary'],
        ]),
      ).pipe(Effect.provide(gateFor({ 'contact-a': usable(), 'contact-b': unusable('OWNER_BINDING_INVALID') }).layer));

      expect(kinds(verdicts)).toEqual(['GroupStopped', 'Stopped']);
      expect(verdicts[0]).toMatchObject({
        evidence: { authorization: 'RECIPIENT_ALLOWED', reason: 'AUDIENCE_GROUP_INCOMPLETE' },
      });
    }),
  );

  it.effect('Scenario: a member already proven handed off is preserved for reconciliation, nothing else proceeds', () =>
    Effect.gen(function* partialGroupKeepsEffect() {
      const gate = gateFor({ 'contact-a': usable(), 'contact-b': unusable('PERMISSION_ABSENT') });
      const verdicts = yield* recheckBeforeHandoff(
        groupInput,
        candidatesOf(groupInput, [
          [forA, 'primary', 'PROVEN_HANDED_OFF'],
          [forB, 'secondary'],
        ]),
      ).pipe(Effect.provide(gate.layer));

      expect(verdictSummaries(verdicts)[0]).toEqual({ kind: 'AlreadyHandedOff', reconciliationRequired: true });
      expect(kinds(verdicts)).toEqual(['AlreadyHandedOff', 'Stopped']);
      // The effect that already happened is not asked about, re-evaluated or rewritten.
      expect(gate.queries.map(({ contact }) => contact.contactRef.resourceId)).toEqual(['contact-b']);
    }),
  );

  it.effect('a handed-off member of a complete group needs no reconciliation, and the rest proceed', () =>
    Effect.gen(function* completeGroupAfterHandoff() {
      const verdicts = yield* recheckBeforeHandoff(
        groupInput,
        candidatesOf(groupInput, [
          [forA, 'primary', 'PROVEN_HANDED_OFF'],
          [forB, 'secondary'],
        ]),
      ).pipe(Effect.provide(gateFor({ 'contact-b': usable('b@example.test') }).layer));

      expect(verdictSummaries(verdicts)).toEqual([
        { kind: 'AlreadyHandedOff', reconciliationRequired: false },
        { address: 'b@example.test', kind: 'Proceed' },
      ]);
    }),
  );

  it.effect('PO 2A: the default individual audience hands off the allowed member and stops only the other', () =>
    Effect.gen(function* individualPartial() {
      const input = evaluationInput(individualType, [forA, forB]);
      const verdicts = yield* recheckBeforeHandoff(
        input,
        candidatesOf(input, [
          [forA, 'primary'],
          [forB, 'secondary'],
        ]),
      ).pipe(Effect.provide(gateFor({ 'contact-a': usable(), 'contact-b': unusable('PERMISSION_ABSENT') }).layer));

      expect(kinds(verdicts)).toEqual(['Proceed', 'Stopped']);
    }),
  );
});
