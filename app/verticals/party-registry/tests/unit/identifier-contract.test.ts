import { expect, it } from '@app/effect-rstest';
import { Schema } from 'effect';
import {
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
  const ico = decode(OfficialIdentifierInputSchema)({
    identifierType: 'ICO',
    value: '27074358',
    verification: 'VERIFIED',
  });
  expect(normalizeOfficialIdentifier(ico).normalizedValue).toBe('27074358');
  expect(normalizeOfficialIdentifier(ico).namespace).toBe('CZ:ICO');

  const legacyShortIco = decode(OfficialIdentifierInputSchema)({
    identifierType: 'ICO',
    value: '1000004',
    verification: 'VERIFIED',
  });
  expect(normalizeOfficialIdentifier(legacyShortIco).normalizedValue).toBe('01000004');

  const dic = decode(OfficialIdentifierInputSchema)({
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
    decode(OfficialIdentifierInputSchema)({
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
  expect(decode(UpdatePartyOfficialIdentifierPayloadSchema)(command).change.type).toBe(
    'SET_VERIFICATION',
  );
  expect(
    decode(UpdatePartyOfficialIdentifierPayloadSchema)({
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
    decode(UpdatePartyOfficialIdentifierPayloadSchema)({ ...command, evidenceRefs: [] }),
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
