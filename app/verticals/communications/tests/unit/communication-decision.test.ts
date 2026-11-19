import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { approvedMessageTypeRegistry } from '../../src/domain/catalog/approved-registry.ts';
import { decideCommunication } from '../../src/domain/catalog/decision.ts';
import { CommunicationDecisionRequestSchema } from '../../src/domain/catalog/decision-request.ts';
import {
  approvedCommunicationDecisionLayer,
  communicationDecisionLayer,
  CommunicationDecisionService,
} from '../../src/domain/catalog/decision-service.ts';
import {
  FIXTURE_APPROVER_ROLE,
  FIXTURE_CLOSED_STATE,
  FIXTURE_ORIGINAL_ROLE,
  FIXTURE_SECONDARY_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureRequest,
  fixtureType,
  fixtureTypeNamed,
  nRecipientPolicyType,
  noMessageType,
  recipient,
  requiredTwoSlotType,
} from './support/catalog-fixtures.ts';
import { candidatesOf, outcomeSummary, pinOf, recipientSummary } from './support/summaries.ts';

const decodeRequest = Schema.decodeUnknownResult(CommunicationDecisionRequestSchema, { onExcessProperty: 'error' });

const registry = fixtureRegistry(fixtureType(), noMessageType, requiredTwoSlotType, nRecipientPolicyType);
const original = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original');
const secondary = recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary');

const decide = (purpose: string, ...recipients: Parameters<typeof fixtureContext>[0]) =>
  decideCommunication(registry, fixtureRequest({ purpose }), fixtureContext(recipients));

