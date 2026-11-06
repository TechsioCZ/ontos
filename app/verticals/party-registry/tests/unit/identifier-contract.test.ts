import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  OfficialIdentifierAssertionSchema,
  OfficialIdentifierInputSchema,
  normalizeOfficialIdentifier,
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
  });
  expect(normalizeOfficialIdentifier(ico).normalizedValue).toBe('27074358');
  expect(normalizeOfficialIdentifier(ico).namespace).toBe('CZ:ICO');

  const legacyShortIco = Schema.decodeSync(OfficialIdentifierInputSchema)({
    identifierType: 'ICO',
    value: '1000004',
  });
  expect(normalizeOfficialIdentifier(legacyShortIco).normalizedValue).toBe('01000004');
  expect(decode(OfficialIdentifierInputSchema)({ identifierType: 'ICO', value: ' 1000004 ' }).value).toBe('1000004');

  const dic = Schema.decodeSync(OfficialIdentifierInputSchema)({
    identifierType: 'CZ_DIC',
    value: 'cz27074358',
  });
  expect(normalizeOfficialIdentifier(dic).normalizedValue).toBe('CZ27074358');
  expect(normalizeOfficialIdentifier(dic).namespace).toBe('CZ:DIC');

  expect(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'ICO',
      namespace: 'caller-controlled',
      value: '27074358',
    }),
  ).toThrow();

  expect(() =>
    Schema.decodeSync(OfficialIdentifierInputSchema)({
      identifierType: 'ICO',
      value: '270 74 358',
    }),
  ).toThrow();

  expect(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'VAT_ID',
      value: 'CZ27074358',
    }),
  ).toThrow();
  expect(() =>
    decode(OfficialIdentifierInputSchema)({
      identifierType: 'OTHER',
      value: '1',
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
    // The one gate decides these Actions from their own declaration, naming the record they act on.
    expect(action.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    expect(action.descriptor.accessTarget).toBeDefined();
  }
});

const identifierRef = {
  moduleId: 'party.registry',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-official-identifier',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;

it('Identifier Update accepts validity end and rejects the removed verification operation', () => {
  const command = {
    change: { type: 'END_VALIDITY', validTo: '2026-01-01T00:00:00.000Z' },
    evidenceRefs: ['evidence:declared-end'],
    officialIdentifierRef: identifierRef,
    reason: 'The declared identifier is no longer current',
  };
  expect(decode(UpdatePartyOfficialIdentifierPayloadSchema)(command).change.type).toBe('END_VALIDITY');
  expect(() =>
    decode(UpdatePartyOfficialIdentifierPayloadSchema)({
      ...command,
      change: { type: 'SET_VERIFICATION', expectedVerification: 'UNVERIFIED', verification: 'VERIFIED' },
    }),
  ).toThrow();
  for (const forbidden of ['value', 'normalizedValue', 'identifierType', 'namespace', 'partyRef']) {
    expect(() =>
      decode(UpdatePartyOfficialIdentifierPayloadSchema)({ ...command, [forbidden]: 'changed-identity' }),
    ).toThrow();
  }
  expect(() => decode(UpdatePartyOfficialIdentifierPayloadSchema)({ ...command, evidenceRefs: [] })).toThrow();
});

it('Identifier validity event retains before and after lifecycle without verification', () => {
  const before = { state: 'ACTIVE', validTo: null };
  const after = { state: 'ENDED', validTo: '2026-01-01T00:00:00.000Z' };
  const event = decode(OfficialIdentifierUpdatedEventSchema)({
    after,
    before,
    changeType: 'END_VALIDITY',
    evidenceRefs: ['evidence:end'],
    officialIdentifierRef: identifierRef,
    partyRef: { ...identifierRef, resourceType: 'party.registry.party' },
    reason: 'The identifier ended',
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
