import { Effect, Exit, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  PartyDetailResponseSchema,
  PartyFactAssertionSchema,
  PartyHistoricalNameAssertionSchema,
} from '../../shared/apis/party-detail.ts';
import type { PartyHistoricalNameAssertion } from '../../shared/apis/party-detail.ts';
import { PartyPersistenceUnavailable, PartySchema } from '../../shared/domain/identity-contracts.ts';
import type { PartyPersistenceUnavailableError } from '../../shared/domain/identity-contracts.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { partyDetailRead, readPartyDetailFromServices } from '../../src/api/party-detail.read.ts';
import {
  decodePartyHistoricalNameAssertions,
  findPartyHistoricalNameAssertions,
} from '../../src/services/party-detail-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const partyId = '33333333-3333-4333-8333-333333333333';
const otherPartyId = '44444444-4444-4444-8444-444444444444';
const archivedNameId = '55555555-5555-4555-8555-555555555555';
const supersededId = '66666666-6666-4666-8666-666666666666';
const retractedId = '77777777-7777-4777-8777-777777777777';
const partyRefFor = (scopedTenantId: string, resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId: scopedTenantId,
});
const partyRef = partyRefFor(tenantId, partyId);

/**
 * The exact `to_jsonb` image the owner preparation archived: snake_case, timestamps as strings, and
 * every actor, approver, acceptance and provenance column the retired current-store row carried.
 */
const archivedOriginal = {
  accepted_by_action_invocation_id: '88888888-8888-4888-8888-888888888888',
  accepted_by_principal_id: '99999999-9999-4999-8999-999999999999',
  assertion_id: archivedNameId,
  evidence_evaluation: { kind: 'subject_verified' },
  evidence_reference: 'ares/1234567',
  external_evidence: null,
  fact_kind: 'DISPLAY_NAME',
  is_current: false,
  normalized_value: 'Archived name',
  party_id: partyId,
  policy_version: '1',
  provenance_authoritative: true,
  provenance_method: 'owner_recorded',
  provenance_source: 'party_registry',
  // Rendered by `to_jsonb` in the session zone, so the reader must decode the instant, not the text.
  recorded_at: '2026-08-01T12:00:00+02:00',
  retracts_assertion_id: retractedId,
  state: 'SUPERSEDED',
  supersedes_assertion_id: supersededId,
  tenant_id: tenantId,
  valid_from: '2026-08-01T12:00:00+02:00',
  valid_to: '2026-09-01T10:00:00+00:00',
} as const;

const archivedWire = {
  assertionId: archivedNameId,
  factKind: 'DISPLAY_NAME',
  isCurrent: false,
  partyRef,
  recordedAt: '2026-08-01T10:00:00.000Z',
  retractsAssertionId: retractedId,
  state: 'SUPERSEDED',
  supersedesAssertionId: supersededId,
  validFrom: '2026-08-01T10:00:00.000Z',
  validTo: '2026-09-01T10:00:00.000Z',
  value: 'Archived name',
} as const;

const archived = Schema.decodeSync(PartyHistoricalNameAssertionSchema)(archivedWire);
const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  businessName: 'Corrected name',
  createdAt: '2026-09-01T10:00:00.000Z',
  displayName: 'Corrected name',
  firstName: null,
  lastName: null,
  partyRef,
  partyType: 'ORGANIZATION',
  revision: 2,
  updatedAt: '2026-09-03T10:00:00.000Z',
});
const resolvedDirectly = {
  canonicalPartyId: partyId,
  requestedPartyId: partyId,
  traversedAliasIds: [],
  wasAlias: false,
} as const;

const readServices = (
  archiveCalls: string[],
  historicalNames: readonly PartyHistoricalNameAssertion[],
  historicalNamesFailure?: PartyPersistenceUnavailableError,
) => ({
  facts: (_partyId: string, _includeFactHistory: boolean) =>
    Effect.succeed({ currentFactAssertions: [], factHistory: Option.none() }),
  find: (_partyId: string) => Effect.succeed({ _tag: 'found' as const, value: party }),
  historicalNames: (
    canonicalPartyId: string,
  ): Effect.Effect<readonly PartyHistoricalNameAssertion[], PartyPersistenceUnavailableError, never> => {
    archiveCalls.push(canonicalPartyId);
    return historicalNamesFailure === undefined ? Effect.succeed(historicalNames) : Effect.fail(historicalNamesFailure);
  },
  resolve: (_partyId: string) => Effect.succeed(resolvedDirectly),
});

