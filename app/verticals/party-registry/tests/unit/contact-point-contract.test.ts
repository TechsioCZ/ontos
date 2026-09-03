import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
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
import {
  AddContactPointPayloadSchema,
  addContactPointAction,
} from '../../src/actions/add-contact-point.action.ts';
import {
  UpdateContactPointPayloadSchema,
  updateContactPointAction,
} from '../../src/actions/update-contact-point.action.ts';
import {
  EndContactPointPayloadSchema,
  endContactPointAction,
} from '../../src/actions/end-contact-point.action.ts';
import { partyContactPointDetailRead } from '../../src/api/party-contact-point-detail.read.ts';
import { partyContactPointsRead } from '../../src/api/party-contact-points.read.ts';
import { OutboxPayloadSchema as ContactPointAddedOutboxPayloadSchema } from '../../shared/outbox/party-registry-contact-point-added-v1.ts';

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

test('normalizes EMAIL without provider-specific identity heuristics', () => {
  assert.deepEqual(normalizeEmail('  Qa.Test+case@EXAMPLE.COM  '), {
    displayValue: 'Qa.Test+case@EXAMPLE.COM',
    lookupValue: 'Qa.Test+case@example.com',
  });
  assert.notEqual(
    normalizeEmail('qa.test+one@example.com').lookupValue,
    normalizeEmail('qatest+two@example.com').lookupValue,
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(EmailContactPointInputSchema)({
      preferred: false,
      type: 'EMAIL',
      value: 'not-an-email',
    }),
  );
});

