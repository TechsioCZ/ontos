import { describe, expect, it } from 'effect-rstest';

import { bindOriginalRecipients } from '../../src/domain/recipient/bind-original-recipients.ts';
import type { BindingStage } from '../../src/domain/recipient/bind-original-recipients.ts';
import {
  FIXTURE_APPROVER_ROLE,
  FIXTURE_ORIGINAL_ROLE,
  fixtureContactSource,
  fixtureSlot,
  fixtureType,
  fixtureTypeNamed,
  nRecipientPolicyType,
  noMessageType,
} from './support/catalog-fixtures.ts';
import { binding, FIXTURE_EVENT_TIME, fixtureScope } from './support/recipient-fixtures.ts';
import { assessmentSummary } from './support/summaries.ts';

const view = (stage: BindingStage) =>
  stage.kind === 'bound'
    ? {
        contact: stage.contact.contactRef.resourceId,
        kind: 'bound' as const,
        recipient: stage.subject.binding.recipientRef.resourceId,
      }
    : { kind: 'settled' as const, ...assessmentSummary(stage.assessment) };

const bind = (
  type: ReturnType<typeof fixtureType>,
  bindings: Parameters<typeof bindOriginalRecipients>[2],
  scope = fixtureScope(),
) => bindOriginalRecipients(type, scope, bindings).map(view);

