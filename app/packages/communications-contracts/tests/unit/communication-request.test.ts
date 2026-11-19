import { readFileSync } from 'node:fs';

import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CommunicationRequestSchema,
  CommunicationRequestScopeSchema,
  OriginalRecipientBindingSchema,
} from '../../src/communication-request.ts';
import type { CommunicationRequestEncoded } from '../../src/communication-request.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const recipientRef = {
  moduleId: 'party.registry',
  resourceId: 'contact-point-fixture-1',
  resourceType: 'party.registry.contact-point',
} as const;

const originalContact = {
  contactRef: {
    moduleId: 'party.registry',
    resourceId: 'contact-point-fixture-original',
    resourceType: 'party.registry.contact-point',
  },
  evidence: { kind: 'AUTHORITATIVE_REFERENCE' },
} as const;

const recipientBinding = {
  originalContact,
  recipientRef,
  role: 'original-recipient',
  scope: { tenantId },
  validAt: '2026-11-18T09:30:00.000Z',
} as const;

/** Clearly fictional fixture: no real copy, purpose catalog entry or recipient. */
const minimalRequest: CommunicationRequestEncoded = {
  idempotency: { key: 'fixture-occurrence-1:1' },
  occurrence: { occurrenceId: 'fixture-occurrence-1', revision: 1 },
  originalRecipients: [recipientBinding],
  purpose: 'fixture.purpose',
  safeReferences: [],
  schemaVersion: 1,
  scope: { tenantId },
  source: { moduleKey: 'fixture.source' },
};

const relatedOrder = {
  key: 'related-order',
  ref: { moduleId: 'commerce.order', resourceId: 'order-fixture-1', resourceType: 'commerce.order.order' },
} as const;

const fullRequest: CommunicationRequestEncoded = {
  ...minimalRequest,
  idempotency: { correlationId: 'fixture-correlation-1', key: 'fixture-occurrence-1:2' },
  occurrence: { occurrenceId: 'fixture-occurrence-1', revision: 2 },
  safeReferences: [relatedOrder],
  scope: {
    counterpartyRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'counterparty-fixture-1',
      resourceType: 'commerce.customer-context.counterparty',
    },
    legalEntityId,
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'profile-fixture-1',
      resourceType: 'commerce.customer-context.profile',
    },
    storefrontRef: {
      moduleId: 'storefront.registry',
      resourceId: 'storefront-fixture-1',
      resourceType: 'storefront.registry.storefront',
    },
    tenantId,
  },
};

const decode = Schema.decodeUnknownResult(CommunicationRequestSchema, { onExcessProperty: 'error' });
/** Candidates are plain JSON, exactly what a source would send over the wire. */
const accepted = (input: Schema.Json) => Result.isSuccess(decode(input));

const withTopLevel = (extra: Readonly<Record<string, Schema.Json>>) => ({ ...minimalRequest, ...extra });

