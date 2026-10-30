import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  OfficialIdentifierAssertionSchema,
  OfficialIdentifierInputSchema,
  normalizeOfficialIdentifier,
  qualifyingClaimKey,
} from '../../shared/domain/identifier-contracts.ts';
import { addPartyOfficialIdentifierAction } from '../../src/actions/add-party-official-identifier.action.ts';
import { endPartyOfficialIdentifierAction } from '../../src/actions/end-party-official-identifier.action.ts';
import {
  OfficialIdentifierUpdatedEventSchema,
  UpdatePartyOfficialIdentifierPayloadSchema,
  updatePartyOfficialIdentifierAction,
} from '../../src/actions/update-party-official-identifier.action.ts';

const decode = Schema.decodeUnknownSync;

it('Official Identifier V1 accepts only IČO and Czech DIČ', () => {
  const ico = Schema.decodeSync(OfficialIdentifierInputSchema)({
    identifierType: 'ICO',
    value: '27074358',
    verification: 'VERIFIED',
  });
  expect(normalizeOfficialIdentifier(ico).normalizedValue).toBe('27074358');
  expect(normalizeOfficialIdentifier(ico).namespace).toBe('CZ:ICO');

  const legacyShortIco = Schema.decodeSync(OfficialIdentifierInputSchema)({
    identifierType: 'ICO',
    value: '1000004',
    verification: 'VERIFIED',
  });
  expect(normalizeOfficialIdentifier(legacyShortIco).normalizedValue).toBe('01000004');
  expect(
    decode(OfficialIdentifierInputSchema)({ identifierType: 'ICO', value: ' 1000004 ', verification: 'UNVERIFIED' })
      .value,
  ).toBe('1000004');

  const dic = Schema.decodeSync(OfficialIdentifierInputSchema)({
    identifierType: 'CZ_DIC',
    value: 'cz27074358',
    verification: 'VERIFIED',
  });
  expect(normalizeOfficialIdentifier(dic).normalizedValue).toBe('CZ27074358');
  expect(normalizeOfficialIdentifier(dic).namespace).toBe('CZ:DIC');

  expect(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'ICO',
      namespace: 'caller-controlled',
      value: '27074358',
      verification: 'VERIFIED',
    }),
  ).toThrow();

  expect(() =>
    Schema.decodeSync(OfficialIdentifierInputSchema)({
      identifierType: 'ICO',
      value: '270 74 358',
      verification: 'VERIFIED',
    }),
  ).toThrow();

  expect(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'VAT_ID',
      value: 'CZ27074358',
      verification: 'VERIFIED',
    }),
  ).toThrow();
  expect(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'OTHER',
      value: '1',
      verification: 'VERIFIED',
    }),
  ).toThrow();
});

it('Official Identifier writes require tenant Party identity authority and idempotency', () => {
  for (const action of [
    addPartyOfficialIdentifierAction,
    endPartyOfficialIdentifierAction,
    updatePartyOfficialIdentifierAction,
  ]) {
    expect(action.descriptor.legalEntityScope).toBe('optional');
    expect(action.descriptor.idempotency).toBe('required');
    // SAFETY: these permission selectors are payload-independent; no handler receives this sentinel.
    expect(action.descriptor.tenantPermission?.({} as never)).toBe('manage_party_identity');
  }
});

it('only verified, formally valid identifiers create deterministic exclusive claim keys', () => {
  expect(
    qualifyingClaimKey(
      {
        identifierType: 'ICO',
        value: '27074358',
        verification: 'VERIFIED',
      },
      'ORGANIZATION',
      'party-exact-claims.v1',
    ),
  ).toBe('ICO\u0000CZ:ICO\u000027074358');
  expect(
    qualifyingClaimKey(
      {
        identifierType: 'ICO',
        value: '27074358',
        verification: 'UNVERIFIED',
      },
      'ORGANIZATION',
      'party-exact-claims.v1',
    ),
  ).toBe(undefined);
  expect(
    qualifyingClaimKey(
      {
        identifierType: 'ICO',
        value: '27074358',
        verification: 'VERIFIED',
      },
      'PERSON',
      'party-exact-claims.v1',
    ),
  ).toBe(undefined);
  expect(
    qualifyingClaimKey(
      {
        identifierType: 'CZ_DIC',
        value: 'CZ27074358',
        verification: 'VERIFIED',
      },
      'PERSON',
      'party-exact-claims.v1',
    ),
  ).toBe(undefined);
});

