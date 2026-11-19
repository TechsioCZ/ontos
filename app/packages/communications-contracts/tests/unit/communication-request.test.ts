import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationRequestSchema } from '../../src/communication-request.ts';
import type { CommunicationRequestEncoded } from '../../src/communication-request.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const recipientRef = {
  moduleId: 'party.registry',
  resourceId: 'contact-point-fixture-1',
  resourceType: 'party.registry.contact-point',
} as const;

/** Clearly fictional fixture: no real copy, purpose catalog entry or recipient. */
const minimalRequest: CommunicationRequestEncoded = {
  idempotency: { key: 'fixture-occurrence-1:1' },
  occurrence: { occurrenceId: 'fixture-occurrence-1', revision: 1 },
  originalRecipientRef: recipientRef,
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
    ['original recipient reference', { originalRecipientRef: null }],
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
      expect(accepted({ ...minimalRequest, originalRecipientRef: { ...recipientRef, [field]: 'fixture' } })).toBe(
        false,
      );
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
    expect(accepted({ ...minimalRequest, originalRecipientRef: { ...recipientRef, resourceId: value } })).toBe(false);
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
