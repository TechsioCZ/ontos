import { DateTime, Effect, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { requiredOutcomeOf } from '../../src/domain/catalog/required-outcome.ts';
import { RecipientAssessment } from '../../src/domain/recipient/recipient-assessment.ts';
import { assessRecipients, recipientFactOf } from '../../src/domain/recipient/assess-recipients.ts';
import type { RecipientEvaluationInput } from '../../src/domain/recipient/assess-recipients.ts';
import { unavailableRecipientCurrentGateLayer } from '../../src/domain/recipient/current-gate.ts';
import { RecipientEvidenceSchema } from '../../src/domain/recipient/recipient-evidence.ts';
import type { PrivacyEvidence } from '../../src/domain/catalog/vocabulary.ts';
import {
  decideOrThrow,
  FIXTURE_APPROVER_ROLE,
  FIXTURE_ORIGINAL_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureSlot,
  fixtureType,
  fixtureTypeNamed,
  nRecipientPolicyType,
} from './support/catalog-fixtures.ts';
import {
  binding,
  evaluationInput,
  fixtureScope,
  gateDouble,
  NEW_ADDRESS,
  ORIGINAL_ADDRESS,
  slotKeyOf,
  unavailable,
  unusable,
  usable,
  usableForOtherContact,
} from './support/recipient-fixtures.ts';
import type { OwnerAnswer } from './support/recipient-fixtures.ts';
import { assessmentSummary, outcomeSummary, requiredSummary, revealedAddresses } from './support/summaries.ts';

const single = fixtureType();

const assess = (input: RecipientEvaluationInput, answers: Readonly<Record<string, OwnerAnswer>>) => {
  const gate = gateDouble(answers);
  return {
    gate,
    run: assessRecipients(input).pipe(Effect.provide(gate.layer)),
  };
};

/** Decide the request exactly as the intake will: recipient facts from the assessments, Privacy from its own gate. */
const decisionOf = (
  input: RecipientEvaluationInput,
  evaluated: Effect.Success<ReturnType<typeof assessRecipients>>,
  privacy: PrivacyEvidence = 'ALLOWED',
) =>
  decideOrThrow(
    fixtureRegistry(input.type),
    input.request,
    fixtureContext(evaluated.map(({ assessment }) => recipientFactOf(assessment, input.request, privacy))),
  );

const unavailableFact = (privacy: PrivacyEvidence) =>
  recipientFactOf(
    RecipientAssessment.SourceUnavailable({
      authority: 'SOURCE_OWNER',
      subject: { binding: binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a'), slotKey: slotKeyOf('primary') },
    }),
    evaluationInput(single, []).request,
    privacy,
  );

const requiredApprovers = fixtureTypeNamed('approvers-required', {
  requiredness: 'REQUIRED',
  result: {
    kind: 'MESSAGE_INTENTS',
    slots: [fixtureSlot('approvers', FIXTURE_APPROVER_ROLE, 'EACH_MATCHING')],
  },
});

describe('#1395 Rule: the historical recipient is binding, but Current eligibility is required (BR-02, BR-03)', () => {
  it.effect('Scenario: a single recipient stays usable and is addressed at the original endpoint', () =>
    Effect.gen(function* singleRecipientUsable() {
      const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
      const { gate, run } = assess(input, { 'contact-original': usable() });
      const evaluated = yield* run;

      expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
        { outcome: 'recipient-allowed', recipient: 'recipient-a' },
      ]);
      const [first] = evaluated;
      expect(revealedAddresses(first === undefined ? [] : [first])).toEqual([ORIGINAL_ADDRESS]);
      // The source context is evidenced: the occurrence, its revision, the type and the original contact.
      expect(first?.evidence).toMatchObject({
        authorization: 'RECIPIENT_ALLOWED',
        occurrence: { occurrenceId: 'fixture-occurrence-1', revision: 1 },
        originalContact: { contactRef: { resourceId: 'contact-original' } },
        recipientRef: { resourceId: 'recipient-a' },
        typeId: 'fixture.single-message',
        typeRevision: 1,
      });
      expect(gate.queries).toHaveLength(1);
    }),
  );

  it.effect(
    'Scenario: the contact was changed after the event, the original is still usable: the original endpoint stays, no retarget',
    () =>
      Effect.gen(function* contactChangedAfterEvent() {
        const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
        // The owner now holds a newer contact for the same profile; the original one is still usable.
        const { gate, run } = assess(input, {
          'contact-new': usable(NEW_ADDRESS),
          'contact-original': usable(ORIGINAL_ADDRESS),
        });
        const [first] = yield* run;

        expect(revealedAddresses(first === undefined ? [] : [first])).toEqual([ORIGINAL_ADDRESS]);
        // The gate was only ever asked about the original contact; the newer one was never offered or read.
        expect(gate.queries.map(({ contact }) => contact.contactRef.resourceId)).toEqual(['contact-original']);
        expect(JSON.stringify(gate.queries)).not.toContain('contact-new');
      }),
  );

  it.effect(
    'AC-02 Scenario: the original endpoint was ended: nothing is handed off, not to the new address either',
    () =>
      Effect.gen(function* originalEndpointEnded() {
        const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
        const { gate, run } = assess(input, {
          'contact-new': usable(NEW_ADDRESS),
          'contact-original': unusable('ORIGINAL_ENDPOINT_UNUSABLE'),
        });
        const evaluated = yield* run;
        const decision = decisionOf(input, evaluated);

        expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
          { outcome: 'recipient-not-allowed', reason: 'ORIGINAL_ENDPOINT_UNUSABLE', recipient: 'recipient-a' },
        ]);
        expect(outcomeSummary(decision)).toMatchObject({
          candidates: [{ kind: 'Suppressed', reason: 'RECIPIENT_NOT_ELIGIBLE', resourceId: 'recipient-a' }],
          kind: 'Candidates',
        });
        expect(gate.queries.map(({ contact }) => contact.contactRef.resourceId)).toEqual(['contact-original']);
        expect(JSON.stringify(evaluated)).not.toContain(NEW_ADDRESS);
      }),
  );

  it.effect('Scenario: the original historical contact cannot be proven: not guessed from the current profile', () =>
    Effect.gen(function* originalNotProvable() {
      const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', null)]);
      // The current profile has a usable contact, but nothing may ask for or use it.
      const { gate, run } = assess(input, { 'contact-current-profile': usable(NEW_ADDRESS) });
      const evaluated = yield* run;
      const decision = decisionOf(input, evaluated);

      expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
        { outcome: 'recipient-unresolved', reason: 'ORIGINAL_CONTACT_NOT_EVIDENCED', recipient: 'recipient-a' },
      ]);
      expect(outcomeSummary(decision)).toMatchObject({
        candidates: [{ kind: 'Suppressed', reason: 'RECIPIENT_BASIS_MISSING' }],
      });
      expect(gate.queries).toEqual([]);
      expect(evaluated[0]?.evidence.originalContact).toBeUndefined();
    }),
  );

  it.effect('Scenario: the original recipient lost its Current authorization: not handed off, history untouched', () =>
    Effect.gen(function* currentAuthorizationLost() {
      const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
      const before = yield* assess(input, { 'contact-original': usable() }).run;
      const after = yield* assess(input, { 'contact-original': unusable('PERMISSION_ABSENT') }).run;

      expect(after.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
        { outcome: 'recipient-not-allowed', reason: 'PERMISSION_ABSENT', recipient: 'recipient-a' },
      ]);
      // The loss is a new, separate evidence value; the earlier evidence of the original decision is unchanged.
      expect(before[0]?.evidence.authorization).toBe('RECIPIENT_ALLOWED');
      expect(after[0]?.evidence).toMatchObject({ authorization: 'RECIPIENT_NOT_ALLOWED', reason: 'PERMISSION_ABSENT' });
      expect(after[0]?.evidence.recipientRef).toEqual(before[0]?.evidence.recipientRef);
      expect(after[0]?.evidence.originalContact).toEqual(before[0]?.evidence.originalContact);
    }),
  );

  it.effect.each([
    ['source occurrence', 'SOURCE_NO_LONGER_VALID'],
    ['visibility', 'VISIBILITY_DENIED'],
    ['ownership scope', 'OWNERSHIP_SCOPE_MISMATCH'],
  ] as const)('AC-08 %s that is no longer Current stops the recipient with its own reason', ([_label, reason]) =>
    Effect.gen(function* currentFactStops() {
      const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
      const evaluated = yield* assess(input, { 'contact-original': unusable(reason) }).run;

      expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
        { outcome: 'recipient-not-allowed', reason, recipient: 'recipient-a' },
      ]);
    }),
  );
});

