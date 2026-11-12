import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { EffectLogger } from 'drizzle-orm/effect-core';
import { DefaultServices, make } from 'drizzle-orm/effect-postgres';
import { ConfigProvider, Crypto, DateTime, Effect, Layer, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { OrganizationBusinessSourceStatement } from '../../shared/apis/organization-record-facts.ts';
import { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import type { PartyCandidate } from '../../shared/domain/identity-contracts.ts';
import { parties, partyFactAssertions, partyRelations, partyMatchDecisions } from '../../src/db/schema.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import type { PartyClientSourceScope } from '../../src/services/party-client-source-evidence.service.ts';
import {
  createOrMatchParty,
  matchParty,
  recordSourceCreateReceipt,
  recoverPartySourceEffectReceipt,
} from '../../src/services/party-matching-persistence.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'bc110000-0000-4000-8000-000000000001';
const legalEntityId = 'bc120000-0000-4000-8000-000000000001';
const principalId = 'bc130000-0000-4000-8000-000000000001';
const otherPrincipalId = 'bc130000-0000-4000-8000-000000000002';
const source = {
  issuer: 'internal-org-matching',
  namespace: 'organization-register',
  recordType: 'customer',
  routeRef: 'internal-org-matching-route',
};
const instant = '2020-01-01T00:00:00.000Z';
const sentinelFirst = 'LEGACY PRIVATE FIRST SENTINEL';
const sentinelLast = 'LEGACY PRIVATE LAST SENTINEL';
const services = NodeCrypto.layer.pipe(Layer.provideMerge(DefaultServices));
const organization = (businessName: string, recordId: string, occurrenceId: string) =>
  Schema.decodeUnknownEffect(PartyCandidateSchema)({
    partyType: 'ORGANIZATION',
    businessName,
    officialIdentifiers: [],
    evidenceRefs: [],
    validFrom: instant,
    provenance: { source: source.routeRef, method: 'CLIENT_SOURCE_ASSERTION' },
    subjectEvidence: [
      {
        kind: 'CLIENT_SOURCE_ASSERTION',
        source,
        recordId,
        occurrenceId,
        subjectKey: recordId,
        observedSubject: 'ORGANIZATION',
        statement: OrganizationBusinessSourceStatement,
        sourceObservedAt: instant,
      },
    ],
  });

it.layer(services, { excludeTestServices: true })((suite) => {
  suite.effect(
    'bounded organization source decisions use minimal current metadata and preserve receipt identity through replay',
    () =>
      Effect.gen(function* organizationMatching() {
        const clients = yield* openPartyBoundaryClients();
        const crypto = yield* Crypto.Crypto;
        let recording = false;
        let privacy: 'ALLOWED' | 'DENIED' | 'ORGANIZATION_BUSINESS_ALLOWED' = 'ORGANIZATION_BUSINESS_ALLOWED';
        const queries: { readonly query: string; readonly params: unknown[] }[] = [];
        const { runtime } = yield* openBoundaryDatabases(
          (client) =>
            make({ relations: partyRelations }).pipe(
              Effect.provideService(PgClient.PgClient, client),
              Effect.provideService(EffectLogger, {
                logQuery: (query, params) =>
                  Effect.sync(() => {
                    if (recording) {
                      queries.push({ query, params });
                    }
                  }),
              }),
            ),
          clients,
        );
        const grant = yield* registerPartyGatewayScope(clients, { tenantId, legalEntityId });
        const scope = {
          ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            tenantId,
            legalEntityId,
            principalId,
            authMethod: 'api_key',
            authBindingId: principalId,
            authContextRef: 'api_key:internal-organization-matching',
          })),
          correlationId: 'internal-organization-matching',
        };
        const bindings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
          [principalId, otherPrincipalId].map((id) => ({
            ...source,
            tenantId,
            principalId: id,
            authMethod: 'api_key',
          })),
        );
        const completed = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* sourceMatchingTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              const create = (candidate: PartyCandidate, chosen: PartyClientSourceScope = scope) =>
                Effect.gen(function* createSource() {
                  const invocation = yield* crypto.randomUUIDv4();
                  const input = {
                    tenantId,
                    principalId: chosen.principalId,
                    actionInvocationId: invocation,
                    candidate,
                    sourceScope: chosen,
                  };
                  if (chosen.legalEntityId !== undefined) {
                    Object.assign(input, { legalEntityId: chosen.legalEntityId });
                  }
                  const result = yield* createOrMatchParty(transaction, input);
                  yield* recordSourceCreateReceipt(transaction, chosen, invocation, result.decisionRef.resourceId);
                  return result;
                });
              const match = (candidate: PartyCandidate, chosen: PartyClientSourceScope = scope) =>
                Effect.gen(function* matchSource() {
                  const invocation = yield* crypto.randomUUIDv4();
                  const input = { tenantId, actionInvocationId: invocation, candidate, sourceScope: chosen };
                  if (chosen.legalEntityId !== undefined) {
                    Object.assign(input, { legalEntityId: chosen.legalEntityId });
                  }
                  const result = yield* matchParty(transaction, input);
                  yield* recordSourceCreateReceipt(transaction, chosen, invocation, result.decisionRef.resourceId);
                  return result;
                });
              // Explicit lower native Privacy dependency only. This does not claim composed/default-provider acceptance.
              privacy = 'ALLOWED';
              const personal = yield* Schema.decodeUnknownEffect(PartyCandidateSchema)({
                partyType: 'PERSON',
                firstName: sentinelFirst,
                lastName: sentinelLast,
                officialIdentifiers: [],
                evidenceRefs: [],
                validFrom: instant,
                provenance: { source: source.routeRef, method: 'CLIENT_SOURCE_ASSERTION' },
                subjectEvidence: [
                  {
                    kind: 'CLIENT_SOURCE_ASSERTION',
                    source,
                    recordId: 'person-record',
                    occurrenceId: 'person-create',
                    subjectKey: 'person-record',
                    observedSubject: 'PERSON',
                    statement: 'INTERNAL explicit person source declaration',
                    sourceObservedAt: instant,
                  },
                ],
              });
              const person = yield* create(personal);
              assert.isOk(person.outcome === 'CREATED');
              yield* transaction
                .update(parties)
                .set({ currentDisplayName: 'Internal corporation name', businessName: 'Internal corporation name' })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, person.partyRef.resourceId)));
              privacy = 'ORGANIZATION_BUSINESS_ALLOWED';
              const collisionCandidate = yield* organization(
                'Internal corporation name',
                'person-collision-record',
                'person-collision',
              );
              const beforeCollision = yield* transaction
                .select({ partyId: parties.partyId })
                .from(parties)
                .where(eq(parties.tenantId, tenantId));
              recording = true;
              const refusedCreate = yield* create(collisionCandidate).pipe(Effect.flip);
              const refusedMatch = yield* match(collisionCandidate).pipe(Effect.flip);
              recording = false;
              expect(refusedCreate).toMatchObject({ reason: 'organization_business_review_required' });
              expect(refusedMatch).toMatchObject({ reason: 'organization_business_review_required' });
              expect(refusedCreate).not.toHaveProperty('partyRef');
              expect(refusedMatch).not.toHaveProperty('candidateParties');
              const afterCollision = yield* transaction
                .select({ partyId: parties.partyId })
                .from(parties)
                .where(eq(parties.tenantId, tenantId));
              expect(afterCollision).toEqual(beforeCollision);
              const candidate = yield* organization('Unmatched source corporation', 'org-record', 'org-create');
              recording = true;
              const created = yield* create(candidate);
              recording = false;
              assert.isOk(created.outcome === 'CREATED');
              yield* transaction
                .update(parties)
                .set({
                  firstName: sentinelFirst,
                  lastName: sentinelLast,
                  currentDisplayName: `${sentinelFirst} ${sentinelLast}`,
                })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              recording = true;
              const replay = yield* create(candidate);
              const recoveredCreate = yield* recoverPartySourceEffectReceipt(transaction, scope, {
                operation: 'CREATE',
                payload: { candidate },
              });
              const correlatedCandidate = yield* organization(
                'Changed source corporation name',
                'org-record',
                'org-match',
              );
              const matched = yield* match(correlatedCandidate);
              const matchedReplay = yield* match(correlatedCandidate);
              const recoveredMatch = yield* recoverPartySourceEffectReceipt(transaction, scope, {
                operation: 'MATCH',
                payload: { candidate: correlatedCandidate },
              });
              recording = false;
              expect(replay).toEqual({ ...created, replayed: true });
              expect(recoveredCreate).toMatchObject({ outcome: 'COMMITTED', operation: 'CREATE', result: created });
              expect(matched.outcome).toBe('MATCHED');
              expect(matched.candidateParties).toEqual([created.partyRef]);
              expect(matched.evidenceExplanation).toEqual([]);
              expect(matched.caseRef).toBeNull();
              expect(matchedReplay).toEqual(matched);
              expect(recoveredMatch).toMatchObject({ outcome: 'COMMITTED', operation: 'MATCH', result: matched });
              const noMatchCandidate = yield* organization(
                'Entirely unmatched corporation',
                'no-match-record',
                'no-match',
              );
              recording = true;
              const noMatch = yield* match(noMatchCandidate);
              const noMatchReplay = yield* match(noMatchCandidate);
              recording = false;
              expect(noMatch.outcome).toBe('NO_MATCH');
              expect(noMatch.candidateParties).toEqual([]);
              expect(noMatch.evidenceExplanation).toEqual([]);
              expect(noMatchReplay).toEqual(noMatch);
              const malformedPartyId = yield* crypto.randomUUIDv4();
              yield* transaction.insert(parties).values({
                tenantId,
                partyId: malformedPartyId,
                currentType: 'ORGANIZATION',
                businessName: 'Different legacy business value',
                currentDisplayName: 'Malformed legacy organization',
                firstName: sentinelFirst,
                lastName: sentinelLast,
              });
              const malformed = yield* organization(
                'Malformed legacy organization',
                'malformed-record',
                'malformed-weak',
              );
              recording = true;
              expect(yield* create(malformed).pipe(Effect.flip)).toMatchObject({
                reason: 'organization_business_review_required',
              });
              expect(yield* match(malformed).pipe(Effect.flip)).toMatchObject({
                reason: 'organization_business_review_required',
              });
              recording = false;
              for (const currentType of ['UNRESOLVED', 'PERSON'] as const) {
                const displayName = `Internal ${currentType} legacy display`;
                yield* transaction.insert(parties).values({
                  tenantId,
                  currentType,
                  currentDisplayName: displayName,
                  businessName: `Different ${currentType} legacy business`,
                  firstName: sentinelFirst,
                  lastName: sentinelLast,
                  archivedAt: currentType === 'PERSON' ? DateTime.toDateUtc(DateTime.makeUnsafe(instant)) : null,
                });
                const control = yield* organization(displayName, `display-${currentType}`, `display-${currentType}`);
                recording = true;
                expect(yield* create(control).pipe(Effect.flip)).toMatchObject({
                  reason: 'organization_business_review_required',
                });
                expect(yield* match(control).pipe(Effect.flip)).toMatchObject({
                  reason: 'organization_business_review_required',
                });
                recording = false;
              }
              const businessOnly = yield* organization(
                'Different legacy business value',
                'business-only-record',
                'business-only',
              );
              recording = true;
              const businessOnlyResult = yield* match(businessOnly);
              recording = false;
              expect(businessOnlyResult.outcome).toBe('NO_MATCH');
              expect(businessOnlyResult.candidateParties).toEqual([]);
              const weak = yield* organization('Internal corporation name', 'different-org-record', 'weak-occurrence');
              recording = true;
              expect(yield* create(weak).pipe(Effect.flip)).toMatchObject({
                reason: 'organization_business_review_required',
              });
              expect(yield* match(weak).pipe(Effect.flip)).toMatchObject({
                reason: 'organization_business_review_required',
              });
              expect(
                yield* create(candidate, { ...scope, principalId: otherPrincipalId }).pipe(Effect.flip),
              ).toMatchObject({ reason: 'client_source_effect_identity_conflict' });
              expect(
                yield* create(candidate, { ...scope, legalEntityId: 'bc120000-0000-4000-8000-000000000002' }).pipe(
                  Effect.flip,
                ),
              ).toMatchObject({ reason: 'client_source_effect_identity_conflict' });
              const changedInput = yield* organization('Changed same occurrence', 'org-record', 'org-create');
              expect(yield* create(changedInput).pipe(Effect.flip)).toMatchObject({
                reason: 'client_source_effect_identity_conflict',
              });
              const wrongTarget = yield* organization(
                'Source record now wrongly calls person organization',
                'person-record',
                'wrong-type',
              );
              expect(yield* create(wrongTarget).pipe(Effect.flip)).toMatchObject({
                reason: 'client_source_party_no_longer_eligible',
              });
              recording = false;
              privacy = 'ALLOWED';
              const caseCandidate = yield* organization('Internal corporation name', 'case-record', 'old-case');
              const oldCase = yield* create(caseCandidate);
              expect(oldCase.outcome).toBe('AMBIGUOUS');
              privacy = 'ORGANIZATION_BUSINESS_ALLOWED';
              const laterCaseCandidate = yield* organization(
                'Name after ambiguous source declaration',
                'case-record',
                'new-case-occurrence',
              );
              recording = true;
              expect(yield* create(laterCaseCandidate).pipe(Effect.flip)).toMatchObject({
                reason: 'organization_business_review_required',
              });
              expect(yield* match(laterCaseCandidate).pipe(Effect.flip)).toMatchObject({
                reason: 'organization_business_review_required',
              });
              privacy = 'DENIED';
              expect(yield* create(candidate).pipe(Effect.flip)).toMatchObject({
                reason: 'client_source_privacy_denied',
              });
              recording = false;
              privacy = 'ORGANIZATION_BUSINESS_ALLOWED';
              yield* transaction
                .update(parties)
                .set({ archivedAt: DateTime.toDateUtc(DateTime.makeUnsafe(instant)) })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              recording = true;
              expect(yield* create(candidate).pipe(Effect.flip)).toMatchObject({
                reason: 'client_source_party_no_longer_eligible',
              });
              recording = false;
              const outputs = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                created,
                refusedCreate,
                refusedMatch,
                businessOnlyResult,
                replay,
                matched,
                matchedReplay,
                recoveredCreate,
                recoveredMatch,
                noMatch,
                noMatchReplay,
                queries,
              });
              expect(outputs).not.toContain(sentinelFirst);
              expect(outputs).not.toContain(sentinelLast);
              const probes = queries.filter(({ query }) => query.includes('organization_collision'));
              expect(probes.length).toBeGreaterThan(0);
              for (const probe of probes) {
                expect(probe.query).toMatch(/^select exists \(select 1 from /u);
                expect(probe.query).toContain('"current_display_name" =');
                for (const forbidden of [
                  '"party_id"',
                  '"first_name"',
                  '"last_name"',
                  '"business_name"',
                  '"current_type"',
                  '"archived_at"',
                  'party_aliases',
                ]) {
                  expect(probe.query).not.toContain(forbidden);
                }
              }
              for (const command of queries) {
                if (command.query.includes('organization_collision')) {
                  continue;
                }
                const selected = command.query.startsWith('select')
                  ? command.query.split(' from ')[0]
                  : command.query.split(' returning ')[1];
                if (selected === undefined) {
                  continue;
                }
                for (const forbidden of [
                  'first_name',
                  'last_name',
                  'current_display_name',
                  'candidate_snapshot',
                  'evidence_explanation',
                  'provenance_source',
                ]) {
                  expect(selected).not.toContain(forbidden);
                }
                if (selected.includes('evidence_evaluation')) {
                  expect(selected).toContain("->>'sourceInputFingerprint'");
                }
              }
              const [facts] = yield* transaction
                .select({ count: parties.revision })
                .from(parties)
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              expect(facts?.count).toBe(1);
              const originalDecisions = yield* transaction
                .select({ explanation: partyMatchDecisions.evidenceExplanation })
                .from(partyMatchDecisions)
                .where(
                  and(
                    eq(partyMatchDecisions.tenantId, tenantId),
                    eq(partyMatchDecisions.partyId, created.partyRef.resourceId),
                  ),
                );
              expect(originalDecisions.every(({ explanation }) => explanation.length === 0)).toBe(true);
              const types = yield* transaction
                .select({ kind: partyFactAssertions.factKind })
                .from(partyFactAssertions)
                .where(
                  and(
                    eq(partyFactAssertions.tenantId, tenantId),
                    eq(partyFactAssertions.partyId, created.partyRef.resourceId),
                  ),
                );
              expect(types.map(({ kind }) => kind).toSorted()).toEqual(['BUSINESS_NAME', 'PARTY_TYPE']);
              return yield* Effect.fail('internal_organization_matching_rollback' as const);
            }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: bindings }),
              ),
              Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed(privacy) }),
            ),
          )
          .pipe(Effect.result);
        assert.isOk(Result.isFailure(completed));
        expect(completed.failure).toBe('internal_organization_matching_rollback');
      }),
  );
});