const identifierRef = {
  moduleId: 'party.registry',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-official-identifier',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;

it('Identifier Update is a closed evidence-backed metadata or validity command, never an identity patch', () => {
  const command = {
    change: {
      expectedVerification: 'UNVERIFIED',
      type: 'SET_VERIFICATION',
      verification: 'VERIFIED',
    },
    evidenceRefs: ['evidence:registry-confirmation'],
    officialIdentifierRef: identifierRef,
    reason: 'Registry confirmed the existing identifier',
  };
  expect(decode(UpdatePartyOfficialIdentifierPayloadSchema)(command).change.type).toBe('SET_VERIFICATION');
  expect(
    Schema.decodeSync(UpdatePartyOfficialIdentifierPayloadSchema)({
      ...command,
      change: { type: 'END_VALIDITY', validTo: '2026-01-01T00:00:00.000Z' },
    }).change.type,
  ).toBe('END_VALIDITY');
  for (const forbidden of ['value', 'normalizedValue', 'identifierType', 'namespace', 'partyRef']) {
    expect(() =>
      decode(UpdatePartyOfficialIdentifierPayloadSchema)({
        ...command,
        [forbidden]: 'changed-identity',
      }),
    ).toThrow();
  }
  expect(() =>
    decode(UpdatePartyOfficialIdentifierPayloadSchema)({
      ...command,
      evidenceRefs: [],
    }),
  ).toThrow();
  expect(() =>
    decode(UpdatePartyOfficialIdentifierPayloadSchema)({
      ...command,
      change: { type: 'REPLACE_VALUE', value: '12345678' },
    }),
  ).toThrow();
});

it('Identifier Update event retains before and after verification evidence', () => {
  const before = {
    state: 'ACTIVE',
    validTo: null,
    verification: 'VERIFIED',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    verifiedByPrincipalId: 'prior-verifier',
  };
  const after = {
    state: 'ACTIVE',
    validTo: null,
    verification: 'REJECTED',
    verifiedAt: null,
    verifiedByPrincipalId: null,
  };
  const event = decode(OfficialIdentifierUpdatedEventSchema)({
    after,
    before,
    changeType: 'SET_VERIFICATION',
    evidenceRefs: ['evidence:revocation'],
    officialIdentifierRef: identifierRef,
    partyRef: { ...identifierRef, resourceType: 'party.registry.party' },
    reason: 'New evidence superseded the previous verification',
  });
  expect(event.before).toEqual(before);
  expect(event.after).toEqual(after);
});

it('assertion wire accepts legacy unknown and bounded original ICO digits without changing canonical identity', () => {
  const legacy = {
    identifierType: 'ICO',
    namespace: 'CZ:ICO',
    normalizedValue: '01000004',
    officialIdentifierRef: identifierRef,
    partyRef: { ...identifierRef, resourceType: 'party.registry.party' },
    recordedAt: '2026-01-01T00:00:00.000Z',
    state: 'ACTIVE',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    verification: 'UNVERIFIED',
  };
  expect(decode(OfficialIdentifierAssertionSchema)(legacy).normalizedValue).toBe('01000004');
  for (const originalInputDigits of [null, '1000004', '01000004']) {
    expect(decode(OfficialIdentifierAssertionSchema)({ ...legacy, originalInputDigits }).originalInputDigits).toBe(
      originalInputDigits,
    );
  }
  expect(() => decode(OfficialIdentifierAssertionSchema)({ ...legacy, originalInputDigits: '1000005' })).toThrow();
  expect(() =>
    decode(OfficialIdentifierAssertionSchema)({
      ...legacy,
      identifierType: 'CZ_DIC',
      namespace: 'CZ:DIC',
      normalizedValue: 'CZ01000004',
      originalInputDigits: '01000004',
    }),
  ).toThrow();
  for (const originalInputDigits of ['', '1 000004', '1000004 ', 'x', '001000004', 1_000_004]) {
    expect(() => decode(OfficialIdentifierAssertionSchema)({ ...legacy, originalInputDigits })).toThrow();
  }
});