const malformedOriginals: readonly (readonly [string, unknown])[] = [
  ['an absent image', null],
  ['an image that is not an object', 'DISPLAY_NAME'],
  ['a relabelled current fact kind', { ...archivedOriginal, fact_kind: 'BUSINESS_NAME' }],
  ['a state outside the recorded vocabulary', { ...archivedOriginal, state: 'ARCHIVED' }],
  ['a missing recorded time', { ...archivedOriginal, recorded_at: undefined }],
  ['a value that is not text', { ...archivedOriginal, normalized_value: 5 }],
  ['an empty value', { ...archivedOriginal, normalized_value: '' }],
  ['an unparsable period end', { ...archivedOriginal, valid_to: 'not-a-timestamp' }],
  ['a supersede link that is not an assertion identity', { ...archivedOriginal, supersedes_assertion_id: 'nope' }],
  ['provider evidence outside the accepted shape', { ...archivedOriginal, external_evidence: { provider: 'ares' } }],
];

it.effect('the archived display name is not one of the current fact kinds it must never masquerade as', () =>
  Effect.gen(function* verifyArchivedCarrierContract() {
    expect(() => Schema.decodeUnknownSync(PartyFactAssertionSchema)(archivedWire)).toThrow();
    expect(yield* Schema.encodeEffect(PartyHistoricalNameAssertionSchema)(archived)).toEqual(archivedWire);
  }),
);

it.effect('an archived display name keeps its original label, identity, value and period graph', () =>
  Effect.gen(function* verifyArchivedDisplayNameDecode() {
    const decoded = yield* decodePartyHistoricalNameAssertions(tenantId, partyId, [
      { assertionId: archivedNameId, originalAssertion: archivedOriginal },
    ]);
    // The `+02:00` archive text becomes the same instant on the wire, so no local-time string survives.
    expect(yield* Schema.encodeEffect(Schema.Array(PartyHistoricalNameAssertionSchema))(decoded)).toEqual([
      archivedWire,
    ]);
  }),
);

it.effect('the published archived name carries none of the preserved row private metadata', () =>
  Effect.gen(function* verifyArchivedNameProjection() {
    const decoded = yield* decodePartyHistoricalNameAssertions(tenantId, partyId, [
      { assertionId: archivedNameId, originalAssertion: archivedOriginal },
    ]);
    const wire = yield* Schema.encodeEffect(Schema.Array(PartyHistoricalNameAssertionSchema))(decoded);
    expect(wire.flatMap((assertion) => Object.keys(assertion)).toSorted()).toEqual([
      'assertionId',
      'factKind',
      'isCurrent',
      'partyRef',
      'recordedAt',
      'retractsAssertionId',
      'state',
      'supersedesAssertionId',
      'validFrom',
      'validTo',
      'value',
    ]);
  }),
);

it.effect('a malformed archive fails the read instead of yielding partly trusted history', () =>
  Effect.gen(function* verifyMalformedArchive() {
    const outcomes = yield* Effect.forEach(
      malformedOriginals,
      ([label, originalAssertion]) =>
        Effect.exit(
          decodePartyHistoricalNameAssertions(tenantId, partyId, [{ assertionId: archivedNameId, originalAssertion }]),
        ).pipe(Effect.map((exit) => ({ failed: Exit.isFailure(exit), label }))),
      { concurrency: 1 },
    );
    expect(outcomes.filter((outcome) => !outcome.failed)).toEqual([]);
  }),
);

it.effect('an ordinary Party Detail read omits the archived names and never asks the archive', () =>
  Effect.gen(function* verifyOrdinaryRead() {
    const archiveCalls: string[] = [];
    const result = yield* readPartyDetailFromServices(
      partyRef,
      tenantId,
      readServices(archiveCalls, [archived]),
      false,
    );
    expect(result).not.toHaveProperty('historicalNameEvidence');
    expect(archiveCalls).toEqual([]);
    const wire = yield* Schema.encodeEffect(PartyDetailResponseSchema)(result);
    expect(wire.historicalNameEvidence).toBeUndefined();
    expect(wire.currentFactAssertions).toEqual([]);
  }),
);