const stopped = (reason: 'PRIVACY_INDETERMINATE' | 'PRIVACY_NOT_ALLOWED') =>
  outcomeSummary(decide('fixture.single', recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', reason)));

const approvers = (count: number) =>
  Array.from({ length: count }, (_unused, index) => recipient(FIXTURE_APPROVER_ROLE, `approver-${index}`));

describe('#1394 Rule: the source of communication is only an authorized owner request', () => {
  it('Scenario: a source event with a request leads to the prescribed communication', () => {
    const request = fixtureRequest();
    const decision = decideCommunication(registry, request, fixtureContext([original]));

    // The explainable decision names the approved rule it used, and the candidate stays linked to the source request.
    expect(pinOf(decision)).toMatchObject({ requiredness: 'OPTIONAL', revision: 1, typeId: 'fixture.single-message' });
    expect(decision.request.occurrence).toEqual(request.occurrence);
    expect(decision.purpose).toBe('fixture.single');
    expect(candidatesOf(decision)).toHaveLength(1);
    expect(candidatesOf(decision)[0]).toMatchObject({
      identity: {
        occurrenceId: 'fixture-occurrence-1',
        revision: 1,
        slotKey: 'primary',
        typeId: 'fixture.single-message',
      },
      purpose: 'fixture.single',
    });
    expect(outcomeSummary(decision)).toMatchObject({
      candidates: [{ kind: 'Eligible', role: FIXTURE_ORIGINAL_ROLE }],
      kind: 'Candidates',
    });
  });

  it('Scenario: a domain event without a communication request sends no message', () => {
    // A confirmed business event has no occurrence, purpose or issuing owner, so it can never reach the evaluator.
    expect(Result.isFailure(decodeRequest({ eventType: 'fixture.order.confirmed', orderId: 'order-fixture-1' }))).toBe(
      true,
    );
  });

  it.each([
    ['template', { templateKey: 'fixture.template' }],
    ['recipient address', { recipientAddress: 'someone@example.invalid' }],
    ['language', { language: 'cs' }],
  ])('AC-01: a source never prescribes the final message, recipient, language or template (%s)', (_name, extra) => {
    expect(Result.isFailure(decodeRequest({ ...fixtureRequest(), ...extra }))).toBe(true);
    expect(Result.isSuccess(decodeRequest(fixtureRequest()))).toBe(true);
  });
});

describe('#1394 Rule: one request may have 0 to N results', () => {
  it('Scenario: an approved rule determines zero communication', () => {
    const decision = decide('fixture.quiet', original);

    // An explicit approved rule: no intent exists at all, and nothing here is a suppressed candidate.
    expect(outcomeSummary(decision)).toMatchObject({
      kind: 'NoMessage',
      reason: 'APPROVED_NO_MESSAGE',
      ruleKey: 'fixture.rule.quiet',
    });
    expect(candidatesOf(decision)).toEqual([]);
  });

  it('Scenario: an approved rule determines one message', () => {
    const decision = decide('fixture.single', original);

    expect(candidatesOf(decision)).toHaveLength(1);
    expect(candidatesOf(decision).map(recipientSummary)).toMatchObject([
      { kind: 'Eligible', resourceId: 'contact-original' },
    ]);
  });

  it('Scenario: an approved rule determines more messages', () => {
    const candidates = candidatesOf(decide('fixture.paired', original, secondary));

    expect(candidates.map(({ identity }) => identity.slotKey)).toEqual(['primary', 'secondary']);
    expect(candidates.map(recipientSummary)).toMatchObject([
      { kind: 'Eligible', resourceId: 'contact-original' },
      { kind: 'Eligible', resourceId: 'contact-secondary' },
    ]);
    // Each message is separately correlatable: no two candidates share an identity.
    expect(new Set(candidates.map(({ identity }) => JSON.stringify(identity))).size).toBe(2);
  });

  it('Scenario: an ambiguous audience does not turn into a broadcast', () => {
    const threeContacts = ['contact-a', 'contact-b', 'contact-c'].map((id) => recipient(FIXTURE_ORIGINAL_ROLE, id));
    const unnamedRole = ['contact-a', 'contact-b'].map((id) => recipient('fixture-company-contact', id));

    expect(outcomeSummary(decide('fixture.single', ...threeContacts))).toMatchObject({
      kind: 'NoMessage',
      reason: 'RECIPIENT_AUTHORITY_MISSING',
      unresolvedSlots: [{ reason: 'RECIPIENT_AMBIGUOUS', slotKey: 'primary' }],
    });
    expect(outcomeSummary(decide('fixture.single', ...unnamedRole))).toMatchObject({
      kind: 'NoMessage',
      reason: 'RECIPIENT_AUTHORITY_MISSING',
      unresolvedSlots: [{ reason: 'RECIPIENT_AUTHORITY_MISSING', slotKey: 'primary' }],
    });
  });

  it('AC-03: the approved N-recipient policy creates 0, 1 and N separately correlatable results', () => {
    const many = candidatesOf(decide('fixture.approvers', ...approvers(40)));

    expect(outcomeSummary(decide('fixture.approvers'))).toMatchObject({ kind: 'NoMessage' });
    expect(candidatesOf(decide('fixture.approvers', ...approvers(1)))).toHaveLength(1);
    expect(many).toHaveLength(40);
    expect(new Set(many.map(({ identity }) => identity.recipientResourceId)).size).toBe(40);
  });

  it('AC-03: one person is one message however many times the recipient algorithm names them', () => {
    const decision = decide(
      'fixture.approvers',
      recipient(FIXTURE_APPROVER_ROLE, 'approver-1'),
      recipient(FIXTURE_APPROVER_ROLE, 'approver-1'),
      recipient(FIXTURE_APPROVER_ROLE, 'approver-2'),
    );

    expect(candidatesOf(decision)).toHaveLength(2);
  });

  it('Scenario: missing basis for one candidate sends nothing to it and invents no fallback', () => {
    // The secondary slot has no recipient; a contact in an unrelated role is never used as a fallback for it.
    const decision = decide('fixture.paired', original, recipient('fixture-company-contact', 'contact-fallback'));

    expect(candidatesOf(decision)).toHaveLength(1);
    expect(outcomeSummary(decision)).toMatchObject({
      kind: 'Candidates',
      unresolvedSlots: [{ reason: 'RECIPIENT_AUTHORITY_MISSING', slotKey: 'secondary' }],
    });
  });
});

describe('#1394 Rule: the catalog is extended explicitly without a fixed quota', () => {
  const extended = fixtureRegistry(fixtureType(), fixtureTypeNamed('new-kind'));
  const decideExtended = (purpose: string) =>
    decideCommunication(extended, fixtureRequest({ purpose }), fixtureContext([original]));

  it('Scenario: a newly approved type uses the same decision boundaries', () => {
    expect(candidatesOf(decideExtended('fixture.new-kind'))).toHaveLength(1);
    expect(candidatesOf(decideExtended('fixture.single'))).toHaveLength(1);
  });

  it.each([
    ['unknown purpose', fixtureRequest({ purpose: 'fixture.unknown' }), fixtureType(), 'UNKNOWN_PURPOSE'],
    ['deactivated type', fixtureRequest(), fixtureType({ status: 'DEACTIVATED' }), 'TYPE_DEACTIVATED'],
    ['stale type', fixtureRequest(), fixtureType({ status: 'STALE' }), 'TYPE_STALE'],
    [
      'inactive source onboarding',
      fixtureRequest(),
      fixtureType({ onboarding: 'NOT_ACTIVATED' }),
      'SOURCE_ONBOARDING_INACTIVE',
    ],
    [
      'request from a source that does not own the type',
      fixtureRequest({ moduleKey: 'fixture.other-source' }),
      fixtureType(),
      'SOURCE_NOT_AUTHORIZED_FOR_TYPE',
    ],
  ] as const)(
    'Scenario: an unknown or inactive purpose does not open delivery (%s)',
    (_name, request, type, reason) => {
      // Recipients are present on purpose: an addressable audience never rescues an inadmissible purpose.
      const decision = decideCommunication(fixtureRegistry(type), request, fixtureContext([original]));

      expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason });
      expect(candidatesOf(decision)).toEqual([]);
    },
  );

  it('Scenario: a not yet activated future domain does not send on its own', () => {
    // A future owner declares its type but has no activated communication-request producer.
    const futureRegistry = fixtureRegistry(fixtureTypeNamed('future-owner', { onboarding: 'NOT_ACTIVATED' }));
    const decision = decideCommunication(
      futureRegistry,
      fixtureRequest({ purpose: 'fixture.future-owner' }),
      fixtureContext([original]),
    );

    expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason: 'SOURCE_ONBOARDING_INACTIVE' });
  });

  it('AC-02: the production approved registry approves no purpose, so every request ends in no message', () => {
    const decision = decideCommunication(approvedMessageTypeRegistry, fixtureRequest(), fixtureContext([original]));

    expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason: 'UNKNOWN_PURPOSE' });
    expect(Option.isNone(decision.type)).toBe(true);
  });
});

