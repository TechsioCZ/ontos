import { Effect, Exit, Schema } from 'effect';
import { expect, it, rstest } from 'effect-rstest';
import { ContactPointInputSchema, PartyContactPointSchema } from '../../shared/domain/contact-point.ts';
import { PartyRefSchema } from '../../shared/resources/party.ts';
import {
  customerContactFields,
  customerContactInput,
  customerContactEditable,
  customerContactRequiresAuthoritativeEdit,
  discardCustomerDraftKeys,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';
import { updateContactPoint, updateParty } from '../../src/api/party-command-client.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { saveCustomerFact } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyRef = Schema.decodeSync(PartyRefSchema)({
  tenantId,
  moduleId: 'party.registry',
  resourceType: 'party.registry.party',
  resourceId: '40000000-0000-4000-8000-000000000001',
});
const now = '2026-10-15T10:00:00.000Z';
const provenance = { authoritative: false, method: 'MANUAL_CONFIRMATION', source: 'USER_ASSERTION' };
const contact = Schema.decodeUnknownSync(PartyContactPointSchema)({
  contactPointRef: {
    tenantId,
    moduleId: 'party.registry',
    resourceType: 'party.registry.party-contact-point',
    resourceId: '50000000-0000-4000-8000-000000000001',
  },
  partyRef,
  storedPartyRef: partyRef,
  current: true,
  end: null,
  privacyClassification: 'BUSINESS_SENSITIVE',
  provenance,
  recordedAt: now,
  revision: 7,
  state: 'ACTIVE',
  validFrom: now,
  validTo: null,
  verification: { state: 'UNVERIFIED' },
  value: {
    type: 'PHONE',
    preferred: true,
    countryCode: 'CZ',
    displayValue: '+420 777 123 456',
    lookupValue: '+420777123456',
    extension: '12',
  },
});

it('preserves contact preference and extension while editing the phone value', () => {
  expect(customerContactFields(contact)).toEqual({ value: '+420 777 123 456' });
  expect(customerContactInput('PHONE', { value: '+420 777 654 321' }, contact)).toEqual({
    type: 'PHONE',
    preferred: true,
    countryCode: 'CZ',
    extension: '12',
    value: '+420 777 654 321',
  });
});

it('distinguishes registered address protection from missing Party permissions and historical purposes', () => {
  const addressContact = (purpose: 'REGISTERED' | 'CORRESPONDENCE', current: boolean) =>
    Schema.decodeSync(PartyContactPointSchema)({
      ...Schema.encodeSync(PartyContactPointSchema)(contact),
      value: {
        type: 'ADDRESS',
        address: {
          addressLine1: 'Dlouhá 5',
          addressLine2: null,
          city: 'Praha',
          postalCode: '11000',
          countryCode: 'CZ',
          region: null,
        },
        purposes: [
          {
            current,
            end: null,
            preferred: false,
            provenance: Schema.encodeSync(PartyContactPointSchema)(contact).provenance,
            purpose,
            recordedAt: now,
            revision: 1,
            state: 'ACTIVE',
            validFrom: now,
            validTo: null,
            verification: { state: 'UNVERIFIED' },
          },
        ],
      },
    });
  const manualAddress = addressContact('CORRESPONDENCE', true);
  const registeredAddress = addressContact('REGISTERED', true);
  const historicalRegisteredAddress = addressContact('REGISTERED', false);

  expect(customerContactEditable(manualAddress, false)).toBe(false);
  expect(customerContactRequiresAuthoritativeEdit(manualAddress)).toBe(false);
  expect(customerContactEditable(manualAddress, true)).toBe(true);
  expect(customerContactRequiresAuthoritativeEdit(registeredAddress)).toBe(true);
  expect(customerContactEditable(registeredAddress, true)).toBe(false);
  expect(customerContactRequiresAuthoritativeEdit(historicalRegisteredAddress)).toBe(false);
  expect(customerContactEditable(historicalRegisteredAddress, true)).toBe(true);
  expect(customerContactRequiresAuthoritativeEdit(contact)).toBe(false);
});