describe('Communication Request contract', () => {
  it('accepts a request with only the required trusted scope', () => {
    expect(accepted(minimalRequest)).toBe(true);
  });

  it('accepts optional Legal Entity, profile, Counterparty and Storefront scope with safe references', () => {
    expect(accepted(fullRequest)).toBe(true);
  });

  it('round-trips through its encoded form without adding fields', () => {
    const decoded = Schema.decodeUnknownSync(CommunicationRequestSchema)(fullRequest);

    expect(Schema.encodeSync(CommunicationRequestSchema)(decoded)).toEqual(fullRequest);
  });

  it.each([
    ['tenant', { scope: {} }],
    ['source module', { source: {} }],
    ['purpose', { purpose: null }],
    ['occurrence revision', { occurrence: { occurrenceId: 'fixture-occurrence-1' } }],
    ['original recipient binding', { originalRecipients: [] }],
    ['original recipient binding list', { originalRecipients: null }],
    ['idempotency key', { idempotency: {} }],
    ['schema version', { schemaVersion: 2 }],
  ])('rejects a request without a valid %s', (_label, change) => {
    expect(accepted(withTopLevel(change))).toBe(false);
  });

  it.each([
    'body',
    'html',
    'language',
    'locale',
    'message',
    'messageType',
    'otp',
    'password',
    'recipient',
    'recipientAddress',
    'resetToken',
    'secret',
    'subject',
    'template',
    'templateId',
    'text',
    'to',
    'token',
  ])('does not let a source choose or carry %s at the top level', (field) => {
    expect(accepted(withTopLevel({ [field]: 'fixture' }))).toBe(false);
  });

  it.each(['email', 'address', 'language', 'locale', 'otp', 'token', 'secret', 'proof'])(
    'does not let a nested object carry %s',
    (field) => {
      expect(
        accepted({
          ...minimalRequest,
          originalRecipients: [{ ...recipientBinding, recipientRef: { ...recipientRef, [field]: 'fixture' } }],
        }),
      ).toBe(false);
      expect(accepted({ ...minimalRequest, scope: { [field]: 'fixture', tenantId } })).toBe(false);
      expect(accepted({ ...minimalRequest, idempotency: { [field]: 'fixture', key: 'fixture-1' } })).toBe(false);
    },
  );

  it.each([
    'person@example.test',
    'https://example.test/reset?token=fixture',
    'contains whitespace',
    'a/b',
    'dG9rZW4rZml4dHVyZT09+/==',
    '',
    'x'.repeat(201),
  ])('rejects %j as an opaque reference, so an address or encoded credential cannot hide in one', (value) => {
    expect(
      accepted({
        ...minimalRequest,
        originalRecipients: [{ ...recipientBinding, recipientRef: { ...recipientRef, resourceId: value } }],
      }),
    ).toBe(false);
    expect(
      accepted({
        ...minimalRequest,
        originalRecipients: [
          {
            ...recipientBinding,
            originalContact: { ...originalContact, contactRef: { ...originalContact.contactRef, resourceId: value } },
          },
        ],
      }),
    ).toBe(false);
    expect(accepted({ ...minimalRequest, occurrence: { occurrenceId: value, revision: 1 } })).toBe(false);
    expect(accepted({ ...minimalRequest, idempotency: { key: value } })).toBe(false);
  });

  it.each([0, -1, 1.5, 2_147_483_648])('rejects occurrence revision %s', (revision) => {
    expect(accepted({ ...minimalRequest, occurrence: { occurrenceId: 'fixture-occurrence-1', revision } })).toBe(false);
  });

  it.each(['Fixture.Purpose', 'fixture purpose', 'fixture.', '.fixture', 'fixture..purpose', ''])(
    'rejects %j as a purpose key',
    (purpose) => {
      expect(accepted(withTopLevel({ purpose }))).toBe(false);
    },
  );

  it('rejects a source module key that is not a dotted module identity', () => {
    expect(accepted({ ...minimalRequest, source: { moduleKey: 'Fixture_Source' } })).toBe(false);
    expect(accepted({ ...minimalRequest, source: { moduleKey: 'fixture' } })).toBe(false);
  });

  it('rejects a Tenant or Legal Entity that is not a UUID', () => {
    expect(accepted({ ...minimalRequest, scope: { tenantId: 'tenant-1' } })).toBe(false);
    expect(accepted({ ...minimalRequest, scope: { legalEntityId: 'not-a-uuid', tenantId } })).toBe(false);
  });

  it('rejects duplicate safe reference keys and more than sixteen safe references', () => {
    expect(accepted(withTopLevel({ safeReferences: [relatedOrder, relatedOrder] }))).toBe(false);
    expect(
      accepted(
        withTopLevel({
          safeReferences: Array.from({ length: 17 }, (_unused, index) => ({
            ...relatedOrder,
            key: `reference-${index}`,
          })),
        }),
      ),
    ).toBe(false);
  });
});

const withBinding = (change: Readonly<Record<string, Schema.Json>>) =>
  withTopLevel({ originalRecipients: [{ ...recipientBinding, ...change }] });
const withContact = (contact: Schema.Json) => withBinding({ originalContact: contact });
const bindingWithout = (key: string) =>
  withTopLevel({
    originalRecipients: [Object.fromEntries(Object.entries(recipientBinding).filter(([field]) => field !== key))],
  });

