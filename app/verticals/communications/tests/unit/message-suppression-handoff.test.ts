import { Array as EffectArray, DateTime, Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import {
  admitRecoveryAfterStop,
  decideMessageHandoffs,
  requiredHandoffOutcomeOf,
} from '../../src/domain/privacy/handoff-decision.ts';
import type { MessageHandoffInput, MessageHandoffItem } from '../../src/domain/privacy/handoff-decision.ts';
import { HandoffFact, MessageHandoffDecision, ProviderFact } from '../../src/domain/privacy/suppression.ts';
import type { MessageHandoffDecisionCase } from '../../src/domain/privacy/suppression.ts';
import type { RecipientEvaluationInput } from '../../src/domain/recipient/assess-recipients.ts';
import {
  FIXTURE_APPROVER_ROLE,
  FIXTURE_ORIGINAL_ROLE,
  FIXTURE_SECONDARY_ROLE,
  fixtureSlot,
  fixtureType,
  fixtureTypeNamed,
  requiredTwoSlotTypeWith,
} from './support/catalog-fixtures.ts';
import {
  currentSource,
  handoffItem,
  privacyAllowed,
  privacyAnswersFor,
  privacyGateDouble,
  privacyIndeterminate,
  privacyNotAllowed,
  privacyUnavailable,
  processingScope,
  staleSource,
} from './support/privacy-fixtures.ts';
import type { PrivacyAnswer } from './support/privacy-fixtures.ts';
import { blockingFactsOf, recoverySummary, requiredSummary } from './support/privacy-summaries.ts';
import {
  binding,
  evaluationInput,
  gateDouble,
  NEW_ADDRESS,
  ORIGINAL_ADDRESS,
  slotKeyOf,
  unavailable,
  unusable,
  usable,
} from './support/recipient-fixtures.ts';
import type { OwnerAnswer } from './support/recipient-fixtures.ts';

const decide = (
  recipient: RecipientEvaluationInput,
  items: readonly MessageHandoffItem[],
  owners: {
    readonly privacy?: Readonly<Record<string, PrivacyAnswer>>;
    readonly recipients?: Readonly<Record<string, OwnerAnswer>>;
    readonly source?: MessageHandoffInput['source'];
  },
) => {
  const recipientGate = gateDouble(owners.recipients ?? {});
  const privacyGate = privacyGateDouble(owners.privacy ?? {});
  return {
    privacyQueries: privacyGate.queries,
    recipientQueries: recipientGate.queries,
    run: decideMessageHandoffs({ recipient, source: owners.source ?? currentSource }, items).pipe(
      Effect.provide(Layer.mergeAll(recipientGate.layer, privacyGate.layer)),
    ),
  };
};

/** Tag-free view: what happened to each message and why, most important reason first. */
const view = (decision: MessageHandoffDecisionCase) =>
  MessageHandoffDecision.$match(decision, {
    AlreadyHandedOff: ({ identity, later }) => ({
      kind: 'AlreadyHandedOff' as const,
      later: later.map(({ category }) => category),
      recipient: identity.recipient.resourceId,
    }),
    Proceed: ({ identity }) => ({ kind: 'Proceed' as const, recipient: identity.recipient.resourceId }),
    ReconciliationRequired: ({ identity }) => ({
      kind: 'ReconciliationRequired' as const,
      recipient: identity.recipient.resourceId,
    }),
    Suppressed: ({ identity, reasons }) => ({
      kind: 'Suppressed' as const,
      reasons: reasons.map(({ category, cause }) => `${category}:${cause}`),
      recipient: identity.recipient.resourceId,
    }),
  });

const single = fixtureType();
const forA = binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a');
const oneMessage = (overrides: Parameters<typeof handoffItem>[3] = {}) => {
  const input = evaluationInput(single, [forA]);
  return { input, items: [handoffItem(input, forA, 'primary', overrides)] };
};
/** The one decision of a single-message run. */
const only = (decisions: readonly MessageHandoffDecisionCase[]) => Option.getOrThrow(EffectArray.head(decisions));

const decideOne = (
  owners: Parameters<typeof decide>[2],
  overrides: Parameters<typeof handoffItem>[3] = {},
  extra: { readonly source?: MessageHandoffInput['source'] } = {},
) => {
  const { input, items } = oneMessage(overrides);
  const prepared = decide(input, items, { ...owners, ...extra });
  return { ...prepared, first: prepared.run.pipe(Effect.map(only)) };
};

describe('#1396 Rule: eligibility is exact and Current for every recipient', () => {
  it.effect(
    'Scenario: Current ALLOWED, the original recipient and a current source let the message continue, nothing more',
    () =>
      Effect.gen(function* allowedAndEverythingElse() {
        const { first } = decideOne({
          privacy: { 'recipient-a': privacyAllowed },
          recipients: { 'contact-a': usable() },
        });
        const decision = yield* first;

        expect(view(decision)).toEqual({ kind: 'Proceed', recipient: 'recipient-a' });
        // The endpoint stays protected; the decision names no provider acceptance, delivery or verification.
        expect(JSON.stringify(decision)).not.toContain(ORIGINAL_ADDRESS);
        expect(Object.keys(decision).toSorted()).toEqual(['_tag', 'endpoint', 'evidence', 'identity']);
      }),
  );

  it.effect('Scenario: Current Privacy NOT_ALLOWED blocks the message and records the proven prohibition', () =>
    Effect.gen(function* notAllowed() {
      const { first } = decideOne({
        privacy: { 'recipient-a': privacyNotAllowed(['fixture_current_restriction:r1']) },
        recipients: { 'contact-a': usable() },
      });
      const decision = yield* first;

      expect(view(decision)).toEqual({
        kind: 'Suppressed',
        reasons: ['PRIVACY_NOT_ALLOWED:EVALUATED_PROHIBITION'],
        recipient: 'recipient-a',
      });
      expect(blockingFactsOf(decision)).toEqual(['fixture_current_restriction:r1']);
    }),
  );

  it.effect('Scenario: Current Privacy INDETERMINATE stops the message as uncertainty, never as a prohibition', () =>
    Effect.gen(function* indeterminate() {
      const { first } = decideOne({
        privacy: { 'recipient-a': privacyIndeterminate },
        recipients: { 'contact-a': usable() },
      });

      expect(view(yield* first)).toMatchObject({
        reasons: ['PRIVACY_INDETERMINATE:INPUTS_NOT_EVIDENCED'],
      });
    }),
  );

  it.effect(
    'Scenario: the first stage has no preference; without one an INDETERMINATE still stops and no opt-in is invented',
    () =>
      Effect.gen(function* noImplicitOptIn() {
        // There is no preference input anywhere in the decision: an absent record is neither opt-in nor opt-out.
        const { first } = decideOne({
          privacy: { 'recipient-a': privacyUnavailable('CONTEXT_AMBIGUOUS') },
          recipients: { 'contact-a': usable() },
        });

        expect(view(yield* first)).toMatchObject({
          kind: 'Suppressed',
          reasons: ['PRIVACY_INDETERMINATE:CONTEXT_AMBIGUOUS'],
        });
      }),
  );

  it.effect('Scenario: a historical ALLOWED for another purpose is not applied and a Current result is required', () =>
    Effect.gen(function* historicalMarketingAllowed() {
      const { first } = decideOne({
        privacy: {
          'recipient-a': privacyAnswersFor(
            (scope) => ({ ...scope, purposeRef: 'fixture-marketing-purpose' }),
            'ALLOWED',
          ),
        },
        recipients: { 'contact-a': usable() },
      });

      expect(view(yield* first)).toMatchObject({
        reasons: ['PRIVACY_INDETERMINATE:EVIDENCE_SCOPE_MISMATCH'],
      });
    }),
  );

  it.effect('Scenario: a purpose the approved type does not declare is never sent to Privacy as the type purpose', () =>
    Effect.gen(function* undeclaredPurpose() {
      const { input, items } = oneMessage({
        scope: processingScope('recipient-a', { catalogPurposeRef: 'fixture.privacy.undeclared' }),
      });
      const prepared = decide(input, items, {
        privacy: { 'recipient-a': privacyAllowed },
        recipients: { 'contact-a': usable() },
      });
      const decision = only(yield* prepared.run);

      expect(view(decision)).toMatchObject({ reasons: ['PRIVACY_INDETERMINATE:CONTEXT_AMBIGUOUS'] });
      expect(prepared.privacyQueries).toHaveLength(0);
    }),
  );

  it.effect(
    'Scenario: ALLOWED does not override the recipient authorization, and the denial is not labelled Privacy',
    () =>
      Effect.gen(function* allowedButRecipientDenied() {
        const { first } = decideOne({
          privacy: { 'recipient-a': privacyAllowed },
          recipients: { 'contact-a': unusable('PERMISSION_ABSENT') },
        });
        const decision = yield* first;

        expect(view(decision)).toEqual({
          kind: 'Suppressed',
          reasons: ['RECIPIENT_INVALID:PERMISSION_ABSENT'],
          recipient: 'recipient-a',
        });
      }),
  );

  it.effect('Scenario: a proven prohibition stays the primary reason when another owner is unavailable (BR-04)', () =>
    Effect.gen(function* provenOutranksUnavailable() {
      const { first } = decideOne({
        privacy: { 'recipient-a': privacyNotAllowed() },
        recipients: { 'contact-a': unavailable() },
      });

      expect(view(yield* first)).toMatchObject({
        reasons: ['PRIVACY_NOT_ALLOWED:EVALUATED_PROHIBITION', 'RECIPIENT_INVALID:AUTHORITY_UNAVAILABLE'],
      });
    }),
  );

  it.effect(
    'Scenario: unknown privacy input without any proven prohibition stays indeterminate (no fabricated deny)',
    () =>
      Effect.gen(function* unknownInput() {
        const { first } = decideOne({
          privacy: { 'recipient-a': privacyUnavailable('OWNER_UNAVAILABLE') },
          recipients: { 'contact-a': usable() },
        });
        const decision = yield* first;

        expect(view(decision)).toMatchObject({ reasons: ['PRIVACY_INDETERMINATE:OWNER_UNAVAILABLE'] });
        expect(JSON.stringify(view(decision))).not.toContain('PRIVACY_NOT_ALLOWED');
      }),
  );
});

describe('#1396 Rule: a change before the last handoff stops the work, and a proven handoff stays true', () => {
  it.effect(
    'Scenario: a consent withdrawal before the boundary stops the queued message and keeps the first decision',
    () =>
      Effect.gen(function* withdrawalBeforeBoundary() {
        const { input, items } = oneMessage();
        const owners = { recipients: { 'contact-a': usable() } };
        const queued = yield* decide(input, items, { ...owners, privacy: { 'recipient-a': privacyAllowed } }).run;
        const rechecked = yield* decide(input, items, { ...owners, privacy: { 'recipient-a': privacyNotAllowed() } })
          .run;

        expect(view(only(queued)).kind).toBe('Proceed');
        expect(view(only(rechecked))).toMatchObject({
          kind: 'Suppressed',
          reasons: ['PRIVACY_NOT_ALLOWED:EVALUATED_PROHIBITION'],
        });
        // The earlier decision is an immutable value: rechecking produced a NEW decision and left it as it was.
        expect(view(only(queued)).kind).toBe('Proceed');
      }),
  );

  it.effect(
    'Scenario: access to the Privacy Read withdrawn after the intent was prepared stops the handoff as an access failure, not a prohibition',
    () =>
      Effect.gen(function* accessWithdrawn() {
        const { input, items } = oneMessage();
        const owners = { recipients: { 'contact-a': usable() } };
        const prepared = only(
          yield* decide(input, items, { ...owners, privacy: { 'recipient-a': privacyAllowed } }).run,
        );
        const rechecked = only(
          yield* decide(input, items, {
            ...owners,
            privacy: { 'recipient-a': privacyUnavailable('AUTHORIZATION_DENIED') },
          }).run,
        );

        expect(view(prepared).kind).toBe('Proceed');
        expect(view(rechecked)).toEqual({
          kind: 'Suppressed',
          reasons: ['PRIVACY_INDETERMINATE:AUTHORIZATION_DENIED'],
          recipient: 'recipient-a',
        });
        expect(JSON.stringify(view(rechecked))).not.toContain('PRIVACY_NOT_ALLOWED');
      }),
  );

  it.effect('Scenario: a stale ALLOWED never authorizes queued or retried work, every handoff asks Privacy again', () =>
    Effect.gen(function* queuedAndRetried() {
      const { input, items } = oneMessage();
      const prepared = decide(input, items, {
        privacy: { 'recipient-a': privacyAllowed },
        recipients: { 'contact-a': usable() },
      });
      yield* prepared.run;
      yield* TestClock.adjust('90 days');
      yield* prepared.run;

      expect(prepared.privacyQueries).toHaveLength(2);
      expect(prepared.recipientQueries).toHaveLength(2);
    }),
  );

  it.effect(
    'Scenario: a Processing Restriction of this purpose stops the last handoff and names its blocking fact',
    () =>
      Effect.gen(function* restriction() {
        const { first } = decideOne({
          privacy: { 'recipient-a': privacyNotAllowed(['fixture_current_restriction:restriction-9']) },
          recipients: { 'contact-a': usable() },
        });
        const decision = yield* first;

        expect(view(decision).kind).toBe('Suppressed');
        expect(blockingFactsOf(decision)).toEqual(['fixture_current_restriction:restriction-9']);
      }),
  );

  it.effect(
    'Scenario: a change after a proven handoff never rewrites it as suppressed and is not even asked about',
    () =>
      Effect.gen(function* afterProvenHandoff() {
        const { input, items } = oneMessage({ handoff: HandoffFact.ProvenHandedOff() });
        const prepared = decide(input, items, {
          privacy: { 'recipient-a': privacyNotAllowed() },
          recipients: { 'contact-a': usable() },
          source: staleSource('SOURCE_STATE_INELIGIBLE'),
        });
        const decision = only(yield* prepared.run);

        // History stays true; the later source condition is recorded and governs only further processing.
        expect(view(decision)).toEqual({
          kind: 'AlreadyHandedOff',
          later: ['SOURCE_STALE'],
          recipient: 'recipient-a',
        });
        expect(prepared.privacyQueries).toHaveLength(0);
        expect(prepared.recipientQueries).toHaveLength(0);
      }),
  );

  it.effect(
    'Scenario: an unknown provider effect needs reconciliation, never a blind resend and never a Privacy verdict',
    () =>
      Effect.gen(function* unknownProviderEffect() {
        const { input, items } = oneMessage({ handoff: HandoffFact.EffectUnknown() });
        const prepared = decide(input, items, {
          privacy: { 'recipient-a': privacyNotAllowed() },
          recipients: { 'contact-a': usable() },
        });
        const decision = only(yield* prepared.run);

        expect(view(decision)).toEqual({ kind: 'ReconciliationRequired', recipient: 'recipient-a' });
        expect(prepared.privacyQueries).toHaveLength(0);
      }),
  );
});

describe('#1396 Rule: channel and source state are independent reasons for suppression', () => {
  it.effect('Scenario: an unusable original endpoint stops the message and never goes to the new address', () =>
    Effect.gen(function* unusableOriginalEndpoint() {
      const { input, items } = oneMessage();
      const prepared = decide(input, items, {
        privacy: { 'recipient-a': privacyAllowed },
        recipients: { 'contact-a': unusable('ORIGINAL_ENDPOINT_UNUSABLE'), 'contact-new': usable(NEW_ADDRESS) },
      });
      const decision = only(yield* prepared.run);

      expect(view(decision)).toMatchObject({ reasons: ['CHANNEL_UNUSABLE:ORIGINAL_ENDPOINT_UNUSABLE'] });
      expect(prepared.recipientQueries.map(({ contact }) => contact.contactRef.resourceId)).toEqual(['contact-a']);
    }),
  );

  it.effect('Scenario: a provider-evidenced block is a provider suppression, distinct from Privacy NOT_ALLOWED', () =>
    Effect.gen(function* providerSuppression() {
      const { first } = decideOne(
        { privacy: { 'recipient-a': privacyAllowed }, recipients: { 'contact-a': usable() } },
        { provider: ProviderFact.Suppressed({ evidenceRef: 'fixture-provider-evidence-1', kind: 'BLOCKED' }) },
      );

      expect(view(yield* first)).toMatchObject({ reasons: ['PROVIDER_SUPPRESSED:PROVIDER_BLOCKED'] });
    }),
  );

  it.effect(
    'Scenario: a mandatory provider or channel fact that cannot be obtained is uncertainty, never an allow fallback',
    () =>
      Effect.gen(function* missingProviderFact() {
        const { first } = decideOne(
          { privacy: { 'recipient-a': privacyAllowed }, recipients: { 'contact-a': usable() } },
          { provider: ProviderFact.Unavailable() },
        );

        expect(view(yield* first)).toMatchObject({ reasons: ['CHANNEL_UNUSABLE:PROVIDER_FACT_UNAVAILABLE'] });
      }),
  );

  it.effect('Scenario: an ALLOWED for the approved channel is not reused for another channel of the endpoint', () =>
    Effect.gen(function* channelMismatch() {
      const { first } = decideOne(
        { privacy: { 'recipient-a': privacyAllowed }, recipients: { 'contact-a': usable() } },
        { scope: processingScope('recipient-a', { channel: 'sms' }) },
      );

      expect(view(yield* first)).toMatchObject({ reasons: ['CHANNEL_UNUSABLE:CHANNEL_MISMATCH'] });
    }),
  );

  it.effect(
    'Scenario: a revoked invitation (the source no longer justifies the request) stops it without touching the source',
    () =>
      Effect.gen(function* staleInvitation() {
        const { first } = decideOne(
          { privacy: { 'recipient-a': privacyAllowed }, recipients: { 'contact-a': usable() } },
          {},
          { source: staleSource('SOURCE_NO_LONGER_VALID') },
        );

        expect(view(yield* first)).toMatchObject({ reasons: ['SOURCE_STALE:SOURCE_NO_LONGER_VALID'] });
      }),
  );
});

describe('#1396 Rule: a marketing unsubscribe does not suppress an independent security message, a relevant restriction does', () => {
  it.effect('Scenario: only the transactional scope is ever asked; the marketing facts are not an input', () =>
    Effect.gen(function* marketingUnsubscribe() {
      const { input, items } = oneMessage();
      const prepared = decide(input, items, {
        privacy: { 'recipient-a': privacyAllowed },
        recipients: { 'contact-a': usable() },
      });
      const decision = only(yield* prepared.run);

      expect(view(decision).kind).toBe('Proceed');
      expect(prepared.privacyQueries.map(({ scope }) => scope.catalogPurposeRef)).toEqual(['fixture.privacy.purpose']);
    }),
  );

  it.effect(
    'Scenario: a relevant Privacy NOT_ALLOWED applies to a security message and "security" is no exception',
    () =>
      Effect.gen(function* relevantRestriction() {
        const { first } = decideOne({
          privacy: { 'recipient-a': privacyNotAllowed(['fixture_current_restriction:security-flow']) },
          recipients: { 'contact-a': usable() },
        });

        expect(view(yield* first)).toMatchObject({
          kind: 'Suppressed',
          reasons: ['PRIVACY_NOT_ALLOWED:EVALUATED_PROHIBITION'],
        });
      }),
  );
});

const approvers = [
  binding(FIXTURE_APPROVER_ROLE, 'recipient-a', 'contact-a'),
  binding(FIXTURE_APPROVER_ROLE, 'recipient-b', 'contact-b'),
  binding(FIXTURE_APPROVER_ROLE, 'recipient-c', 'contact-c'),
];
const requiredApprovers = fixtureTypeNamed('approvers-required', {
  requiredness: 'REQUIRED',
  result: { kind: 'MESSAGE_INTENTS', slots: [fixtureSlot('approvers', FIXTURE_APPROVER_ROLE, 'EACH_MATCHING')] },
});

const threeRecipients = () => {
  const input = evaluationInput(requiredApprovers, approvers);
  return { input, items: approvers.map((approver) => handoffItem(input, approver, 'approvers')) };
};

describe('#1396 Rule: every recipient has its own outcome (BR-09)', () => {
  const allUsable = { 'contact-a': usable(), 'contact-b': usable(), 'contact-c': usable() };

  it.effect(
    'Scenario: two of three recipients may continue and the third has its own reason, so the result is partial',
    () =>
      Effect.gen(function* oneOfThree() {
        const { input, items } = threeRecipients();
        const decisions = yield* decide(input, items, {
          privacy: { 'recipient-a': privacyAllowed, 'recipient-b': privacyAllowed, 'recipient-c': privacyNotAllowed() },
          recipients: allUsable,
        }).run;

        expect(decisions.map(view)).toEqual([
          { kind: 'Proceed', recipient: 'recipient-a' },
          { kind: 'Proceed', recipient: 'recipient-b' },
          { kind: 'Suppressed', reasons: ['PRIVACY_NOT_ALLOWED:EVALUATED_PROHIBITION'], recipient: 'recipient-c' },
        ]);
        expect(requiredSummary(requiredHandoffOutcomeOf('REQUIRED', decisions))).toMatchObject({
          kind: 'Failed',
          partial: true,
          sourceImpact: 'SOURCE_OWNER_DECIDES',
        });
      }),
  );

  it.effect('Scenario: one recipient owner outage never changes the decision of another recipient', () =>
    Effect.gen(function* isolatedFailure() {
      const { input, items } = threeRecipients();
      const decisions = yield* decide(input, items, {
        privacy: {
          'recipient-a': privacyUnavailable('OWNER_UNAVAILABLE'),
          'recipient-b': privacyAllowed,
          'recipient-c': privacyAllowed,
        },
        recipients: allUsable,
      }).run;

      expect(decisions.map((decision) => view(decision).kind)).toEqual(['Suppressed', 'Proceed', 'Proceed']);
    }),
  );

  it.effect('Scenario: each recipient is asked for its own scope, never for a scope shared with another subject', () =>
    Effect.gen(function* ownScopes() {
      const { input, items } = threeRecipients();
      const prepared = decide(input, items, {
        privacy: { 'recipient-a': privacyAllowed, 'recipient-b': privacyAllowed, 'recipient-c': privacyAllowed },
        recipients: allUsable,
      });
      yield* prepared.run;

      expect(new Set(prepared.privacyQueries.map(({ scope }) => JSON.stringify(scope.subject))).size).toBe(3);
    }),
  );

  const indivisible = {
    approvalRuleKey: 'fixture.rule.indivisible',
    mode: 'INDIVISIBLE',
    slotKeys: ['primary', 'secondary'],
  };
  const groupType = requiredTwoSlotTypeWith({ audience: indivisible });
  const forB = binding(FIXTURE_SECONDARY_ROLE, 'recipient-b', 'contact-b');
  const groupItems = (overrides: Parameters<typeof handoffItem>[3] = {}) => {
    const input = evaluationInput(groupType, [forA, forB]);
    return {
      input,
      items: [handoffItem(input, forA, 'primary', overrides), handoffItem(input, forB, 'secondary')],
    };
  };

  it.effect(
    'Scenario: an approved indivisible audience hands off nothing when one required member is not allowed by Privacy',
    () =>
      Effect.gen(function* indivisibleGroup() {
        const { input, items } = groupItems();
        const decisions = yield* decide(input, items, {
          privacy: { 'recipient-a': privacyAllowed, 'recipient-b': privacyNotAllowed() },
          recipients: { 'contact-a': usable(), 'contact-b': usable() },
        }).run;

        expect(decisions.map(view)).toEqual([
          {
            kind: 'Suppressed',
            reasons: ['AUDIENCE_GROUP_INCOMPLETE:AUDIENCE_GROUP_INCOMPLETE'],
            recipient: 'recipient-a',
          },
          { kind: 'Suppressed', reasons: ['PRIVACY_NOT_ALLOWED:EVALUATED_PROHIBITION'], recipient: 'recipient-b' },
        ]);
      }),
  );

  it.effect(
    'Scenario: a member already proven handed off is kept as it happened and the broken group is only recorded',
    () =>
      Effect.gen(function* brokenGroupAfterHandoff() {
        const { input, items } = groupItems({ handoff: HandoffFact.ProvenHandedOff() });
        const decisions = yield* decide(input, items, {
          privacy: { 'recipient-b': privacyNotAllowed() },
          recipients: { 'contact-a': usable(), 'contact-b': usable() },
        }).run;

        expect(view(only(decisions))).toEqual({
          kind: 'AlreadyHandedOff',
          later: ['AUDIENCE_GROUP_INCOMPLETE'],
          recipient: 'recipient-a',
        });
      }),
  );
});

describe('#1396 Rule: a required message never bypasses a gate and its stop reaches the source truthfully (BR-12, AC-09)', () => {
  const requiredType = fixtureTypeNamed('required-single', { requiredness: 'REQUIRED' });
  const forRequired = binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a');
  const requiredOne = (overrides: Parameters<typeof handoffItem>[3] = {}) => {
    const input = evaluationInput(requiredType, [forRequired]);
    return { input, items: [handoffItem(input, forRequired, 'primary', overrides)] };
  };

  it.effect(
    'Scenario: a required message with a blocking Privacy fact cannot leave and the source gets a failed outcome',
    () =>
      Effect.gen(function* requiredBlocked() {
        const { input, items } = requiredOne();
        const decisions = yield* decide(input, items, {
          privacy: { 'recipient-a': privacyNotAllowed() },
          recipients: { 'contact-a': usable() },
        }).run;
        const outcome = requiredHandoffOutcomeOf('REQUIRED', decisions);

        expect(requiredSummary(outcome)).toEqual({
          kind: 'Failed',
          partial: false,
          reconciliation: [],
          sourceImpact: 'SOURCE_OWNER_DECIDES',
          stopped: [{ category: 'PRIVACY_NOT_ALLOWED', recipient: 'recipient-a' }],
        });
        // Communications changes nothing in the source: the outcome has no field that could.
        expect(Object.keys(outcome).toSorted()).toEqual([
          '_tag',
          'partial',
          'reconciliation',
          'sourceImpact',
          'stopped',
        ]);
      }),
  );

  it.effect(
    'Scenario: an unknown provider effect is owed reconciliation, which is not a suppression and not a Privacy result',
    () =>
      Effect.gen(function* requiredUnknownEffect() {
        const { input, items } = requiredOne({ handoff: HandoffFact.EffectUnknown() });
        const decisions = yield* decide(input, items, { privacy: {}, recipients: {} }).run;

        expect(requiredSummary(requiredHandoffOutcomeOf('REQUIRED', decisions))).toMatchObject({
          kind: 'Failed',
          reconciliation: ['recipient-a'],
          stopped: [],
        });
      }),
  );

  it.effect('Scenario: the owner own source change is truthful but is not reported as a Communications failure', () =>
    Effect.gen(function* requiredStaleSource() {
      const { input, items } = requiredOne();
      const decisions = yield* decide(input, items, {
        privacy: { 'recipient-a': privacyAllowed },
        recipients: { 'contact-a': usable() },
        source: staleSource('SOURCE_REVISION_NOT_CURRENT'),
      }).run;

      expect(requiredSummary(requiredHandoffOutcomeOf('REQUIRED', decisions)).kind).toBe('SourceStale');
    }),
  );

  it.effect(
    'Scenario: required and optional types differ only in the outcome owed to the source, never in the gates',
    () =>
      Effect.gen(function* requiredVersusOptional() {
        const { input, items } = oneMessage();
        const decisions = yield* decide(input, items, {
          privacy: { 'recipient-a': privacyNotAllowed() },
          recipients: { 'contact-a': usable() },
        }).run;

        expect(requiredSummary(requiredHandoffOutcomeOf('OPTIONAL', decisions)).kind).toBe('NotRequired');
        expect(view(only(decisions)).kind).toBe('Suppressed');
      }),
  );

  it.effect('Scenario: everything allowed is ready for step 22, which is not a delivery claim', () =>
    Effect.gen(function* requiredReady() {
      const { input, items } = requiredOne();
      const decisions = yield* decide(input, items, {
        privacy: { 'recipient-a': privacyAllowed },
        recipients: { 'contact-a': usable() },
      }).run;

      expect(requiredSummary(requiredHandoffOutcomeOf('REQUIRED', decisions)).kind).toBe('Ready');
    }),
  );
});

describe('#1396 Rule: recovery needs a new Current evaluation and never rewrites the stop (BR-13)', () => {
  const stoppedAt = DateTime.makeUnsafe('2026-11-19T10:00:00.000Z');
  const prior = (decision: MessageHandoffDecisionCase) => ({ evaluatedAt: stoppedAt, identity: decision.identity });

  it.effect(
    'Scenario: a later Current ALLOWED admits one more attempt while the earlier stop stays exactly as recorded',
    () =>
      Effect.gen(function* recoveryAfterRepair() {
        const { input, items } = oneMessage();
        const owners = { recipients: { 'contact-a': usable() } };
        const stopped = only(
          yield* decide(input, items, { ...owners, privacy: { 'recipient-a': privacyIndeterminate } }).run,
        );
        const stoppedBefore = JSON.stringify(stopped);
        yield* TestClock.setTime(Date.parse('2026-11-19T11:00:00.000Z'));
        const repaired = only(
          yield* decide(input, items, { ...owners, privacy: { 'recipient-a': privacyAllowed } }).run,
        );

        expect(recoverySummary(admitRecoveryAfterStop(prior(stopped), repaired))).toEqual({
          kind: 'Admitted',
          priorStopPreserved: true,
        });
        expect(JSON.stringify(stopped)).toBe(stoppedBefore);
      }),
  );

  it.effect(
    'Scenario: an evaluation that is not newer, or still stopped, or already handed off, or unreconciled admits nothing',
    () =>
      Effect.gen(function* recoveryRefusals() {
        const { input, items } = oneMessage();
        const usableOwner = { recipients: { 'contact-a': usable() } };
        const stopped = only(
          yield* decide(input, items, {
            ...usableOwner,
            privacy: { 'recipient-a': privacyIndeterminate },
          }).run,
        );
        const sameTime = only(
          yield* decide(input, items, { ...usableOwner, privacy: { 'recipient-a': privacyAllowed } }).run,
        );
        const stillStopped = only(
          yield* decide(input, items, {
            ...usableOwner,
            privacy: { 'recipient-a': privacyNotAllowed() },
          }).run,
        );
        const handedOff = oneMessage({ handoff: HandoffFact.ProvenHandedOff() });
        const unknownEffect = oneMessage({ handoff: HandoffFact.EffectUnknown() });
        const handed = only(yield* decide(handedOff.input, handedOff.items, usableOwner).run);
        const unknown = only(yield* decide(unknownEffect.input, unknownEffect.items, usableOwner).run);
        const laterStop = { evaluatedAt: DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'), identity: stopped.identity };

        expect(recoverySummary(admitRecoveryAfterStop(laterStop, sameTime))).toEqual({
          kind: 'Refused',
          reason: 'NOT_A_NEW_EVALUATION',
        });
        expect(recoverySummary(admitRecoveryAfterStop(prior(stopped), stillStopped))).toEqual({
          kind: 'Refused',
          reason: 'STILL_SUPPRESSED',
        });
        expect(recoverySummary(admitRecoveryAfterStop(prior(stopped), handed))).toEqual({
          kind: 'Refused',
          reason: 'ALREADY_HANDED_OFF',
        });
        expect(recoverySummary(admitRecoveryAfterStop(prior(stopped), unknown))).toEqual({
          kind: 'Refused',
          reason: 'RECONCILIATION_REQUIRED',
        });
        const otherMessage = { ...stopped.identity, slotKey: slotKeyOf('other-slot') };
        expect(
          recoverySummary(admitRecoveryAfterStop({ ...prior(stopped), identity: otherMessage }, sameTime)),
        ).toEqual({ kind: 'Refused', reason: 'DIFFERENT_MESSAGE' });
      }),
  );
});
