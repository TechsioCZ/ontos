// @rstest-environment happy-dom
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Exit, Layer, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
import { partyCommandSchemaErrorLive } from '../../api/party-command-problems.ts';
import { partyRegistryCommandsApi } from '../../shared/command-api.ts';
import type { UpdatePartyPayloadSchema } from '../../shared/actions/update-party.ts';
import type { UpdateContactPointPayload } from '../../shared/actions/update-contact-point.ts';
import { ContactPointInputSchema, PartyContactPointSchema } from '../../shared/domain/contact-point.ts';
import { PartyRefSchema } from '../../shared/resources/party.ts';
import {
  customerContactFields,
  customerContactInput,
  customerContactEditable,
  customerContactRequiresAuthoritativeEdit,
  discardCustomerDraftKeys,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';
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
  value: {
    type: 'PHONE',
    preferred: true,
    countryCode: 'CZ',
    displayValue: '+420 777 123 456',
    lookupValue: '+420777123456',
    extension: '12',
  },
});

const party = Schema.decodeSync(PartySchema)({
  partyRef,
  partyType: 'ORGANIZATION',
  businessName: 'Before',
  displayName: 'Before',
  firstName: null,
  lastName: null,
  revision: 9,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
});
const partyUpdates: (typeof UpdatePartyPayloadSchema.Encoded)[] = [];
const contactUpdates: UpdateContactPointPayload[] = [];
const OwnerApi = partyRegistryCommandsApi.prefix('/party-registry-api');
const issuer = shellGatewayIssuer({ 'party-registry': '/party-registry-api' });
const unexpectedCommand = () => Effect.die('Unexpected Party Registry command');
const commands = HttpApiBuilder.group(OwnerApi, 'partyCommands', (group) =>
  group
    .handle('updateParty', ({ payload }) =>
      Effect.sync(() => {
        partyUpdates.push(payload);
        return { ...party, revision: 10 };
      }),
    )
    .handle('updateContactPoint', ({ payload }) =>
      Effect.sync(() => {
        contactUpdates.push(payload);
        return contact;
      }),
    )
    .handle('acceptRetailEnrollmentEvidence', unexpectedCommand)
    .handle('addContactPoint', unexpectedCommand)
    .handle('addPartyOfficialIdentifier', unexpectedCommand)
    .handle('archiveParty', unexpectedCommand)
    .handle('confirmDuplicateParties', unexpectedCommand)
    .handle('correctPartyFact', unexpectedCommand)
    .handle('counterpartyCreate', unexpectedCommand)
    .handle('counterpartyCustomerOnboard', unexpectedCommand)
    .handle('counterpartyRoleAdd', unexpectedCommand)
    .handle('counterpartyRoleEnd', unexpectedCommand)
    .handle('createPartyRelationship', unexpectedCommand)
    .handle('createParty', unexpectedCommand)
    .handle('dismissDuplicateCandidate', unexpectedCommand)
    .handle('endContactPoint', unexpectedCommand)
    .handle('endPartyOfficialIdentifier', unexpectedCommand)
    .handle('endPartyRelationship', unexpectedCommand)
    .handle('markDuplicateCandidateNeedsEvidence', unexpectedCommand)
    .handle('matchParty', unexpectedCommand)
    .handle('requestSearchRebuild', unexpectedCommand)
    .handle('resolveDuplicateCandidateCreate', unexpectedCommand)
    .handle('resolveDuplicateCandidateMatch', unexpectedCommand)
    .handle('unarchiveParty', unexpectedCommand)
    .handle('updatePartyOfficialIdentifier', unexpectedCommand)
    .handle('updatePartyRelationship', unexpectedCommand),
).pipe(Layer.provide(partyCommandSchemaErrorLive));
const network = browserNetwork(issuer.application, serveApi(OwnerApi, commands));

beforeEach(() => {
  partyUpdates.length = 0;
  contactUpdates.length = 0;
  issuer.issued.length = 0;
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

it.layer(network, { excludeTestServices: true })('customer detail edit', (suite) => {
  suite.effect('rejects an invalid official identifier before issuing an authenticated write', () =>
    Effect.gen(function* rejectIdentifier() {
      yield* pinTestDocument;
      const result = yield* Effect.exit(
        saveCustomerFact(
          partyRef,
          { existing: undefined, identifierType: 'ICO', kind: 'identifier', value: '25741137' },
          'Correction',
          'document:42',
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(partyUpdates).toHaveLength(0);
      expect(contactUpdates).toHaveLength(0);
    }),
  );

  suite.effect('sends the loaded Party revision and explicit supporting provenance for a name change', () =>
    Effect.gen(function* saveName() {
      yield* pinTestDocument;
      yield* saveCustomerFact(partyRef, { kind: 'name', party, value: ' After ' }, 'Reviewed name', 'document:42');
      expect(partyUpdates[0]).toMatchObject({
        partyRef,
        businessName: 'After',
        expectedRevision: 9,
        provenanceSource: 'document:42',
        provenanceMethod: 'MANUAL_ENTRY',
      });
    }),
  );

  suite.effect(
    'corrects a contact through its stable ref and revision, preserving privacy and leaving verification unclaimed',
    () =>
      Effect.gen(function* savePhone() {
        yield* pinTestDocument;
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
        expect(contactUpdates[0]).toMatchObject({
          contactPointRef: contact.contactPointRef,
          expectedRevision: 7,
          change: {
            type: 'CORRECT_CONTACT_POINT',
            reason: 'Wrong phone',
            evidenceReferences: ['document:42'],
            replacement: {
              privacyClassification: 'BUSINESS_SENSITIVE',
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
});
