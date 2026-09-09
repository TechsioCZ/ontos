import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AddressContactPointValueSchema,
  AddressContactPointInputSchema,
  ContactPointEndSchema,
  ContactPointInputSchema,
  EmailContactPointInputSchema,
  PhoneContactPointInputSchema,
  normalizeAddress,
  normalizeEmail,
  normalizePhone,
  assertAddressPurposeRules,
} from '../../shared/domain/contact-point.ts';
import { OutboxPayloadSchema as ContactPointAddedOutboxPayloadSchema } from '../../shared/outbox/party-registry-contact-point-added-v1.ts';
import { AddContactPointPayloadSchema, addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { EndContactPointPayloadSchema, endContactPointAction } from '../../src/actions/end-contact-point.action.ts';
import {
  UpdateContactPointPayloadSchema,
  updateContactPointAction,
} from '../../src/actions/update-contact-point.action.ts';
import { partyContactPointDetailRead } from '../../src/api/party-contact-point-detail.read.ts';
import { partyContactPointsRead } from '../../src/api/party-contact-points.read.ts';

const partyRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId: '20000000-0000-4000-8000-000000000001',
} as const;
const provenance = {
  authoritative: false,
  method: 'MANUAL_CONFIRMATION',
  source: 'USER_ASSERTION',
} as const;
it('normalizes EMAIL without provider-specific identity heuristics', () => {
  expect(normalizeEmail('  Qa.Test+case@EXAMPLE.COM  ')).toEqual({
    displayValue: 'Qa.Test+case@EXAMPLE.COM',
    lookupValue: 'Qa.Test+case@example.com',
  });
  expect(normalizeEmail('qa.test+one@example.com').lookupValue).not.toBe(
    normalizeEmail('qatest+two@example.com').lookupValue,
  );
  expect(() =>
    Schema.decodeSync(EmailContactPointInputSchema)({
      preferred: false,
      type: 'EMAIL',
      value: 'not-an-email',
    }),
  ).toThrow();
});
it('normalizes PHONE only with explicit international or country context and preserves extension', () => {
  expect(normalizePhone('+420 (777) 123-456', undefined, '42')).toEqual({
    countryCode: 'CZ',
    displayValue: '+420 (777) 123-456',
    extension: '42',
    lookupValue: '+420777123456',
  });
  expect(normalizePhone('777 123 456', 'CZ')).toEqual({
    countryCode: 'CZ',
    displayValue: '777 123 456',
    extension: null,
    lookupValue: '+420777123456',
  });
  expect(() => normalizePhone('777 123 456')).toThrow();
  expect(() =>
    Schema.decodeSync(PhoneContactPointInputSchema)({
      countryCode: 'CZ',
      preferred: false,
      type: 'PHONE',
      value: '+0123456789',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeSync(PhoneContactPointInputSchema)({
      extension: '1234567890123',
      preferred: false,
      type: 'PHONE',
      value: '+420777123456',
    }),
  ).toThrow();
  expect(() => normalizePhone('+420777123456', 'CZ', '123456789012')).not.toThrow();
  expect(() =>
    Schema.decodeSync(PhoneContactPointInputSchema)({
      preferred: false,
      type: 'PHONE',
      value: '777 123 456',
    }),
  ).toThrow();
});
it('keeps ADDRESS structured, multi-purpose, and preferred independently per purpose', () => {
  const decoded = Schema.decodeSync(AddressContactPointInputSchema)({
    address: {
      addressLine1: '  Na Prikope 1  ',
      city: '  Praha  ',
      countryCode: 'cz',
      postalCode: '110 00',
    },
    purposes: [
      {
        preferred: true,
        purpose: 'REGISTERED',
        registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
      },
      { preferred: false, purpose: 'CORRESPONDENCE' },
    ],
    type: 'ADDRESS',
  });
  expect(normalizeAddress(decoded.address)).toEqual({
    addressLine1: 'Na Prikope 1',
    addressLine2: null,
    city: 'Praha',
    countryCode: 'CZ',
    postalCode: '110 00',
    region: null,
  });
  expect(decoded.purposes.map(({ preferred, purpose }) => ({ preferred, purpose }))).toEqual([
    { preferred: true, purpose: 'REGISTERED' },
    { preferred: false, purpose: 'CORRESPONDENCE' },
  ]);
  expect(() =>
    Schema.decodeUnknownSync(AddressContactPointInputSchema)({
      address: { addressLine1: 'One', city: 'Prague', countryCode: 'CZ' },
      purposes: [{ preferred: false, purpose: 'OTHER' }],
      type: 'ADDRESS',
    }),
  ).toThrow();
});
it('requires authoritative, registry-scoped evidence only for REGISTERED', () => {
  expect(() =>
    assertAddressPurposeRules(
      [
        {
          preferred: true,
          purpose: 'REGISTERED',
          registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
        },
      ],
      provenance,
    ),
  ).toThrow();
  expect(() =>
    assertAddressPurposeRules(
      [
        {
          preferred: true,
          purpose: 'REGISTERED',
          registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
        },
        { preferred: false, purpose: 'CORRESPONDENCE' },
      ],
      {
        ...provenance,
        authoritative: true,
        evidenceReference: 'evidence:ares:subject:1',
      },
    ),
  ).not.toThrow();
});
it('keeps the contact-point catalog closed to EMAIL, PHONE, and ADDRESS', () => {
  for (const input of [
    { preferred: false, type: 'EMAIL', value: 'a@example.test' },
    { countryCode: 'CZ', preferred: false, type: 'PHONE', value: '777123456' },
    {
      address: { addressLine1: 'One', city: 'Prague', countryCode: 'CZ' },
      purposes: [{ preferred: false, purpose: 'DELIVERY' }],
      type: 'ADDRESS',
    },
  ]) {
    expect(() => Schema.decodeUnknownSync(ContactPointInputSchema)(input)).not.toThrow();
  }
  expect(() => Schema.decodeUnknownSync(ContactPointInputSchema)({ type: 'OTHER' })).toThrow();
});
it('declares tenant-authorized idempotent Actions and prevents value overwrite through UPDATE', () => {
  for (const action of [addContactPointAction, updateContactPointAction, endContactPointAction]) {
    expect(action.descriptor.legalEntityScope).toBe('optional');
    expect(action.descriptor.idempotency).toBe('required');
    expect(action.descriptor.tenantPermission).not.toBe(undefined);
  }
  expect(() =>
    Schema.decodeSync(AddContactPointPayloadSchema)({
      contactPoint: {
        preferred: true,
        type: 'EMAIL',
        value: 'user@example.test',
      },
      partyRef,
      privacyClassification: 'PERSONAL',
      provenance,
      validFrom: '2026-09-01T00:00:00.000Z',
      verification: { state: 'UNVERIFIED' },
    }),
  ).not.toThrow();
  expect(() =>
    Schema.decodeUnknownSync(UpdateContactPointPayloadSchema, {
      onExcessProperty: 'error',
    })({
      change: { preferred: true, type: 'SET_CHANNEL_PREFERRED' },
      contactPointRef: {
        ...partyRef,
        resourceType: 'party.registry.party-contact-point',
      },
      expectedRevision: 1,
      provenance,
      value: 'replacement@example.test',
    }),
  ).toThrow();
});
it('governs contact reads with tenant Party authority even when Legal Entity context is optional', () => {
  for (const read of [partyContactPointsRead, partyContactPointDetailRead]) {
    expect(read.descriptor.legalEntityScope).toBe('optional');
    expect(read.descriptor.permissionTarget).toBe('tenant');
  }
});
it('publishes stable references instead of mutable contact data', () => {
  const contactPointRef = {
    ...partyRef,
    resourceType: 'party.registry.party-contact-point',
  };
  expect(
    Schema.decodeUnknownSync(ContactPointAddedOutboxPayloadSchema)({
      contactPointRef,
      partyRef,
    }),
  ).toEqual({ contactPointRef, partyRef });
  expect(() =>
    Schema.decodeUnknownSync(ContactPointAddedOutboxPayloadSchema, {
      onExcessProperty: 'error',
    })({
      contactPointRef,
      displayValue: 'private@example.test',
      partyRef,
    }),
  ).toThrow();
});
it('models removal as a reasoned temporal end of a whole contact or one ADDRESS purpose', () => {
  const contactPointRef = {
    ...partyRef,
    resourceType: 'party.registry.party-contact-point',
  };
  for (const target of [
    { type: 'WHOLE_CONTACT_POINT' },
    { target: { purpose: 'DELIVERY' }, type: 'ADDRESS_PURPOSE' },
  ] as const) {
    expect(() =>
      Schema.decodeUnknownSync(EndContactPointPayloadSchema)({
        contactPointRef,
        effectiveEnd: '2026-09-03T10:00:00.000Z',
        provenance,
        reason: 'Party confirmed that this contact is no longer used',
        target,
      }),
    ).not.toThrow();
  }
  expect(() =>
    Schema.decodeUnknownSync(EndContactPointPayloadSchema)({
      contactPointRef,
      effectiveEnd: '2026-09-03T10:00:00.000Z',
      provenance,
      reason: '',
      target: { type: 'WHOLE_CONTACT_POINT' },
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(UpdateContactPointPayloadSchema)({
      change: {
        effectiveEnd: '2026-09-03T10:00:00.000Z',
        reason: 'Delivery purpose is no longer used',
        target: { purpose: 'DELIVERY' },
        type: 'END_ADDRESS_PURPOSE',
      },
      contactPointRef,
      expectedRevision: 1,
      provenance,
    }),
  ).not.toThrow();
  expect(() =>
    Schema.decodeUnknownSync(UpdateContactPointPayloadSchema)({
      change: { target: { purpose: 'DELIVERY' }, type: 'END_ADDRESS_PURPOSE' },
      contactPointRef,
      expectedRevision: 1,
      provenance,
    }),
  ).toThrow();
});
it('models an originally wrong Contact Point as an explicit correction with optional validated replacement', () => {
  const contactPointRef = {
    ...partyRef,
    resourceType: 'party.registry.party-contact-point',
  };
  expect(() =>
    Schema.decodeUnknownSync(UpdateContactPointPayloadSchema)({
      change: {
        evidenceReferences: ['evidence:customer-confirmation:42'],
        reason: 'The original mailbox never belonged to this Party',
        replacement: {
          contactPoint: {
            preferred: true,
            type: 'EMAIL',
            value: 'correct@example.test',
          },
          privacyClassification: 'PERSONAL',
          provenance: {
            ...provenance,
            evidenceReference: 'evidence:customer-confirmation:42',
          },
          validFrom: '2026-09-03T10:00:00.000Z',
          verification: { state: 'UNVERIFIED' },
        },
        type: 'CORRECT_CONTACT_POINT',
      },
      contactPointRef,
      expectedRevision: 3,
      provenance: {
        ...provenance,
        evidenceReference: 'evidence:customer-confirmation:42',
      },
    }),
  ).not.toThrow();
  expect(() =>
    Schema.decodeUnknownSync(UpdateContactPointPayloadSchema)({
      change: {
        evidenceReferences: [],
        reason: 'Correction without evidence',
        type: 'CORRECT_CONTACT_POINT',
      },
      contactPointRef,
      expectedRevision: 3,
      provenance,
    }),
  ).toThrow();
});
it('projects independently auditable whole-contact and ADDRESS-purpose ends', () => {
  const encodedEnd = {
    effectiveEnd: '2026-10-01T00:00:00.000Z',
    endedByActionInvocationId: '30000000-0000-4000-8000-000000000001',
    endedByPrincipalId: '40000000-0000-4000-8000-000000000001',
    provenance: {
      evidenceReferences: [],
      method: 'MANUAL_CONFIRMATION',
      source: 'USER_ASSERTION',
    },
    reason: 'Correspondence moved to another address',
    recordedAt: '2026-09-03T10:00:00.000Z',
  } as const;
  const end = Schema.decodeSync(ContactPointEndSchema)(encodedEnd);
  const address = Schema.decodeSync(AddressContactPointValueSchema)({
    address: {
      addressLine1: 'Na Prikope 1',
      addressLine2: null,
      city: 'Praha',
      countryCode: 'CZ',
      postalCode: '110 00',
      region: null,
    },
    purposes: [
      {
        current: true,
        end: encodedEnd,
        preferred: true,
        provenance,
        purpose: 'CORRESPONDENCE',
        recordedAt: '2026-09-01T00:00:00.000Z',
        revision: 2,
        state: 'ACTIVE',
        validFrom: '2026-09-01T00:00:00.000Z',
        validTo: '2026-10-01T00:00:00.000Z',
        verification: { state: 'UNVERIFIED' },
      },
    ],
    type: 'ADDRESS',
  });
  expect(address.purposes[0]?.end).toEqual(end);
  expect(address.purposes[0]?.current, 'a future end remains current before boundary').toBe(true);
});