it.effect('a history Party Detail read answers the archived names beside the current facts', () =>
  Effect.gen(function* verifyHistoryRead() {
    const archiveCalls: string[] = [];
    const result = yield* readPartyDetailFromServices(partyRef, tenantId, readServices(archiveCalls, [archived]), true);
    expect(archiveCalls).toEqual([partyId]);
    const wire = yield* Schema.encodeEffect(PartyDetailResponseSchema)(result);
    expect(wire.historicalNameEvidence).toEqual([archivedWire]);
    // The archived name is evidence, never a current fact: the current projection stays empty.
    expect(wire.currentFactAssertions).toEqual([]);
  }),
);

it.effect('a failing archive read refuses the whole history instead of answering a partial one', () =>
  Effect.gen(function* verifyArchiveFailure() {
    const failure = yield* Effect.flip(
      readPartyDetailFromServices(
        partyRef,
        tenantId,
        readServices(
          [],
          [],
          new PartyPersistenceUnavailable({
            code: 'party_persistence_unavailable',
            reason: 'Archived display names are temporarily unavailable',
          }),
        ),
        true,
      ),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
  }),
);

it.effect('the archive read is tenant- and Party-scoped and answers the original names in recorded order', () =>
  Effect.gen(function* verifyArchiveQuery() {
    const queries: string[] = [];
    const values: (readonly unknown[])[] = [];
    const database = yield* makeTestDatabase((text: string, parameters: readonly unknown[]) =>
      Effect.sync(() => {
        queries.push(text);
        values.push(parameters);
        return [
          Object.fromEntries([
            ['0', archivedNameId],
            ['1', archivedOriginal],
          ]),
        ];
      }),
    );

    const decoded = yield* findPartyHistoricalNameAssertions(database, tenantId, partyId);
    expect(yield* Schema.encodeEffect(Schema.Array(PartyHistoricalNameAssertionSchema))(decoded)).toEqual([
      archivedWire,
    ]);
    // The archive answers the Party it was asked for in the tenant it was asked for, and nothing else.
    expect(values).toEqual([[tenantId, partyId]]);
    const [query = ''] = queries;
    expect(query).toMatch(/"tenant_id" = \$1/u);
    expect(query).toMatch(/"party_id" = \$2/u);
    expect(query).toMatch(/"original_assertion" ->> 'recorded_at'/u);
    // The read never selects actor, approver, acceptance or provenance columns.
    expect(query).not.toMatch(/accepted_by|provenance|principal|invocation|evidence_evaluation/u);
  }),
);

it.effect('the archive is read for the resolved canonical Party and never for a cross-tenant request', () =>
  Effect.gen(function* verifyArchiveScope() {
    const canonicalCalls: string[] = [];
    yield* readPartyDetailFromServices(
      partyRefFor(tenantId, otherPartyId),
      tenantId,
      {
        ...readServices(canonicalCalls, [archived]),
        resolve: () =>
          Effect.succeed({
            canonicalPartyId: partyId,
            requestedPartyId: otherPartyId,
            traversedAliasIds: [otherPartyId],
            wasAlias: true,
          }),
      },
      true,
    );
    expect(canonicalCalls).toEqual([partyId]);

    const crossTenantCalls: string[] = [];
    const refusal = yield* Effect.flip(
      readPartyDetailFromServices(
        partyRefFor(otherTenantId, otherPartyId),
        tenantId,
        readServices(crossTenantCalls, [archived]),
        true,
      ),
    );
    expect(Predicate.isTagged(refusal, 'ReadHandlerNotFound')).toBe(true);
    expect(crossTenantCalls).toEqual([]);
  }),
);

it('the history-only carrier rides the existing identity field grant that already redacts fact history', () => {
  const identityGroup = (partyDetailRead.descriptor.accessFieldGroups ?? []).find(
    (group) => group.key === 'party.registry.party-identity.read',
  );
  expect(identityGroup?.fields).toContain('historicalNameEvidence.value');
  expect(identityGroup?.fields).toContain('factHistory.value');
  // No second capability: the read still declares exactly the one identity field group it had.
  expect((partyDetailRead.descriptor.accessFieldGroups ?? []).length).toBe(1);
});