describe('#1395 original recipient binding', () => {
  it('Scenario: the three declared evidence kinds each bind the original contact without an address', () => {
    const evidences = [
      { kind: 'AUTHORITATIVE_REFERENCE' },
      { contactRevision: 3, kind: 'VERSIONED_SNAPSHOT' },
      {
        kind: 'HISTORICAL_SNAPSHOT',
        snapshotRef: {
          moduleId: 'party.registry',
          resourceId: 'snapshot-fixture-1',
          resourceType: 'party.registry.contact-snapshot',
        },
      },
    ];

    for (const evidence of evidences) {
      expect(accepted(withContact({ contactRef: originalContact.contactRef, evidence }))).toBe(true);
    }
  });

  it('Scenario: a source that cannot evidence the original contact sends none, and that is a valid request', () => {
    expect(accepted(bindingWithout('originalContact'))).toBe(true);
  });

  it('Scenario: 0..N original recipients are accepted with no numeric cap on the audience', () => {
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      ...recipientBinding,
      recipientRef: { ...recipientRef, resourceId: `contact-point-fixture-${index}` },
    }));

    expect(accepted(withTopLevel({ originalRecipients: many }))).toBe(true);
  });

  it.each([
    ['an unknown evidence kind', { contactRef: originalContact.contactRef, evidence: { kind: 'CURRENT_PROFILE' } }],
    [
      'a versioned snapshot without its revision',
      { contactRef: originalContact.contactRef, evidence: { kind: 'VERSIONED_SNAPSHOT' } },
    ],
    [
      'a versioned snapshot with revision zero',
      { contactRef: originalContact.contactRef, evidence: { contactRevision: 0, kind: 'VERSIONED_SNAPSHOT' } },
    ],
    [
      'a historical snapshot without its reference',
      { contactRef: originalContact.contactRef, evidence: { kind: 'HISTORICAL_SNAPSHOT' } },
    ],
    ['an address smuggled next to the contact', { ...originalContact, email: 'person@example.test' }],
    [
      'an address smuggled into the evidence',
      { ...originalContact, evidence: { address: 'person@example.test', kind: 'AUTHORITATIVE_REFERENCE' } },
    ],
  ])('rejects %s', (_label, contact) => {
    expect(accepted(withContact(contact))).toBe(false);
  });

  it.each([
    ['a missing audience role', bindingWithout('role')],
    ['a missing trusted scope', bindingWithout('scope')],
    ['a missing event instant', bindingWithout('validAt')],
    ['a role that is not a key', withBinding({ role: 'Original Recipient' })],
    ['a scope without its tenant', withBinding({ scope: {} })],
    ['an event instant that is not an ISO instant', withBinding({ validAt: 'yesterday' })],
    ['an address carried as a field of the binding', withBinding({ address: 'person@example.test' })],
  ])('rejects a binding with %s', (_label, request) => {
    expect(accepted(request)).toBe(false);
  });

  it('round-trips a binding with its event instant', () => {
    const decoded = Schema.decodeUnknownSync(CommunicationRequestSchema)(minimalRequest);

    expect(Schema.encodeSync(CommunicationRequestSchema)(decoded)).toEqual(minimalRequest);
  });
});

/**
 * Drift guard shared with the Communications domain. `original-recipients.fixture.json` is the encoded
 * `originalRecipients` payload; the domain binding schema decodes the very same file (`recipient-binding-contract`
 * test in `@app/communications`). A field added, renamed or loosened on one side breaks one of the two tests.
 */
const sharedFixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/original-recipients.fixture.json', import.meta.url), 'utf-8'),
);

describe('Original Recipient binding contract mirror', () => {
  const decodeBindings = Schema.decodeUnknownSync(Schema.NonEmptyArray(OriginalRecipientBindingSchema), {
    onExcessProperty: 'error',
  });

  it('decodes the shared payload and encodes it back unchanged', () => {
    expect(
      Schema.encodeSync(Schema.NonEmptyArray(OriginalRecipientBindingSchema))(decodeBindings(sharedFixture)),
    ).toEqual(sharedFixture);
  });

  it('keeps the field set the domain binding schema is pinned to', () => {
    expect(Object.keys(OriginalRecipientBindingSchema.fields).toSorted()).toEqual([
      'originalContact',
      'recipientRef',
      'role',
      'scope',
      'validAt',
    ]);
    expect(Object.keys(CommunicationRequestScopeSchema.fields).toSorted()).toEqual([
      'counterpartyRef',
      'legalEntityId',
      'profileRef',
      'storefrontRef',
      'tenantId',
    ]);
  });
});
