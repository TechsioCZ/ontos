import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime, Option, Schema } from 'effect';
import {
  PartyCandidateSchema,
  IsoTimestampSchema,
  PartyNotFound,
  PartySchema,
  PartyTypeSchema,
  isPartyTypeEnrichment,
  makePartyRef,
  partyIdFromString,
} from '../../shared/domain/identity-contracts.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { unarchivePartyAction } from '../../src/actions/unarchive-party.action.ts';
import { updatePartyAction } from '../../src/actions/update-party.action.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { makePartyMatchDecisionRef } from '../../shared/resources/party-match-decision.ts';

const decode = Schema.decodeUnknownSync;

test('Party V1 admits only PERSON, ORGANIZATION, and evidenced UNRESOLVED identity', () => {
  for (const partyType of ['PERSON', 'ORGANIZATION', 'UNRESOLVED']) {
    assert.equal(decode(PartyTypeSchema)(partyType), partyType);
  }
  assert.throws(() => decode(PartyTypeSchema)('OTHER'));
  assert.throws(() =>
    decode(PartyCandidateSchema)({
      displayName: '   ',
      evidenceRefs: [],
      officialIdentifiers: [],
      partyType: 'UNRESOLVED',
      provenance: { method: 'MANUAL', source: 'test' },
      validFrom: '2026-01-01T00:00:00.000Z',
    }),
  );
});

test('Party Type update is enrichment-only; cross-kind changes require Correction', () => {
  assert.equal(isPartyTypeEnrichment('UNRESOLVED', 'PERSON'), true);
  assert.equal(isPartyTypeEnrichment('UNRESOLVED', 'ORGANIZATION'), true);
  assert.equal(isPartyTypeEnrichment('PERSON', 'ORGANIZATION'), false);
  assert.equal(isPartyTypeEnrichment('ORGANIZATION', 'PERSON'), false);
});

test('identity timestamps decode to canonical UTC values', () => {
  assert.throws(() => decode(IsoTimestampSchema)('not-a-timestamp'));
  const leapDay = decode(IsoTimestampSchema)('2024-02-29T00:00:00Z');
  assert.equal(DateTime.formatIso(leapDay), '2024-02-29T00:00:00.000Z');
});

test('Party JSON round-trips timestamps as strings and absent values as null', () => {
  const encoded = {
    archivedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    displayName: null,
    partyRef: makePartyRef(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ),
    partyType: 'UNRESOLVED' as const,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const decoded = decode(PartySchema)(encoded);

  assert.equal(Option.isNone(decoded.archivedAt), true);
  assert.equal(Option.isNone(decoded.displayName), true);
  assert.deepEqual(Schema.encodeSync(PartySchema)(decoded), encoded);
  assert.throws(() => decode(PartySchema)({ ...encoded, archivedAt: undefined }));
  const { displayName: _displayName, ...missingDisplayName } = encoded;
  assert.throws(() => decode(PartySchema)(missingDisplayName));

  const presentEncoded = {
    ...encoded,
    archivedAt: '2026-02-01T00:00:00.000Z',
    displayName: 'Example organization',
  };
  assert.deepEqual(
    Schema.encodeSync(PartySchema)(decode(PartySchema)(presentEncoded)),
    presentEncoded,
  );
});

test('Party Candidate accepts an evidenced identifier without inventing a display name', () => {
  const encoded = {
    evidenceRefs: ['source:official-record'],
    officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
    partyType: 'ORGANIZATION' as const,
    provenance: { method: 'IMPORT', source: 'official-register' },
    validFrom: '2026-01-01T00:00:00.000Z',
  };
  const candidate = decode(PartyCandidateSchema)(encoded);
  assert.equal(candidate.displayName, undefined);
  assert.equal(candidate.officialIdentifiers.length, 1);
  assert.deepEqual(Schema.encodeSync(PartyCandidateSchema)(candidate), encoded);
});

test('Party references retain tenant, module, resource type, and resource identity', () => {
  assert.deepEqual(
    makePartyRef('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
    {
      moduleId: 'party.registry',
      resourceId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'party.registry.party',
      tenantId: '11111111-1111-4111-8111-111111111111',
    },
  );
});

test('Party identity failures retain branded identifiers in encoded JSON', () => {
  const partyId = '22222222-2222-4222-8222-222222222222';
  const failure = new PartyNotFound({
    code: 'party_not_found',
    partyId: partyIdFromString(partyId),
    reason: 'The Party does not exist',
  });

  assert.deepEqual(Schema.encodeSync(PartyNotFound)(failure), {
    _tag: 'PartyNotFound',
    code: 'party_not_found',
    partyId,
    reason: 'The Party does not exist',
  });
});

test('Party identity Actions are tenant-authorized, optionally scoped, and idempotent', () => {
  for (const action of [createPartyAction, updatePartyAction, unarchivePartyAction]) {
    assert.equal(action.descriptor.legalEntityScope, 'optional');
    assert.equal(action.descriptor.idempotency, 'required');
    // SAFETY: These identity permission callbacks are constant and do not inspect payload fields.
    assert.equal(action.descriptor.tenantPermission?.({} as never), 'manage_party_identity');
  }
});

test('Party unarchive declares durable blocked outcomes with case and decision references', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const firstPartyId = '22222222-2222-4222-8222-222222222222';
  const secondPartyId = '33333333-3333-4333-8333-333333333333';
  for (const reasonCode of [
    'EXACT_CLAIM_CONFLICT',
    'EXACT_CLAIM_AMBIGUOUS',
    'OPEN_DUPLICATE_CASE',
    'UNRESOLVED_IDENTITY',
  ]) {
    const result = decode(unarchivePartyAction.descriptor.resultSchema)({
      caseRef: makeDuplicateCandidateCaseRef(tenantId, firstPartyId),
      decisionRef: makePartyMatchDecisionRef(tenantId, secondPartyId),
      outcome: 'BLOCKED',
      party: {
        archivedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        displayName: null,
        partyRef: makePartyRef(tenantId, firstPartyId),
        partyType: 'UNRESOLVED',
        revision: 4,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      reasonCode,
    });
    assert.equal(result.outcome, 'BLOCKED');
    if (result.outcome === 'BLOCKED') {
      assert.equal(result.reasonCode, reasonCode);
    }
  }
});
