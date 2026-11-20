import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationContextMismatch, decideCommunication } from '../../src/domain/catalog/decision.ts';
import { CommunicationDecisionRequestSchema, RecipientFactSchema } from '../../src/domain/catalog/decision-request.ts';
import {
  approvedCommunicationDecisionLayer,
  communicationDecisionLayer,
  CommunicationDecisionService,
} from '../../src/domain/catalog/decision-service.ts';
import {
  decideOrThrow,
  FIXTURE_APPROVER_ROLE,
  FIXTURE_CLOSED_STATE,
  FIXTURE_OCCURRENCE_ID,
  FIXTURE_ORIGINAL_ROLE,
  FIXTURE_OTHER_TENANT_ID,
  FIXTURE_SECONDARY_ROLE,
  FIXTURE_TENANT_ID,
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

const decodeRequest = Schema.decodeUnknownResult(CommunicationDecisionRequestSchema);
const decodeFact = Schema.decodeUnknownResult(RecipientFactSchema);

const registry = fixtureRegistry(fixtureType(), noMessageType, requiredTwoSlotType, nRecipientPolicyType);
const original = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original');
const secondary = recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary');

const decide = (purpose: string, ...recipients: Parameters<typeof fixtureContext>[0]) =>
  decideOrThrow(registry, fixtureRequest({ purpose }), fixtureContext(recipients));

const stopped = (reason: 'PRIVACY_INDETERMINATE' | 'PRIVACY_NOT_ALLOWED') =>
  outcomeSummary(decide('fixture.single', recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', reason)));

const summaries = (...facts: Parameters<typeof fixtureContext>[0]) =>
  outcomeSummary(decide('fixture.single', ...facts));
const summaryFor = (ordered: Parameters<typeof fixtureContext>[0]) =>
  outcomeSummary(decide('fixture.approvers', ...ordered));
const sameId = (moduleId: string, resourceType: string) =>
  recipient(FIXTURE_APPROVER_ROLE, 'shared-id', undefined, { moduleId, resourceType });
const identities = (...facts: Parameters<typeof fixtureContext>[0]) =>
  candidatesOf(decide('fixture.approvers', ...facts)).map(({ identity }) => identity);
const mismatchesFor = (...args: Parameters<typeof fixtureContext>) =>
  Option.getOrThrow(Result.getFailure(decideCommunication(registry, fixtureRequest(), fixtureContext(...args))));

const approvers = (count: number) =>
  Array.from({ length: count }, (_unused, index) => recipient(FIXTURE_APPROVER_ROLE, `approver-${index}`));

describe('#1394 Rule: the source of communication is only an authorized owner request', () => {
  it('Scenario: a source event with a request leads to the prescribed communication', () => {
    const request = fixtureRequest();
    const decision = decideOrThrow(registry, request, fixtureContext([original]));

    // The explainable decision names the approved rule it used, and the candidate stays linked to the source request.
    expect(pinOf(decision)).toMatchObject({ requiredness: 'OPTIONAL', revision: 1, typeId: 'fixture.single-message' });
    expect(decision.request.occurrence).toEqual(request.occurrence);
    expect(decision.purpose).toBe('fixture.single');
    expect(candidatesOf(decision)).toHaveLength(1);
    expect(candidatesOf(decision)[0]).toMatchObject({
      identity: {
        occurrenceId: 'fixture-occurrence-1',
        recipient: { moduleId: 'fixture.party', resourceId: 'contact-original', resourceType: 'fixture.contact-point' },
        revision: 1,
        slotKey: 'primary',
        sourceModule: 'fixture.source',
        tenantId: FIXTURE_TENANT_ID,
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
    const bareEvent = { eventType: 'fixture.order.confirmed', orderId: 'order-fixture-1' };
    // @ts-expect-error The evaluator input type requires a decoded request; a bare domain event is not one.
    const evaluateBareEvent = () => decideCommunication(registry, bareEvent, fixtureContext([]));

    // The only way to obtain a request is decoding it, and a bare event has no occurrence, purpose, issuer or tenant.
    expect(Object.keys(CommunicationDecisionRequestSchema.fields).toSorted()).toEqual([
      'occurrence',
      'purpose',
      'source',
      'tenantId',
    ]);
    expect(Result.isFailure(decodeRequest(bareEvent))).toBe(true);
    expect(evaluateBareEvent).toBeInstanceOf(Function);
  });

  it('AC-01 (schema key space): a request has no field for a final message, recipient, language or template', () => {
    // Rejecting unknown properties is a decoder option of the intake Action (a later plan), which owns that claim;
    // here only the request shape the evaluator consumes is proven to have no such field.
    const fields = Object.keys(CommunicationDecisionRequestSchema.fields);

    for (const forbidden of ['template', 'recipient', 'address', 'email', 'language', 'locale', 'message']) {
      expect(fields.filter((field) => field.toLowerCase().includes(forbidden))).toEqual([]);
    }
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
    expect(new Set(many.map(({ identity }) => identity.recipient.resourceId)).size).toBe(40);
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
    decideOrThrow(extended, fixtureRequest({ purpose }), fixtureContext([original]));

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
      const decision = decideOrThrow(fixtureRegistry(type), request, fixtureContext([original]));

      expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason });
      expect(candidatesOf(decision)).toEqual([]);
    },
  );

  it('Scenario: a not yet activated future domain does not send on its own', () => {
    // A future owner declares its type but has no activated communication-request producer.
    const futureRegistry = fixtureRegistry(fixtureTypeNamed('future-owner', { onboarding: 'NOT_ACTIVATED' }));
    const decision = decideOrThrow(
      futureRegistry,
      fixtureRequest({ purpose: 'fixture.future-owner' }),
      fixtureContext([original]),
    );

    expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason: 'SOURCE_ONBOARDING_INACTIVE' });
  });
});

describe('#1394 Rule: an approved request does not overcome current prohibitions', () => {
  it('Scenario: an invitation was revoked before handoff', () => {
    // BR-08: a stale source stops the handoff and records the stale-source reason; the source owner decides the rest.
    const request = fixtureRequest();
    const beforeRevoke = decideOrThrow(registry, request, fixtureContext([original]));
    // Delayed or retried processing re-evaluates against the current source state and now stops (AC-06).
    const afterRevoke = decideOrThrow(registry, request, fixtureContext([original], { state: FIXTURE_CLOSED_STATE }));

    expect(candidatesOf(beforeRevoke)).toHaveLength(1);
    expect(outcomeSummary(afterRevoke)).toMatchObject({ kind: 'NoMessage', reason: 'SOURCE_STATE_INELIGIBLE' });
  });

  it('AC-06: a superseded source revision is stale, while a type that tolerates it still proceeds', () => {
    const request = fixtureRequest({ revision: 1 });
    const newerSource = fixtureContext([original], { latestRevision: 2 });
    const tolerant = fixtureRegistry(fixtureType({ currentness: { requireLatestSourceRevision: false } }));

    expect(outcomeSummary(decideOrThrow(registry, request, newerSource))).toMatchObject({
      kind: 'NoMessage',
      reason: 'SOURCE_REVISION_NOT_CURRENT',
    });
    expect(candidatesOf(decideOrThrow(tolerant, request, newerSource))).toHaveLength(1);
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
    const first = decideOrThrow(registry, fixtureRequest(), fixtureContext([original]));
    const replay = decideOrThrow(registry, fixtureRequest(), fixtureContext([original]));

    // The same occurrence yields the same decision and the same candidate identities; durable idempotency is d21-07.
    expect(replay).toEqual(first);
  });

  it('the decision pins the type revision it was made under (durable first-decision proof is deferred to #1401)', () => {
    const first = decideOrThrow(registry, fixtureRequest(), fixtureContext([original]));
    const revised = decideOrThrow(
      fixtureRegistry(fixtureType({ revision: 2 })),
      fixtureRequest(),
      fixtureContext([original]),
    );

    // Only the pinned revision inside each decision is proven here; persisting the first decision of an occurrence
    // and refusing to re-decide it under a newer revision belongs to #1401.
    expect(pinOf(first)?.revision).toBe(1);
    expect(pinOf(revised)?.revision).toBe(2);
  });
});

describe('#1394 Rule: Privacy evidence is positive and never assumed', () => {
  const { privacy: _privacy, ...withoutPrivacy } = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original');

  it('a recipient fact without Privacy evidence cannot be built, so a caller that never asked Privacy is not eligible', () => {
    expect(Result.isFailure(decodeFact(withoutPrivacy))).toBe(true);
    expect(Result.isFailure(decodeFact({ ...withoutPrivacy, privacy: 'ASSUMED' }))).toBe(true);
    expect(Result.isSuccess(decodeFact({ ...withoutPrivacy, privacy: 'ALLOWED' }))).toBe(true);
  });

  it('only an explicit ALLOWED with no other stop is eligible; NOT_ALLOWED and INDETERMINATE stay distinct', () => {
    expect(summaries(recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original'))).toMatchObject({
      candidates: [{ kind: 'Eligible' }],
    });
    expect(
      summaries(recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', undefined, { privacy: 'NOT_ALLOWED' })),
    ).toMatchObject({ candidates: [{ kind: 'Suppressed', reason: 'PRIVACY_NOT_ALLOWED' }] });
    expect(
      summaries(recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', undefined, { privacy: 'INDETERMINATE' })),
    ).toMatchObject({ candidates: [{ kind: 'Suppressed', reason: 'PRIVACY_INDETERMINATE' }] });
    // Privacy ALLOWED does not outrank a recipient stop.
    expect(summaries(recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', 'RECIPIENT_BASIS_MISSING'))).toMatchObject({
      candidates: [{ kind: 'Suppressed', reason: 'RECIPIENT_BASIS_MISSING' }],
    });
  });
});

describe('#1394 Rule: candidate identity is collision-free and independent of input order', () => {
  it('two recipients sharing a resource id but not module or type in one slot get distinct identities', () => {
    const found = identities(
      sameId('fixture.party', 'fixture.contact-point'),
      sameId('fixture.party', 'fixture.person'),
      sameId('fixture.other-party', 'fixture.contact-point'),
    );

    expect(found).toHaveLength(3);
    expect(new Set(found.map((identity) => JSON.stringify(identity))).size).toBe(3);
    expect(found.map(({ recipient: ref }) => `${ref.moduleId}|${ref.resourceType}`).toSorted()).toEqual([
      'fixture.other-party|fixture.contact-point',
      'fixture.party|fixture.contact-point',
      'fixture.party|fixture.person',
    ]);
  });

  it('names tenant, source module, occurrence, revision, type, slot and the full recipient reference', () => {
    const [identity] = identities(recipient(FIXTURE_APPROVER_ROLE, 'approver-1'));

    expect(identity).toEqual({
      occurrenceId: FIXTURE_OCCURRENCE_ID,
      recipient: { moduleId: 'fixture.party', resourceId: 'approver-1', resourceType: 'fixture.contact-point' },
      revision: 1,
      slotKey: 'approvers',
      sourceModule: 'fixture.source',
      tenantId: FIXTURE_TENANT_ID,
      typeId: 'fixture.approvers-message',
    });
  });

  it('does not depend on the order the recipient facts arrive in', () => {
    const facts = [
      sameId('fixture.party', 'fixture.person'),
      recipient(FIXTURE_APPROVER_ROLE, 'approver-2'),
      sameId('fixture.other-party', 'fixture.contact-point'),
      recipient(FIXTURE_APPROVER_ROLE, 'approver-1'),
    ];
    const forward = decide('fixture.approvers', ...facts);

    expect(decide('fixture.approvers', ...facts.toReversed())).toEqual(forward);
    expect(decide('fixture.approvers', ...facts.toSpliced(0, 0, ...facts.slice(2)))).toEqual(forward);
    expect(candidatesOf(forward).map(({ identity }) => identity.recipient.moduleId)).toEqual([
      'fixture.other-party',
      'fixture.party',
      'fixture.party',
      'fixture.party',
    ]);
  });

  it('keeps the winning stop reason independent of order when duplicate facts disagree', () => {
    const facts = [
      recipient(FIXTURE_APPROVER_ROLE, 'approver-1'),
      recipient(FIXTURE_APPROVER_ROLE, 'approver-1', 'RECIPIENT_BASIS_MISSING'),
      recipient(FIXTURE_APPROVER_ROLE, 'approver-1', 'PRIVACY_INDETERMINATE'),
      recipient(FIXTURE_APPROVER_ROLE, 'approver-1', 'RECIPIENT_NOT_ELIGIBLE'),
    ];
    const permutations = [facts, facts.toReversed(), [...facts.slice(2), ...facts.slice(0, 2)]];

    // Privacy INDETERMINATE outranks the recipient stops and an ALLOWED duplicate; NOT_ALLOWED would outrank it.
    for (const ordered of permutations) {
      expect(summaryFor(ordered)).toMatchObject({
        candidates: [{ kind: 'Suppressed', reason: 'PRIVACY_INDETERMINATE' }],
      });
    }
    const withProhibition = [...facts, recipient(FIXTURE_APPROVER_ROLE, 'approver-1', 'PRIVACY_NOT_ALLOWED')];
    for (const ordered of [withProhibition, withProhibition.toReversed()]) {
      expect(summaryFor(ordered)).toMatchObject({
        candidates: [{ kind: 'Suppressed', reason: 'PRIVACY_NOT_ALLOWED' }],
      });
    }
  });
});

describe('#1394 Rule: facts must belong to the request they are evaluated for', () => {
  it('rejects source facts read for another occurrence', () => {
    const failure = mismatchesFor([original], { occurrenceId: 'fixture-occurrence-2' });

    expect(failure).toBeInstanceOf(CommunicationContextMismatch);
    expect(failure.mismatches).toEqual([{ fact: 'SOURCE_FACTS', field: 'occurrenceId' }]);
  });

  it('rejects a recipient fact gathered for another occurrence', () => {
    const failure = mismatchesFor([
      recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', undefined, { occurrenceId: 'fixture-occurrence-2' }),
    ]);

    expect(failure.mismatches).toEqual([{ fact: 'RECIPIENT_FACT', field: 'occurrenceId' }]);
  });

  it('rejects source facts and a recipient fact from another tenant', () => {
    const failure = mismatchesFor(
      [recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', undefined, { tenantId: FIXTURE_OTHER_TENANT_ID })],
      { tenantId: FIXTURE_OTHER_TENANT_ID },
    );

    expect(failure.mismatches).toEqual([
      { fact: 'SOURCE_FACTS', field: 'tenantId' },
      { fact: 'RECIPIENT_FACT', field: 'tenantId' },
    ]);
  });

  it.effect('the service fails with the typed mismatch and decides nothing', () =>
    Effect.gen(function* serviceRejectsMismatch() {
      const service = yield* CommunicationDecisionService;
      const failure = yield* Effect.flip(
        service.decide(fixtureRequest(), fixtureContext([original], { tenantId: FIXTURE_OTHER_TENANT_ID })),
      );

      expect(failure).toBeInstanceOf(CommunicationContextMismatch);
    }).pipe(Effect.provide(communicationDecisionLayer(registry))),
  );
});

describe('#1394 Rule: another owner type is never described to the issuer', () => {
  it('SOURCE_NOT_AUTHORIZED_FOR_TYPE returns no type pin', () => {
    const decision = decideOrThrow(
      registry,
      fixtureRequest({ moduleKey: 'fixture.other-source', purpose: 'fixture.paired' }),
      fixtureContext([original, secondary]),
    );

    expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason: 'SOURCE_NOT_AUTHORIZED_FOR_TYPE' });
    expect(Option.isNone(decision.type)).toBe(true);
    // Nothing of the required type (id, requiredness, Privacy purposes) is reachable from the decision.
    expect(JSON.stringify(decision)).not.toMatch(/fixture\.paired-message|REQUIRED|fixture\.privacy\.purpose/u);
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

  it.effect('the production composition approves no purpose but the three Portal Auth ones', () =>
    Effect.gen(function* productionApprovesNothing() {
      const service = yield* CommunicationDecisionService;
      const decision = yield* service.decide(fixtureRequest(), fixtureContext([original]));

      expect(outcomeSummary(decision)).toMatchObject({ kind: 'NoMessage', reason: 'UNKNOWN_PURPOSE' });
    }).pipe(Effect.provide(approvedCommunicationDecisionLayer)),
  );
});
