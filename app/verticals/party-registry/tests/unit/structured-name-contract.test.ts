import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { UpdatePartyPayloadSchema } from '../../shared/actions/update-party.ts';
import { PartyFactAssertionSchema } from '../../shared/apis/party-detail.ts';
import {
  IdentityCorrectionCommandSchema,
  PartyCorrectionAssertionValueSchema,
} from '../../shared/domain/correction-contracts.ts';
import { PartyCandidateSchema, derivePartyDisplayName, makePartyRef } from '../../shared/domain/identity-contracts.ts';

const candidate = {
  evidenceRefs: [],
  officialIdentifiers: [],
  partyType: 'UNRESOLVED',
  provenance: { method: 'MANUAL', source: 'test' },
  validFrom: '2026-01-01T00:00:00.000Z',
} as const;
const partyRef = makePartyRef('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
const updateContext = {
  expectedRevision: 1,
  partyRef,
  provenanceMethod: 'MANUAL',
  provenanceSource: 'test',
  validFrom: candidate.validFrom,
};

it('PERSON presentation uses the available personal name parts without business-name fallback', () => {
  expect(
    derivePartyDisplayName({ partyType: 'PERSON', firstName: 'Ada', lastName: 'Lovelace', businessName: 'Company' }),
  ).toBe('Ada Lovelace');
  expect(derivePartyDisplayName({ partyType: 'PERSON', firstName: 'Ada' })).toBe('Ada');
  expect(derivePartyDisplayName({ partyType: 'PERSON', lastName: 'Lovelace' })).toBe('Lovelace');
  expect(derivePartyDisplayName({ partyType: 'PERSON', businessName: 'Company' })).toBe(null);
});

it('each name input is an independent optional, non-empty text fact', () => {
  expect(Schema.decodeSync(PartyCandidateSchema)(candidate)).not.toHaveProperty('firstName');
  for (const name of ['firstName', 'lastName', 'businessName']) {
    const supplied = { [name]: ' Ada ' };
    expect(Schema.decodeUnknownSync(PartyCandidateSchema)({ ...candidate, ...supplied })).toMatchObject({
      [name]: 'Ada',
    });
    expect(Schema.decodeUnknownSync(UpdatePartyPayloadSchema)({ ...updateContext, ...supplied })).toMatchObject({
      [name]: 'Ada',
    });
    for (const value of [null, '', '   ']) {
      expect(() => Schema.decodeUnknownSync(PartyCandidateSchema)({ ...candidate, [name]: value })).toThrow();
      expect(() => Schema.decodeUnknownSync(UpdatePartyPayloadSchema)({ ...updateContext, [name]: value })).toThrow();
    }
  }
  expect(() => Schema.decodeUnknownSync(UpdatePartyPayloadSchema)(updateContext)).toThrow();
  expect(() => Schema.decodeUnknownSync(UpdatePartyPayloadSchema)({ ...updateContext, displayName: 'Ada' })).toThrow();
  expect(Schema.decodeSync(UpdatePartyPayloadSchema)({ ...updateContext, partyType: 'PERSON' }).partyType).toBe(
    'PERSON',
  );
});

it('all Party types derive presentation from available canonical facts without inferring type', () => {
  const personalNames = [
    { firstName: null, lastName: null, display: null },
    { firstName: 'Ada', lastName: null, display: 'Ada' },
    { firstName: null, lastName: 'Lovelace', display: 'Lovelace' },
    { firstName: 'Ada', lastName: 'Lovelace', display: 'Ada Lovelace' },
  ];
  for (const names of personalNames) {
    for (const businessName of [null, 'Analytical Engines']) {
      expect(derivePartyDisplayName({ partyType: 'PERSON', ...names, businessName })).toBe(names.display);
      expect(derivePartyDisplayName({ partyType: 'ORGANIZATION', ...names, businessName })).toBe(businessName);
      expect(derivePartyDisplayName({ partyType: 'UNRESOLVED', ...names, businessName })).toBe(
        businessName ?? names.display,
      );
    }
  }
});

it('Update omission preserves its sparse intent and name changes do not supply Party Type', () => {
  const decoded = Schema.decodeSync(UpdatePartyPayloadSchema)({ ...updateContext, lastName: 'Byron' });
  expect(decoded.lastName).toBe('Byron');
  expect(decoded).not.toHaveProperty('firstName');
  expect(decoded).not.toHaveProperty('businessName');
  expect(decoded).not.toHaveProperty('partyType');
});

it('each structured name fact decodes through correction and authorized history contracts', () => {
  const assertionId = '33333333-3333-4333-8333-333333333333';
  const correction = {
    evidenceRefs: ['evidence:1'],
    evidenceSource: 'DOCUMENT',
    partyId: partyRef.resourceId,
    policyVersion: 'party-correction.v1',
    provenance: candidate.provenance,
    reasonCode: 'WRONG_IDENTITY_VALUE',
    replacementValue: 'Ada',
    targetAssertionId: assertionId,
  } as const;
  for (const factKind of ['FIRST_NAME', 'LAST_NAME', 'BUSINESS_NAME'] as const) {
    expect(Schema.decodeUnknownSync(IdentityCorrectionCommandSchema)({ ...correction, factKind }).factKind).toBe(
      factKind,
    );
    for (const replacementValue of [undefined, null, '', '   ']) {
      expect(() =>
        Schema.decodeUnknownSync(IdentityCorrectionCommandSchema)({ ...correction, factKind, replacementValue }),
      ).toThrow();
    }
    const history = {
      assertionId,
      factKind,
      provenance: candidate.provenance,
      recordedAt: candidate.validFrom,
      state: 'ACTIVE' as const,
      validFrom: candidate.validFrom,
      validTo: null,
      value: 'Ada',
    };
    expect(Schema.decodeUnknownSync(PartyCorrectionAssertionValueSchema)(history).factKind).toBe(factKind);
    const detailFact = Schema.decodeUnknownSync(PartyFactAssertionSchema)({
      ...history,
      isCurrent: true,
      partyRef,
      retractsAssertionId: null,
      supersedesAssertionId: null,
    });
    expect(detailFact.factKind).toBe(factKind);
    expect(Option.isNone(detailFact.supersedesAssertionId)).toBe(true);
  }
  expect(() =>
    Schema.decodeUnknownSync(IdentityCorrectionCommandSchema)({ ...correction, factKind: 'DISPLAY_NAME' }),
  ).toThrow();
});