describe('#1395 Rule: every recipient of an approved audience is evaluated individually (BR-06, PO 2A)', () => {
  const approvers = [
    binding(FIXTURE_APPROVER_ROLE, 'approver-a', 'contact-a'),
    binding(FIXTURE_APPROVER_ROLE, 'approver-b', 'contact-b'),
    binding(FIXTURE_APPROVER_ROLE, 'approver-c', 'contact-c'),
  ];

  it.effect(
    'AC-04 Scenario: two of three recipients are allowed: two messages, one explained omission, partial result',
    () =>
      Effect.gen(function* twoOfThree() {
        const input = evaluationInput(requiredApprovers, approvers);
        const evaluated = yield* assess(input, {
          'contact-a': usable('a@example.test'),
          'contact-b': usable('b@example.test'),
          'contact-c': unusable('PERMISSION_ABSENT'),
        }).run;
        const decision = decisionOf(input, evaluated);

        expect(outcomeSummary(decision)).toMatchObject({
          candidates: [
            { kind: 'Eligible', resourceId: 'approver-a' },
            { kind: 'Eligible', resourceId: 'approver-b' },
            { kind: 'Suppressed', reason: 'RECIPIENT_NOT_ELIGIBLE', resourceId: 'approver-c' },
          ],
        });
        // The source learns the truthful partial result; no rollback and nothing for the omitted recipient.
        expect(requiredSummary(requiredOutcomeOf(decision))).toMatchObject({
          kind: 'Failed',
          partial: true,
          sourceImpact: 'SOURCE_OWNER_DECIDES',
        });
        // Each recipient has its own evidence and its own reason.
        expect(
          evaluated.map(({ evidence }) => [evidence.recipientRef.resourceId, evidence.authorization, evidence.reason]),
        ).toEqual([
          ['approver-a', 'RECIPIENT_ALLOWED', undefined],
          ['approver-b', 'RECIPIENT_ALLOWED', undefined],
          ['approver-c', 'RECIPIENT_NOT_ALLOWED', 'PERMISSION_ABSENT'],
        ]);
      }),
  );

  it.effect('one recipient that fails never changes the outcome of the others, whatever the input order', () =>
    Effect.gen(function* independentRecipients() {
      const answers = {
        'contact-a': usable('a@example.test'),
        'contact-b': unavailable('PERMISSION'),
        'contact-c': unusable('VISIBILITY_DENIED'),
      };
      const forward = yield* assess(evaluationInput(nRecipientPolicyType, approvers), answers).run;
      const reversed = yield* assess(evaluationInput(nRecipientPolicyType, approvers.toReversed()), answers).run;

      expect(forward.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
        { outcome: 'recipient-allowed', recipient: 'approver-a' },
        { authority: 'PERMISSION', outcome: 'source-unavailable', recipient: 'approver-b' },
        { outcome: 'recipient-not-allowed', reason: 'VISIBILITY_DENIED', recipient: 'approver-c' },
      ]);
      expect(reversed.map(({ assessment }) => assessmentSummary(assessment))).toEqual(
        forward.map(({ assessment }) => assessmentSummary(assessment)),
      );
    }),
  );

  it.effect(
    'AC-11: there is no numeric cap on recipients, each is evaluated and the gate asked once per recipient',
    () =>
      Effect.gen(function* manyRecipients() {
        const many = Array.from({ length: 60 }, (_unused, index) =>
          binding(FIXTURE_APPROVER_ROLE, `approver-${index}`, `contact-${index}`),
        );
        const answers = Object.fromEntries(
          many.map((_unused, index) => [`contact-${index}`, usable(`p${index}@example.test`)]),
        );
        const { gate, run } = assess(evaluationInput(nRecipientPolicyType, many), answers);
        const evaluated = yield* run;

        expect(evaluated).toHaveLength(60);
        expect(gate.queries).toHaveLength(60);
      }),
  );

  it.effect(
    'Scenario: two profiles share one e-mail address: identity and permission never transfer to profile B',
    () =>
      Effect.gen(function* sharedAddress() {
        const profileA = fixtureScope({ profileId: 'profile-a' });
        const forB = binding(FIXTURE_APPROVER_ROLE, 'approver-b', 'contact-shared-b', {
          scope: fixtureScope({ profileId: 'profile-b' }),
        });
        const forA = binding(FIXTURE_APPROVER_ROLE, 'approver-a', 'contact-shared-a', { scope: profileA });
        const input = evaluationInput(nRecipientPolicyType, [forA, forB], { scope: profileA });
        // Both contacts hold the very same address; only profile A's event and purpose exist.
        const { gate, run } = assess(input, {
          'contact-shared-a': usable('shared@example.test'),
          'contact-shared-b': usable('shared@example.test'),
        });
        const evaluated = yield* run;

        expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
          { outcome: 'recipient-allowed', recipient: 'approver-a' },
          { outcome: 'recipient-not-allowed', reason: 'SCOPE_MISMATCH', recipient: 'approver-b' },
        ]);
        // Profile B was never asked about and nothing of B reaches the evidence.
        expect(gate.queries.map(({ contact }) => contact.contactRef.resourceId)).toEqual(['contact-shared-a']);
        expect(JSON.stringify(evaluated[1]?.evidence)).not.toMatch(/contact-shared-b|profile-b/u);
      }),
  );

  it.effect('Scenario: several contacts without a recipient rule are no broadcast: nothing is chosen at random', () =>
    Effect.gen(function* noRecipientRule() {
      // The single-recipient slot needs exactly one recipient; two plausible ones are ambiguity, not an audience.
      const input = evaluationInput(single, [
        binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a'),
        binding(FIXTURE_ORIGINAL_ROLE, 'recipient-b', 'contact-b'),
      ]);
      const evaluated = yield* assess(input, { 'contact-a': usable(), 'contact-b': usable() }).run;
      const decision = decisionOf(input, evaluated);

      expect(outcomeSummary(decision)).toMatchObject({
        kind: 'NoMessage',
        reason: 'RECIPIENT_AUTHORITY_MISSING',
        unresolvedSlots: [{ reason: 'RECIPIENT_AMBIGUOUS', slotKey: 'primary' }],
      });
    }),
  );
});