const original = fixtureType();
const typeAccepting = (evidenceKinds: readonly string[]) =>
  fixtureTypeNamed('declared', {
    result: {
      kind: 'MESSAGE_INTENTS',
      slots: [fixtureSlot('primary', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE', fixtureContactSource(evidenceKinds))],
    },
  });

describe('#1395 Rule: the source binds the original recipient and endpoint to the original event (BR-01, BR-02)', () => {
  it('AC-01 Scenario: a recipient with a declared contact in the trusted scope is bound to exactly that contact', () => {
    expect(bind(original, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-original')])).toEqual([
      { contact: 'contact-original', kind: 'bound', recipient: 'recipient-a' },
    ]);
  });

  it('keeps the event instant the source fixed on the bound recipient', () => {
    const [stage] = bindOriginalRecipients(original, fixtureScope(), [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a')]);

    expect(stage?.kind === 'bound' ? stage.subject.binding.validAt.epochMilliseconds : undefined).toBe(
      Date.parse(FIXTURE_EVENT_TIME),
    );
  });

  it.each([
    [
      'HISTORICAL_SNAPSHOT',
      {
        kind: 'HISTORICAL_SNAPSHOT',
        snapshotRef: { moduleId: 'fixture.party', resourceId: 'snapshot-1', resourceType: 'fixture.snapshot' },
      },
    ],
    ['VERSIONED_SNAPSHOT', { contactRevision: 4, kind: 'VERSIONED_SNAPSHOT' }],
    ['AUTHORITATIVE_REFERENCE', { kind: 'AUTHORITATIVE_REFERENCE' }],
  ] as const)('a type declaring %s accepts exactly that evidence from its owner', (kind, evidence) => {
    const type = typeAccepting([kind]);

    expect(bind(type, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a', { evidence })])).toEqual([
      { contact: 'contact-a', kind: 'bound', recipient: 'recipient-a' },
    ]);
  });

  it('Scenario: evidence of a kind the type does not declare is recipient-unresolved, never accepted', () => {
    const type = typeAccepting(['AUTHORITATIVE_REFERENCE']);

    expect(bind(type, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a')])).toEqual([
      {
        kind: 'settled',
        outcome: 'recipient-unresolved',
        reason: 'EVIDENCE_KIND_NOT_DECLARED',
        recipient: 'recipient-a',
      },
    ]);
  });

  it.each([
    ['another owner', { contactOwner: 'fixture.other-owner' }],
    ['another resource type', { contactResourceType: 'fixture.other-contact' }],
  ])('Scenario: a contact from %s than the type declares is recipient-unresolved', (_label, overrides) => {
    expect(bind(original, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a', overrides)])).toEqual([
      {
        kind: 'settled',
        outcome: 'recipient-unresolved',
        reason: 'CONTACT_SOURCE_NOT_DECLARED',
        recipient: 'recipient-a',
      },
    ]);
  });
});

describe('#1395 Rule: the original contact is never reconstructed (BR-04, BR-08)', () => {
  it('Scenario: a source request without an evidenced original endpoint is recipient-unresolved', () => {
    expect(bind(original, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', null)])).toEqual([
      {
        kind: 'settled',
        outcome: 'recipient-unresolved',
        reason: 'ORIGINAL_CONTACT_NOT_EVIDENCED',
        recipient: 'recipient-a',
      },
    ]);
  });

  it('Scenario: the same recipient with two different original contacts is ambiguous and none is picked', () => {
    const stages = bindOriginalRecipients(original, fixtureScope(), [
      binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-one'),
      binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-two'),
    ]);

    expect(stages.map(view)).toEqual([
      {
        kind: 'settled',
        outcome: 'recipient-unresolved',
        reason: 'ORIGINAL_CONTACT_AMBIGUOUS',
        recipient: 'recipient-a',
      },
    ]);
    // The ambiguous recipient names no contact at all, so neither can leak into evidence.
    expect(JSON.stringify(stages)).not.toMatch(/contact-one|contact-two/u);
  });

  it('a contact for one source and none for the other is ambiguous too, not "use the one we have"', () => {
    expect(
      bind(original, [
        binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-one'),
        binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', null),
      ]),
    ).toEqual([
      {
        kind: 'settled',
        outcome: 'recipient-unresolved',
        reason: 'ORIGINAL_CONTACT_AMBIGUOUS',
        recipient: 'recipient-a',
      },
    ]);
  });

  it('BR-10: the same recipient repeated with the same contact is one recipient, not a second message', () => {
    const same = binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a');

    expect(bind(original, [same, same])).toHaveLength(1);
  });

  it('Scenario: several possible people without an approved slot for their role never become an audience', () => {
    expect(
      bind(original, [binding('fixture-bystander', 'recipient-x'), binding('fixture-bystander', 'recipient-y')]),
    ).toEqual([]);
  });

  it('an approved zero-message type has no audience to bind', () => {
    expect(bind(noMessageType, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a')])).toEqual([]);
  });

  it('AC-04: every recipient of an approved N-recipient slot is bound on its own, whatever the input order', () => {
    const three = ['approver-b', 'approver-a', 'approver-c'].map((id) => binding(FIXTURE_APPROVER_ROLE, id));

    expect(bind(nRecipientPolicyType, three).map(({ recipient }) => recipient)).toEqual([
      'approver-a',
      'approver-b',
      'approver-c',
    ]);
    expect(bind(nRecipientPolicyType, three.toReversed())).toEqual(bind(nRecipientPolicyType, three));
  });
});

const withScope = (scope: ReturnType<typeof fixtureScope>) => [
  binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a', { scope }),
];

describe('#1395 Rule: a contact evidenced in another scope is never used (BR-09, AC-06)', () => {
  const notAllowed = [
    { kind: 'settled', outcome: 'recipient-not-allowed', reason: 'SCOPE_MISMATCH', recipient: 'recipient-a' },
  ];

  it('Scenario: a contact evidenced only for another tenant is not allowed', () => {
    expect(bind(original, withScope(fixtureScope({ tenantId: '22222222-2222-4222-8222-222222222222' })))).toEqual(
      notAllowed,
    );
  });

  it('Scenario: a contact evidenced for another profile is not allowed, even when the address would be the same', () => {
    expect(
      bind(original, withScope(fixtureScope({ profileId: 'profile-b' })), fixtureScope({ profileId: 'profile-a' })),
    ).toEqual(notAllowed);
  });

  it('a contact evidenced without the profile the request names is not allowed either', () => {
    expect(bind(original, withScope(fixtureScope()), fixtureScope({ profileId: 'profile-a' }))).toEqual(notAllowed);
  });

  it('a Counterparty, Storefront or Legal Entity that differs by one dimension is a different scope', () => {
    const counterparty = fixtureScope({ counterpartyId: 'counterparty-x' });
    const legalEntity = fixtureScope({ legalEntityId: '33333333-3333-4333-8333-333333333333' });

    expect(bind(original, withScope(counterparty))).toEqual(notAllowed);
    expect(bind(original, withScope(fixtureScope()), counterparty)).toEqual(notAllowed);
    expect(bind(original, withScope(legalEntity))).toEqual(notAllowed);
    expect(bind(original, withScope(fixtureScope()), legalEntity)).toEqual(notAllowed);
  });

  it('does not echo the foreign contact into the request: the mismatching recipient names no contact', () => {
    const stages = bindOriginalRecipients(
      original,
      fixtureScope(),
      withScope(fixtureScope({ profileId: 'profile-b' })),
    );

    expect(JSON.stringify(stages)).not.toContain('contact-a');
  });
});