it('keeps structured address fields, omits blank parts, and uses the correspondence purpose for a new address', () => {
  const input = customerContactInput('ADDRESS', {
    addressLine1: 'Dlouhá 5',
    addressLine2: '',
    city: 'Praha',
    postalCode: '11000',
    region: '',
    countryCode: 'CZ',
  });
  expect(input).toEqual({
    type: 'ADDRESS',
    purposes: [{ preferred: false, purpose: 'CORRESPONDENCE' }],
    address: { addressLine1: 'Dlouhá 5', city: 'Praha', postalCode: '11000', countryCode: 'CZ' },
  });
  expect(Schema.is(ContactPointInputSchema)(input)).toBe(true);
});

it.effect('rejects an invalid official identifier before issuing an authenticated write', () =>
  Effect.gen(function* rejectIdentifier() {
    const result = yield* Effect.exit(
      saveCustomerFact(
        partyRef,
        { existing: undefined, identifierType: 'ICO', kind: 'identifier', value: '25741137' },
        'Correction',
        'document:42',
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(rstest.mocked(updateParty)).not.toHaveBeenCalled();
    expect(rstest.mocked(updateContactPoint)).not.toHaveBeenCalled();
  }),
);

rstest.mock('../../src/api/party-command-client.ts');

it.effect('sends the loaded Party revision and explicit supporting provenance for a name change', () =>
  Effect.gen(function* saveName() {
    const party = yield* Schema.decodeEffect(PartySchema)({
      partyRef,
      partyType: 'ORGANIZATION',
      displayName: 'Before',
      revision: 9,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    rstest.mocked(updateParty).mockReturnValue(Effect.succeed({ ...party, revision: 10 }));
    yield* saveCustomerFact(partyRef, { kind: 'name', party, value: ' After ' }, 'Reviewed name', 'document:42');
    expect(rstest.mocked(updateParty).mock.calls[0]?.[0]).toMatchObject({
      partyRef,
      displayName: 'After',
      expectedRevision: 9,
      provenanceSource: 'document:42',
      provenanceMethod: 'MANUAL_ENTRY',
    });
  }),
);

it.effect(
  'corrects a contact through its stable ref and revision, preserving privacy and leaving verification unclaimed',
  () =>
    Effect.gen(function* savePhone() {
      rstest.mocked(updateContactPoint).mockReturnValue(Effect.succeed(contact));
      yield* saveCustomerFact(
        partyRef,
        {
          existing: contact,
          kind: 'contact',
          value: customerContactInput('PHONE', { value: '+420777654321' }, contact),
        },
        'Wrong phone',
        'document:42',
      );
      expect(rstest.mocked(updateContactPoint).mock.calls[0]?.[0]).toMatchObject({
        contactPointRef: contact.contactPointRef,
        expectedRevision: 7,
        change: {
          type: 'CORRECT_CONTACT_POINT',
          reason: 'Wrong phone',
          evidenceReferences: ['document:42'],
          replacement: {
            privacyClassification: 'BUSINESS_SENSITIVE',
            verification: { state: 'UNVERIFIED' },
            contactPoint: { type: 'PHONE', value: '+420777654321', extension: '12' },
          },
        },
      });
    }),
);

it('clears only confirmed sections after a partial save and leaves other drafts available for correction', () => {
  const draft = { name: 'Saved name', 'identifier-vat': 'CZINVALID', 'phone-value': '+420777222333' };
  expect(discardCustomerDraftKeys(draft, ['name'])).toEqual({
    'identifier-vat': 'CZINVALID',
    'phone-value': '+420777222333',
  });
  expect(draft.name).toBe('Saved name');
});

it('does not claim a Czech country context for a new international phone number', () => {
  expect(customerContactInput('PHONE', { value: '+44 7700 900123' })).toEqual({
    preferred: false,
    type: 'PHONE',
    value: '+44 7700 900123',
  });
});