describe('#1395 Rule: nothing is handed off on error, unavailable authority or a forbidden scope (BR-08, BR-09, BR-12)', () => {
  it.effect(
    'AC-06 Scenario: the owner is unavailable: no stale permission, a truthful unavailable result, not a ban',
    () =>
      Effect.gen(function* ownerUnavailable() {
        const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
        const evaluated = yield* assess(input, { 'contact-original': unavailable('OWNERSHIP_VISIBILITY') }).run;
        const decision = decisionOf(input, evaluated);

        expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
          { authority: 'OWNERSHIP_VISIBILITY', outcome: 'source-unavailable', recipient: 'recipient-a' },
        ]);
        expect(outcomeSummary(decision)).toMatchObject({
          candidates: [{ kind: 'Suppressed', reason: 'RECIPIENT_AUTHORITY_UNAVAILABLE' }],
        });
        expect(evaluated[0]?.evidence).toMatchObject({
          authority: 'OWNERSHIP_VISIBILITY',
          authorization: 'SOURCE_UNAVAILABLE',
          reason: 'AUTHORITY_UNAVAILABLE',
        });
      }),
  );

  it.effect('the production composition has no recipient authority yet, so it fails closed for every recipient', () =>
    Effect.gen(function* productionFailsClosed() {
      const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
      const evaluated = yield* assessRecipients(input).pipe(Effect.provide(unavailableRecipientCurrentGateLayer));

      expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
        { authority: 'SOURCE_OWNER', outcome: 'source-unavailable', recipient: 'recipient-a' },
      ]);
    }),
  );

  it.effect(
    'an owner that answers for another contact or revision than the original is not allowed, never followed',
    () =>
      Effect.gen(function* ownerRetargets() {
        const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
        const evaluated = yield* assess(input, {
          'contact-original': usableForOtherContact(NEW_ADDRESS, 'contact-new'),
        }).run;

        expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
          { outcome: 'recipient-not-allowed', reason: 'ENDPOINT_IDENTITY_CHANGED', recipient: 'recipient-a' },
        ]);
      }),
  );

  it.effect.each([
    ['NOT_ALLOWED', 'PRIVACY_NOT_ALLOWED'],
    ['INDETERMINATE', 'PRIVACY_INDETERMINATE'],
  ] as const)(
    'AC-08 Scenario: Privacy %s stops the message and stays distinct from a recipient stop',
    ([privacy, reason]) =>
      Effect.gen(function* privacyStops() {
        const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
        const evaluated = yield* assess(input, { 'contact-original': usable() }).run;
        const decision = decisionOf(input, evaluated, privacy);

        // The recipient itself is allowed; only the separate Privacy fact stops the candidate, with its own reason.
        expect(evaluated.map(({ assessment }) => assessmentSummary(assessment))).toEqual([
          { outcome: 'recipient-allowed', recipient: 'recipient-a' },
        ]);
        expect(outcomeSummary(decision)).toMatchObject({ candidates: [{ kind: 'Suppressed', reason }] });
      }),
  );

  it('a recipient stop never hides a Privacy stop and an unavailable authority never reads as a prohibition', () => {
    expect(unavailableFact('ALLOWED').recipientStop).toBe('RECIPIENT_AUTHORITY_UNAVAILABLE');
    expect(unavailableFact('NOT_ALLOWED').privacy).toBe('NOT_ALLOWED');
  });
});

