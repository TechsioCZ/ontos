import assert from 'node:assert/strict';
import test from 'node:test';
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

test('Official Identifier V1 accepts only IČO and Czech DIČ', () => {
  const ico = decode(OfficialIdentifierInputSchema)({
    identifierType: 'ICO',
    value: '27074358',
    verification: 'VERIFIED',
  });
  assert.equal(normalizeOfficialIdentifier(ico).normalizedValue, '27074358');
  assert.equal(normalizeOfficialIdentifier(ico).namespace, 'CZ:ICO');

  const legacyShortIco = decode(OfficialIdentifierInputSchema)({
    identifierType: 'ICO',
    value: '1000004',
    verification: 'VERIFIED',
  });
  assert.equal(normalizeOfficialIdentifier(legacyShortIco).normalizedValue, '01000004');

  const dic = decode(OfficialIdentifierInputSchema)({
    identifierType: 'CZ_DIC',
    value: 'cz27074358',
    verification: 'VERIFIED',
  });
  assert.equal(normalizeOfficialIdentifier(dic).normalizedValue, 'CZ27074358');
  assert.equal(normalizeOfficialIdentifier(dic).namespace, 'CZ:DIC');

  assert.throws(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'ICO',
      namespace: 'caller-controlled',
      value: '27074358',
      verification: 'VERIFIED',
    }),
  );

  assert.throws(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'ICO',
      value: '270 74 358',
      verification: 'VERIFIED',
    }),
  );

  assert.throws(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'VAT_ID',
      value: 'CZ27074358',
      verification: 'VERIFIED',
    }),
  );
  assert.throws(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'OTHER',
      value: '1',
      verification: 'VERIFIED',
    }),
  );
});

test('Official Identifier writes require tenant Party identity authority and idempotency', () => {
  for (const action of [
    addPartyOfficialIdentifierAction,
    endPartyOfficialIdentifierAction,
    updatePartyOfficialIdentifierAction,
  ]) {
    assert.equal(action.descriptor.legalEntityScope, 'optional');
    assert.equal(action.descriptor.idempotency, 'required');
    // SAFETY: these permission selectors are payload-independent; no handler receives this sentinel.
    assert.equal(action.descriptor.tenantPermission?.({} as never), 'manage_party_identity');
  }
});

test('only verified, formally valid identifiers create deterministic exclusive claim keys', () => {
  assert.equal(
    qualifyingClaimKey(
      {
        identifierType: 'ICO',
        value: '27074358',
        verification: 'VERIFIED',
      },
      'ORGANIZATION',
      'party-exact-claims.v1',
    ),
    'ICO\u0000CZ:ICO\u000027074358',
  );
  assert.equal(
    qualifyingClaimKey(
      {
        identifierType: 'ICO',
        value: '27074358',
        verification: 'UNVERIFIED',
      },
      'ORGANIZATION',
      'party-exact-claims.v1',
    ),
    undefined,
  );
  assert.equal(
    qualifyingClaimKey(
      {
        identifierType: 'ICO',
        value: '27074358',
        verification: 'VERIFIED',
      },
      'PERSON',
      'party-exact-claims.v1',
    ),
    undefined,
  );
  assert.equal(
    qualifyingClaimKey(
      {
        identifierType: 'CZ_DIC',
        value: 'CZ27074358',
        verification: 'VERIFIED',
      },
      'PERSON',
      'party-exact-claims.v1',
    ),
    undefined,
  );
});

const identifierRef = {
  moduleId: 'party.registry',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-official-identifier',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;

test('Identifier Update is a closed evidence-backed metadata or validity command, never an identity patch', () => {
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
  assert.equal(
    decode(UpdatePartyOfficialIdentifierPayloadSchema)(command).change.type,
    'SET_VERIFICATION',
  );
  assert.equal(
    decode(UpdatePartyOfficialIdentifierPayloadSchema)({
      ...command,
      change: { type: 'END_VALIDITY', validTo: '2026-01-01T00:00:00.000Z' },
    }).change.type,
    'END_VALIDITY',
  );
  for (const forbidden of ['value', 'normalizedValue', 'identifierType', 'namespace', 'partyRef']) {
    assert.throws(() =>
      decode(UpdatePartyOfficialIdentifierPayloadSchema)({
        ...command,
        [forbidden]: 'changed-identity',
      }),
    );
  }
  assert.throws(() =>
    decode(UpdatePartyOfficialIdentifierPayloadSchema)({ ...command, evidenceRefs: [] }),
  );
  assert.throws(() =>
    decode(UpdatePartyOfficialIdentifierPayloadSchema)({
      ...command,
      change: { type: 'REPLACE_VALUE', value: '12345678' },
    }),
  );
});

test('Identifier Update event retains before and after verification evidence', () => {
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
  assert.deepEqual(event.before, before);
  assert.deepEqual(event.after, after);
});