describe('#1394 Rule: an approved request does not overcome current prohibitions', () => {
  it('Scenario: an invitation was revoked before handoff', () => {
    const request = fixtureRequest();
    const beforeRevoke = decideCommunication(registry, request, fixtureContext([original]));
    // Delayed or retried processing re-evaluates against the current source state and now stops (AC-06).
    const afterRevoke = decideCommunication(
      registry,
      request,
      fixtureContext([original], { state: FIXTURE_CLOSED_STATE }),
    );

    expect(candidatesOf(beforeRevoke)).toHaveLength(1);
    expect(outcomeSummary(afterRevoke)).toMatchObject({ kind: 'NoMessage', reason: 'SOURCE_STATE_INELIGIBLE' });
  });

  it('AC-06: a superseded source revision is stale, while a type that tolerates it still proceeds', () => {
    const request = fixtureRequest({ revision: 1 });
    const newerSource = fixtureContext([original], { latestRevision: 2 });
    const tolerant = fixtureRegistry(fixtureType({ currentness: { requireLatestSourceRevision: false } }));

    expect(outcomeSummary(decideCommunication(registry, request, newerSource))).toMatchObject({
      kind: 'NoMessage',
      reason: 'SOURCE_REVISION_NOT_CURRENT',
    });
    expect(candidatesOf(decideCommunication(tolerant, request, newerSource))).toHaveLength(1);
  });

  it('Scenario: Privacy is neither allowed nor determinable', () => {
    // Uncertainty is never turned into a proven prohibition, and neither is handed over.
    expect(stopped('PRIVACY_INDETERMINATE')).toMatchObject({
      candidates: [{ kind: 'Suppressed', reason: 'PRIVACY_INDETERMINATE' }],
      kind: 'Candidates',
    });
    expect(stopped('PRIVACY_NOT_ALLOWED')).toMatchObject({
      candidates: [{ kind: 'Suppressed', reason: 'PRIVACY_NOT_ALLOWED' }],
      kind: 'Candidates',
    });
  });

  it('Scenario: every candidate was suppressed', () => {
    const decision = decide(
      'fixture.paired',
      recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', 'PRIVACY_NOT_ALLOWED'),
      recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary', 'RECIPIENT_NOT_ELIGIBLE'),
    );

    // Two individual suppression reasons on two concrete candidates, not the catalog's no-message.
    expect(outcomeSummary(decision)).toMatchObject({
      candidates: [
        { kind: 'Suppressed', reason: 'PRIVACY_NOT_ALLOWED' },
        { kind: 'Suppressed', reason: 'RECIPIENT_NOT_ELIGIBLE' },
      ],
      kind: 'Candidates',
    });
  });
});

describe('#1394 Rule: repetition must not create independent duplicate messages', () => {
  it('Scenario: an identical source request arrives again (AC-07 evaluation part)', () => {
    const first = decideCommunication(registry, fixtureRequest(), fixtureContext([original]));
    const replay = decideCommunication(registry, fixtureRequest(), fixtureContext([original]));

    // The same occurrence yields the same decision and the same candidate identities; durable idempotency is d21-07.
    expect(replay).toEqual(first);
  });

  it('Scenario: the catalog changed after the first decision keeps the first decision explainable', () => {
    const first = decideCommunication(registry, fixtureRequest(), fixtureContext([original]));
    const revised = decideCommunication(
      fixtureRegistry(fixtureType({ revision: 2 })),
      fixtureRequest(),
      fixtureContext([original]),
    );

    // The pinned type revision is what lets the durable layer prove which revision made the first decision.
    expect(pinOf(first)?.revision).toBe(1);
    expect(pinOf(revised)?.revision).toBe(2);
  });
});

describe('#1394 Communication Decision service', () => {
  it.effect('decides through the owner-local service over the registry it was composed with', () =>
    Effect.gen(function* decidesOverComposedRegistry() {
      const service = yield* CommunicationDecisionService;
      const decision = yield* service.decide(fixtureRequest(), fixtureContext([original]));

      expect(candidatesOf(decision)).toHaveLength(1);
    }).pipe(Effect.provide(communicationDecisionLayer(registry))),
  );

  it.effect('the production composition approves nothing', () =>
    Effect.gen(function* productionApprovesNothing() {
      const service = yield* CommunicationDecisionService;
      const decision = yield* service.decide(fixtureRequest(), fixtureContext([original]));

      expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason: 'UNKNOWN_PURPOSE' });
    }).pipe(Effect.provide(approvedCommunicationDecisionLayer)),
  );
});