describe('#1395 Rule: Auth and invitation owner bindings cannot be overwritten (BR-05, AC-07)', () => {
  const authType = fixtureTypeNamed('auth-reset', {
    result: {
      kind: 'MESSAGE_INTENTS',
      slots: [
        fixtureSlot('account', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE', {
          contactOwner: 'fixture.party',
          contactResourceType: 'fixture.contact-point',
          evidenceKinds: ['AUTHORITATIVE_REFERENCE'],
        }),
      ],
    },
  });
  const accountBinding = binding(FIXTURE_ORIGINAL_ROLE, 'account-a', 'contact-reset', {
    evidence: { kind: 'AUTHORITATIVE_REFERENCE' },
  });

  it.effect('Scenario: a password reset keeps its owner-issued recipient after the account got a new address', () =>
    Effect.gen(function* resetKeepsRecipient() {
      const input = evaluationInput(authType, [accountBinding]);
      const { gate, run } = assess(input, {
        'contact-account-new': usable(NEW_ADDRESS),
        'contact-reset': usable(ORIGINAL_ADDRESS),
      });
      const [first] = yield* run;

      expect(revealedAddresses(first === undefined ? [] : [first])).toEqual([ORIGINAL_ADDRESS]);
      expect(gate.queries).toHaveLength(1);
      expect(gate.queries[0]?.recipient.recipientRef.resourceId).toBe('account-a');
      expect(gate.queries[0]?.contact.contactRef.resourceId).toBe('contact-reset');
    }),
  );

  it.effect(
    'Scenario: an invitation revoked before handoff is not handed off and issues no new proof or recipient',
    () =>
      Effect.gen(function* invitationRevoked() {
        const input = evaluationInput(authType, [accountBinding]);
        const [first] = yield* assess(input, { 'contact-reset': unusable('OWNER_BINDING_INVALID') }).run;

        expect(first && assessmentSummary(first.assessment)).toEqual({
          outcome: 'recipient-not-allowed',
          reason: 'OWNER_BINDING_INVALID',
          recipient: 'account-a',
        });
        // A refusal carries no endpoint at all: there is nothing to retarget and nothing to resend.
        expect(revealedAddresses(first === undefined ? [] : [first])).toEqual([]);
        expect(first?.evidence.recipientRef.resourceId).toBe('account-a');
      }),
  );

  it.effect('no secret, proof, address or free personal copy is representable in a binding or in evidence', () =>
    Effect.gen(function* nothingSecretIsRepresentable() {
      const input = evaluationInput(authType, [accountBinding]);
      const evaluated = yield* assess(input, { 'contact-reset': usable() }).run;
      const strict = Schema.decodeUnknownResult(RecipientEvidenceSchema, { onExcessProperty: 'error' });
      const [encoded] = evaluated.map(({ evidence }) => Schema.encodeSync(RecipientEvidenceSchema)(evidence));

      expect(Result.isSuccess(strict(encoded))).toBe(true);
      for (const smuggled of ['otp', 'token', 'proof', 'address', 'endpoint', 'claimUrl']) {
        expect(Result.isFailure(strict({ ...encoded, [smuggled]: 'fixture-secret' }))).toBe(true);
      }
      expect(
        Object.keys(RecipientEvidenceSchema.fields).filter((field) =>
          /address|email|token|otp|secret|proof|url|value/iu.test(field),
        ),
      ).toEqual([]);
    }),
  );
});

