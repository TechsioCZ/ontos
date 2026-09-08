import { expect, it } from 'effect-rstest';
import { Effect, DateTime, Option, Schema, Struct } from 'effect';
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

it('Party V1 admits only PERSON, ORGANIZATION, and evidenced UNRESOLVED identity', () => {
  for (const partyType of ['PERSON', 'ORGANIZATION', 'UNRESOLVED']) {
    expect(decode(PartyTypeSchema)(partyType)).toBe(partyType);
  }
  expect(() => decode(PartyTypeSchema)('OTHER')).toThrow();
  expect(() =>
    decode(PartyCandidateSchema)({
      displayName: '   ',
      evidenceRefs: [],
      officialIdentifiers: [],
      partyType: 'UNRESOLVED',
      provenance: { method: 'MANUAL', source: 'test' },
      validFrom: '2026-01-01T00:00:00.000Z',
    }),
  ).toThrow();
});

it('Party Type update is enrichment-only; cross-kind changes require Correction', () => {
  expect(isPartyTypeEnrichment('UNRESOLVED', 'PERSON')).toBe(true);
  expect(isPartyTypeEnrichment('UNRESOLVED', 'ORGANIZATION')).toBe(true);
  expect(isPartyTypeEnrichment('PERSON', 'ORGANIZATION')).toBe(false);
  expect(isPartyTypeEnrichment('ORGANIZATION', 'PERSON')).toBe(false);
});

it('identity timestamps decode to canonical UTC values', () => {
  expect(() => decode(IsoTimestampSchema)('not-a-timestamp')).toThrow();
  const leapDay = decode(IsoTimestampSchema)('2024-02-29T00:00:00Z');
  expect(DateTime.formatIso(leapDay)).toBe('2024-02-29T00:00:00.000Z');
});

it.effect('Party JSON round-trips timestamps as strings and absent values as null', () =>
  Effect.gen(function* verifySchema1() {
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

    expect(Option.isNone(decoded.archivedAt)).toBe(true);
    expect(Option.isNone(decoded.displayName)).toBe(true);
    expect(yield* Schema.encodeEffect(PartySchema)(decoded)).toEqual(encoded);
    expect(() => decode(PartySchema)({ ...encoded, archivedAt: undefined })).toThrow();
    const { displayName: _displayName, ...missingDisplayName } = encoded;
    expect(() => decode(PartySchema)(missingDisplayName)).toThrow();

    const presentEncoded = {
      ...encoded,
      archivedAt: '2026-02-01T00:00:00.000Z',
      displayName: 'Example organization',
    };
    expect(yield* Schema.encodeEffect(PartySchema)(decode(PartySchema)(presentEncoded))).toEqual(
      presentEncoded,
    );
  }),
);

it.effect('Party Candidate accepts an evidenced identifier without inventing a display name', () =>
  Effect.gen(function* verifySchema2() {
    const encoded = {
      evidenceRefs: ['source:official-record'],
      officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
      partyType: 'ORGANIZATION' as const,
      provenance: { method: 'IMPORT', source: 'official-register' },
      validFrom: '2026-01-01T00:00:00.000Z',
    };
    const candidate = decode(PartyCandidateSchema)(encoded);
    expect(candidate.displayName).toBe(undefined);
    expect(candidate.officialIdentifiers.length).toBe(1);
    expect(yield* Schema.encodeEffect(PartyCandidateSchema)(candidate)).toEqual(encoded);
  }),
);

it('Party references retain tenant, module, resource type, and resource identity', () => {
  expect(
    makePartyRef('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
  ).toEqual({
    moduleId: 'party.registry',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'party.registry.party',
    tenantId: '11111111-1111-4111-8111-111111111111',
  });
});

it.effect('Party identity failures retain branded identifiers in encoded JSON', () =>
  Effect.gen(function* verifySchema3() {
    const partyId = '22222222-2222-4222-8222-222222222222';
    const failure = new PartyNotFound({
      code: 'party_not_found',
      partyId: partyIdFromString(partyId),
      reason: 'The Party does not exist',
    });

    const encodedFailure = yield* Schema.encodeEffect(PartyNotFound)(failure);
    expect(Schema.is(Schema.toEncoded(PartyNotFound))(encodedFailure)).toBe(true);
    expect(Struct.omit(encodedFailure, ['_tag'])).toEqual({
      code: 'party_not_found',
      partyId,
      reason: 'The Party does not exist',
    });
  }),
);

it('Party identity Actions are tenant-authorized, optionally scoped, and idempotent', () => {
  for (const action of [createPartyAction, updatePartyAction, unarchivePartyAction]) {
    expect(action.descriptor.legalEntityScope).toBe('optional');
    expect(action.descriptor.idempotency).toBe('required');
    // SAFETY: These identity permission callbacks are constant and do not inspect payload fields.
    expect(action.descriptor.tenantPermission?.({} as never)).toBe('manage_party_identity');
  }
});

it('Party unarchive declares durable blocked outcomes with case and decision references', () => {
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
    expect(result.outcome).toBe('BLOCKED');
    if (result.outcome === 'BLOCKED') {
      expect(result.reasonCode).toBe(reasonCode);
    }
  }
});