test('normalizes PHONE only with explicit international or country context and preserves extension', () => {
  assert.deepEqual(normalizePhone('+420 (777) 123-456', undefined, '42'), {
    countryCode: 'CZ',
    displayValue: '+420 (777) 123-456',
    extension: '42',
    lookupValue: '+420777123456',
  });
  assert.deepEqual(normalizePhone('777 123 456', 'CZ'), {
    countryCode: 'CZ',
    displayValue: '777 123 456',
    extension: null,
    lookupValue: '+420777123456',
  });
  assert.throws(() => normalizePhone('777 123 456'));
  assert.throws(() =>
    Schema.decodeUnknownSync(PhoneContactPointInputSchema)({
      countryCode: 'CZ',
      preferred: false,
      type: 'PHONE',
      value: '+0123456789',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(PhoneContactPointInputSchema)({
      extension: '1234567890123',
      preferred: false,
      type: 'PHONE',
      value: '+420777123456',
    }),
  );
  assert.doesNotThrow(() => normalizePhone('+420777123456', 'CZ', '123456789012'));
  assert.throws(() =>
    Schema.decodeUnknownSync(PhoneContactPointInputSchema)({
      preferred: false,
      type: 'PHONE',
      value: '777 123 456',
    }),
  );
});

test('keeps ADDRESS structured, multi-purpose, and preferred independently per purpose', () => {
  const decoded = Schema.decodeUnknownSync(AddressContactPointInputSchema)({
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
  assert.deepEqual(normalizeAddress(decoded.address), {
    addressLine1: 'Na Prikope 1',
    addressLine2: null,
    city: 'Praha',
    countryCode: 'CZ',
    postalCode: '110 00',
    region: null,
  });
  assert.deepEqual(
    decoded.purposes.map(({ preferred, purpose }) => ({ preferred, purpose })),
    [
      { preferred: true, purpose: 'REGISTERED' },
      { preferred: false, purpose: 'CORRESPONDENCE' },
    ],
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(AddressContactPointInputSchema)({
      address: { addressLine1: 'One', city: 'Prague', countryCode: 'CZ' },
      purposes: [{ preferred: false, purpose: 'OTHER' }],
      type: 'ADDRESS',
    }),
  );
});

test('requires authoritative, registry-scoped evidence only for REGISTERED', () => {
  assert.throws(() =>
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
  );
  assert.doesNotThrow(() =>
    assertAddressPurposeRules(
      [
        {
          preferred: true,
          purpose: 'REGISTERED',
          registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
        },
        { preferred: false, purpose: 'CORRESPONDENCE' },
      ],
      { ...provenance, authoritative: true, evidenceReference: 'evidence:ares:subject:1' },
    ),
  );
});

test('keeps the contact-point catalog closed to EMAIL, PHONE, and ADDRESS', () => {
  for (const input of [
    { preferred: false, type: 'EMAIL', value: 'a@example.test' },
    { countryCode: 'CZ', preferred: false, type: 'PHONE', value: '777123456' },
    {
      address: { addressLine1: 'One', city: 'Prague', countryCode: 'CZ' },
      purposes: [{ preferred: false, purpose: 'DELIVERY' }],
      type: 'ADDRESS',
    },
  ]) {
    assert.doesNotThrow(() => Schema.decodeUnknownSync(ContactPointInputSchema)(input));
  }
  assert.throws(() => Schema.decodeUnknownSync(ContactPointInputSchema)({ type: 'OTHER' }));
});

test('declares tenant-authorized idempotent Actions and prevents value overwrite through UPDATE', () => {
  for (const action of [addContactPointAction, updateContactPointAction, endContactPointAction]) {
    assert.equal(action.descriptor.legalEntityScope, 'optional');
    assert.equal(action.descriptor.idempotency, 'required');
    assert.notEqual(action.descriptor.tenantPermission, undefined);
  }
  assert.doesNotThrow(() =>
    Schema.decodeUnknownSync(AddContactPointPayloadSchema)({
      contactPoint: { preferred: true, type: 'EMAIL', value: 'user@example.test' },
      partyRef,
      privacyClassification: 'PERSONAL',
      provenance,
      validFrom: '2026-09-01T00:00:00.000Z',
      verification: { state: 'UNVERIFIED' },
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(UpdateContactPointPayloadSchema, { onExcessProperty: 'error' })({
      change: { preferred: true, type: 'SET_CHANNEL_PREFERRED' },
      contactPointRef: {
        ...partyRef,
        resourceType: 'party.registry.party-contact-point',
      },
      expectedRevision: 1,
      provenance,
      value: 'replacement@example.test',
    }),
  );
});

test('governs contact reads with tenant Party authority even when Legal Entity context is optional', () => {
  for (const read of [partyContactPointsRead, partyContactPointDetailRead]) {
    assert.equal(read.descriptor.legalEntityScope, 'optional');
    assert.equal(read.descriptor.permissionTarget, 'tenant');
  }
});

test('publishes stable references instead of mutable contact data', () => {
  const contactPointRef = { ...partyRef, resourceType: 'party.registry.party-contact-point' };
  assert.deepEqual(
    Schema.decodeUnknownSync(ContactPointAddedOutboxPayloadSchema)({ contactPointRef, partyRef }),
    { contactPointRef, partyRef },
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(ContactPointAddedOutboxPayloadSchema, { onExcessProperty: 'error' })({
      contactPointRef,
      displayValue: 'private@example.test',
      partyRef,
    }),
  );
});

test('models removal as a reasoned temporal end of a whole contact or one ADDRESS purpose', () => {
  const contactPointRef = { ...partyRef, resourceType: 'party.registry.party-contact-point' };
  for (const target of [
    { type: 'WHOLE_CONTACT_POINT' },
    { target: { purpose: 'DELIVERY' }, type: 'ADDRESS_PURPOSE' },
  ] as const) {
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(EndContactPointPayloadSchema)({
        contactPointRef,
        effectiveEnd: '2026-09-03T10:00:00.000Z',
        provenance,
        reason: 'Party confirmed that this contact is no longer used',
        target,
      }),
    );
  }
  assert.throws(() =>
    Schema.decodeUnknownSync(EndContactPointPayloadSchema)({
      contactPointRef,
      effectiveEnd: '2026-09-03T10:00:00.000Z',
      provenance,
      reason: '',
      target: { type: 'WHOLE_CONTACT_POINT' },
    }),
  );

  assert.doesNotThrow(() =>
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
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(UpdateContactPointPayloadSchema)({
      change: { target: { purpose: 'DELIVERY' }, type: 'END_ADDRESS_PURPOSE' },
      contactPointRef,
      expectedRevision: 1,
      provenance,
    }),
  );
});

test('models an originally wrong Contact Point as an explicit correction with optional validated replacement', () => {
  const contactPointRef = { ...partyRef, resourceType: 'party.registry.party-contact-point' };
  assert.doesNotThrow(() =>
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
          provenance: { ...provenance, evidenceReference: 'evidence:customer-confirmation:42' },
          validFrom: '2026-09-03T10:00:00.000Z',
          verification: { state: 'UNVERIFIED' },
        },
        type: 'CORRECT_CONTACT_POINT',
      },
      contactPointRef,
      expectedRevision: 3,
      provenance: { ...provenance, evidenceReference: 'evidence:customer-confirmation:42' },
    }),
  );
  assert.throws(() =>
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
  );
});

test('projects independently auditable whole-contact and ADDRESS-purpose ends', () => {
  const end = Schema.decodeUnknownSync(ContactPointEndSchema)({
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
  });
  const address = Schema.decodeUnknownSync(AddressContactPointValueSchema)({
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
        end,
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
  assert.deepEqual(address.purposes[0]?.end, end);
  assert.equal(address.purposes[0]?.current, true, 'a future end remains current before boundary');
});