describe('#1395 Rule: recipient evidence is minimal, safe and immutable (BR-10, BR-11, AC-09)', () => {
  it.effect('stores references, revision, audience policy, authorization, time and reason, never the endpoint', () =>
    Effect.gen(function* safeEvidence() {
      yield* TestClock.setTime(Date.parse('2026-11-19T10:00:00.000Z'));
      const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
      const evaluated = yield* assess(input, { 'contact-original': usable(ORIGINAL_ADDRESS) }).run;
      const encoded = JSON.stringify(
        evaluated.map(({ evidence }) => Schema.encodeSync(RecipientEvidenceSchema)(evidence)),
      );

      expect(evaluated.map(({ evidence }) => evidence)).toMatchObject([
        {
          audience: { mode: 'INDIVIDUAL' },
          endpointMask: 'p***@example.test',
          originalContact: { evidence: { contactRevision: 1, kind: 'VERSIONED_SNAPSHOT' } },
          scope: { tenantId: '11111111-1111-4111-8111-111111111111' },
          sourceModule: 'fixture.source',
        },
      ]);
      expect(evaluated.map(({ evidence }) => DateTime.toEpochMillis(evidence.evaluatedAt))).toEqual([
        Date.parse('2026-11-19T10:00:00.000Z'),
      ]);
      // The usable value exists only as a protected value on the allowed assessment; evidence holds only the mask.
      expect(encoded).not.toContain(ORIGINAL_ADDRESS);
      expect(encoded).not.toContain('puvodni');
    }),
  );

  it.effect(
    'BR-10 Scenario: a retry of the same occurrence keeps recipient, endpoint and identity, and adds no duplicate',
    () =>
      Effect.gen(function* retryKeepsRecipient() {
        const input = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
        const first = yield* assess(input, { 'contact-original': usable(ORIGINAL_ADDRESS) }).run;
        // Between the attempts the profile gets a new contact; the retry still names the original one.
        const retry = yield* assess(input, {
          'contact-new': usable(NEW_ADDRESS),
          'contact-original': usable(ORIGINAL_ADDRESS),
        }).run;
        const identities = [first, retry].map((run) => outcomeSummary(decisionOf(input, run)));

        expect(identities[0]).toEqual(identities[1]);
        expect(retry).toHaveLength(1);
        expect(retry[0]?.evidence.originalContact).toEqual(first[0]?.evidence.originalContact);
      }),
  );

  it.effect(
    'AC-03 Scenario: a new recipient needs a new source request: it is decided by its own context, the first is kept',
    () =>
      Effect.gen(function* newRecipientNewRequest() {
        const firstInput = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')]);
        const first = yield* assess(firstInput, { 'contact-original': unusable('ORIGINAL_ENDPOINT_UNUSABLE') }).run;
        // The source owner authorizes a NEW request (new occurrence, own correlation) for a new recipient and contact.
        const secondInput = evaluationInput(single, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-b', 'contact-new')], {
          occurrenceId: 'fixture-occurrence-2',
        });
        const second = yield* assess(secondInput, { 'contact-new': usable(NEW_ADDRESS) }).run;

        expect(second[0]?.evidence).toMatchObject({
          authorization: 'RECIPIENT_ALLOWED',
          occurrence: { occurrenceId: 'fixture-occurrence-2' },
          recipientRef: { resourceId: 'recipient-b' },
        });
        expect(first[0]?.evidence).toMatchObject({
          authorization: 'RECIPIENT_NOT_ALLOWED',
          occurrence: { occurrenceId: 'fixture-occurrence-1' },
          recipientRef: { resourceId: 'recipient-a' },
        });
      }),
  );
});
