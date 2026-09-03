import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
import {
  PartyCandidateSchema,
  IsoTimestampSchema,
  PartyTypeSchema,
  isPartyTypeEnrichment,
  makePartyRef,
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

test('identity timestamps reject impossible calendar dates and rollover times', () => {
  for (const value of [
    '2026-02-30T00:00:00.000Z',
    '2026-13-01T00:00:00.000Z',
    '2026-01-01T24:00:00.000Z',
  ]) {
    assert.throws(() => decode(IsoTimestampSchema)(value));
  }
  assert.equal(decode(IsoTimestampSchema)('2024-02-29T00:00:00Z'), '2024-02-29T00:00:00Z');
});

test('Party Candidate accepts an evidenced identifier without inventing a display name', () => {
  const candidate = decode(PartyCandidateSchema)({
    evidenceRefs: ['source:official-record'],
    officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
    partyType: 'ORGANIZATION',
    provenance: { method: 'IMPORT', source: 'official-register' },
    validFrom: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(candidate.displayName, undefined);
  assert.equal(candidate.officialIdentifiers.length, 1);
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
