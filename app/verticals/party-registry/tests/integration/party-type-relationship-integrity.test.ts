import { addTestGatewayScopeGrantCleanup } from '@app/core-runtime/testing/gateway-scope-grant';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { Context, Crypto, DateTime, Deferred, Effect, Fiber, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { PartyCorrectionCommandSchema, PartyCorrectionConflict } from '../../shared/domain/correction-contracts.ts';
import { makePartyRef } from '../../shared/domain/identity-contracts.ts';
import type { PartyType } from '../../shared/domain/identity-contracts.ts';
import { CreatePartyRelationshipPayloadSchema } from '../../shared/domain/relationship-contract.ts';
import {
  parties,
  partyAliases,
  partyCorrections,
  partyFactAssertions,
  partyMerges,
  partyRelations,
  partyRelationships,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';
import { correctPartyFactRecord } from '../../src/services/party-correction.service.ts';
import { createPartyRelationshipRecord } from '../../src/services/party-relationship-persistence.service.ts';
import {
  establishPartyGatewayScope,
  openBoundaryDatabases,
  openPartyBoundaryClients,
  registerPartyGatewayScope,
} from '../support/database-boundary.ts';

const makeFixtureIds = Effect.fnUntraced(function* makeFixtureIds(crypto: Crypto.Crypto) {
  const nextUuid = crypto.randomUUIDv4;
  return {
    tenantId: yield* nextUuid,
    personId: yield* nextUuid,
    organizationId: yield* nextUuid,
    assertionId: yield* nextUuid,
    correctionInvocationId: yield* nextUuid,
    relationshipInvocationId: yield* nextUuid,
    secondPersonId: yield* nextUuid,
    secondOrganizationId: yield* nextUuid,
    secondAssertionId: yield* nextUuid,
    secondCorrectionInvocationId: yield* nextUuid,
    secondRelationshipInvocationId: yield* nextUuid,
    principalId: yield* nextUuid,
  };
});
type FixtureIds = Effect.Success<ReturnType<typeof makeFixtureIds>>;
type PartyAdmin = Pick<PartyTransaction, 'insert'>;

const makeCorrectionCommand = (
  partyId: string,
  targetAssertionId: string,
  replacementValue: Exclude<PartyType, 'UNRESOLVED'> = 'ORGANIZATION',
) =>
  Schema.decodeSync(PartyCorrectionCommandSchema)({
    evidenceRefs: ['integration:type-relationship'],
    evidenceSource: 'MANUAL_REVIEW',
    factKind: 'PARTY_TYPE',
    partyId,
    policyVersion: 'party-correction.v1',
    provenance: { method: 'MANUAL_REVIEW', source: 'integration:type-relationship' },
    reasonCode: 'WRONG_PARTY_TYPE',
    replacementValue,
    subjectEvidence: [
      {
        basis: 'REVIEWED_DOCUMENT',
        evidenceRef: 'integration:type-relationship',
        kind: 'ACTOR_ATTESTATION',
        observedSubject: replacementValue,
        statement: 'Reviewed one external subject',
        subjectKey: 'one-subject',
      },
    ],
    targetAssertionId,
  });

const makeRelationshipPayload = (tenantId: string, fromPartyId: string, toPartyId: string) =>
  Schema.decodeSync(CreatePartyRelationshipPayloadSchema)({
    fromPartyRef: {
      moduleId: 'party.registry',
      resourceId: fromPartyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
    provenance: { method: 'MANUAL_CONFIRMATION', source: 'integration:type-relationship' },
    relationshipType: 'CONTACT_PERSON_OF',
    toPartyRef: {
      moduleId: 'party.registry',
      resourceId: toPartyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
    validFrom: null,
    validTo: null,
  });

const seed = (admin: PartyAdmin, ids: FixtureIds) =>
  Effect.gen(function* seedFixture() {
    const {
      assertionId,
      correctionInvocationId,
      organizationId,
      personId,
      principalId,
      secondAssertionId,
      secondCorrectionInvocationId,
      secondOrganizationId,
      secondPersonId,
      tenantId,
    } = ids;
    yield* admin.insert(parties).values([
      { currentDisplayName: 'Person', currentType: 'PERSON', partyId: personId, tenantId },
      { currentDisplayName: 'Organization', currentType: 'ORGANIZATION', partyId: organizationId, tenantId },
      { currentDisplayName: 'Second Person', currentType: 'PERSON', partyId: secondPersonId, tenantId },
      {
        currentDisplayName: 'Second Organization',
        currentType: 'ORGANIZATION',
        partyId: secondOrganizationId,
        tenantId,
      },
    ]);
    yield* admin.insert(partyFactAssertions).values([
      {
        acceptedByActionInvocationId: correctionInvocationId,
        acceptedByPrincipalId: principalId,
        factKind: 'PARTY_TYPE',
        normalizedValue: 'PERSON',
        partyId: personId,
        policyVersion: 'party-correction.v1',
        provenanceMethod: 'MANUAL_REVIEW',
        provenanceSource: 'integration:type-relationship',
        state: 'ACTIVE',
        tenantId,
        validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z')),
        assertionId,
      },
      {
        acceptedByActionInvocationId: secondCorrectionInvocationId,
        acceptedByPrincipalId: principalId,
        factKind: 'PARTY_TYPE',
        normalizedValue: 'PERSON',
        partyId: secondPersonId,
        policyVersion: 'party-correction.v1',
        provenanceMethod: 'MANUAL_REVIEW',
        provenanceSource: 'integration:type-relationship',
        state: 'ACTIVE',
        tenantId,
        validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z')),
        assertionId: secondAssertionId,
      },
    ]);
  });

// The race below waits on the live clock, so the test stays a live registration and builds Node Crypto in its scope.
const buildNodeCrypto = Layer.build(NodeCrypto.layer).pipe(
  Effect.map((context) => Context.get(context, Crypto.Crypto)),
);

it.live('Party Type correction and relationship creation serialize in either order without partial state', () =>
  Effect.gen(function* partyTypeRelationshipConcurrency() {
    const crypto = yield* buildNodeCrypto;
    const ids = yield* makeFixtureIds(crypto);
    const {
      assertionId,
      correctionInvocationId,
      organizationId,
      personId,
      principalId,
      relationshipInvocationId,
      secondAssertionId,
      secondCorrectionInvocationId,
      secondOrganizationId,
      secondPersonId,
      secondRelationshipInvocationId,
      tenantId,
    } = ids;
    const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 2 });
    const { admin, runtime } = yield* openBoundaryDatabases(
      (client) => makeTestDatabaseFromClient(client, partyRelations),
      clients,
    );
    const gatewayScope = yield* registerPartyGatewayScope(clients, { tenantId }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    );
    yield* addTestGatewayScopeGrantCleanup(clients.admin, [tenantId]);
    const runScoped = <Value, Failure>(operation: (transaction: PartyTransaction) => Effect.Effect<Value, Failure>) =>
      runtime.transaction((transaction) =>
        Effect.gen(function* scopedOperation() {
          yield* establishPartyGatewayScope(transaction, gatewayScope);
          return yield* operation(transaction);
        }),
      );
    // Corrections are append-only evidence. Random fixture identities isolate repeated runs
    // without weakening that production invariant through trigger-bypassing cleanup.
    yield* seed(admin, ids);
    const correctionCommand = makeCorrectionCommand(personId, assertionId);
    const relationshipPayload = makeRelationshipPayload(tenantId, personId, organizationId);
    const correctionFirstLocked = yield* Deferred.make<null>();
    const releaseCorrectionFirst = yield* Deferred.make<null>();
    const correctionFirst = yield* runScoped((transaction) =>
      Effect.gen(function* correctionFirstTransaction() {
        // Hold the corrected Party row before the service starts, forcing Create to wait
        // on the exact lock that correction uses and proving the correction-first ordering.
        yield* transaction
          .select()
          .from(parties)
          .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, personId)))
          .for('update');
        yield* Deferred.succeed(correctionFirstLocked, null);
        yield* Deferred.await(releaseCorrectionFirst);
        return yield* correctPartyFactRecord(transaction, tenantId, correctionCommand, {
          actionInvocationId: correctionInvocationId,
          principalId,
        });
      }),
    ).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(correctionFirstLocked);
    const relationAfterCorrectionFiber = yield* runScoped((transaction) =>
      createPartyRelationshipRecord(transaction, tenantId, principalId, relationshipInvocationId, relationshipPayload),
    ).pipe(Effect.result, Effect.forkChild);
    yield* Effect.sleep('20 millis');
    yield* Deferred.succeed(releaseCorrectionFirst, null);
    const correctionFirstResult = yield* Fiber.join(correctionFirst);
    const relationAfterCorrection = yield* Fiber.join(relationAfterCorrectionFiber);
    expect(Result.isSuccess(correctionFirstResult)).toBe(true);
    expect(Result.isFailure(relationAfterCorrection)).toBe(true);

    const afterCorrection = yield* admin
      .select({ currentType: parties.currentType })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, personId)));
    expect(afterCorrection).toEqual([{ currentType: 'ORGANIZATION' }]);
    expect(yield* admin.select().from(partyRelationships).where(eq(partyRelationships.tenantId, tenantId))).toEqual([]);
    expect(yield* admin.select().from(partyCorrections).where(eq(partyCorrections.tenantId, tenantId))).toHaveLength(1);

    const secondCorrectionCommand = makeCorrectionCommand(secondPersonId.toUpperCase(), secondAssertionId);
    const secondRelationshipPayload = makeRelationshipPayload(tenantId, secondPersonId, secondOrganizationId);
    const relationshipCreated = yield* Deferred.make<null>();
    const releaseRelationshipFirst = yield* Deferred.make<null>();
    const relationshipFirst = yield* runScoped((transaction) =>
      Effect.gen(function* relationshipFirstTransaction() {
        const created = yield* createPartyRelationshipRecord(
          transaction,
          tenantId,
          principalId,
          secondRelationshipInvocationId,
          secondRelationshipPayload,
        );
        yield* Deferred.succeed(relationshipCreated, null);
        yield* Deferred.await(releaseRelationshipFirst);
        return created;
      }),
    ).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(relationshipCreated);
    const correctionAfterRelationshipFiber = yield* runScoped((transaction) =>
      correctPartyFactRecord(transaction, tenantId, secondCorrectionCommand, {
        actionInvocationId: secondCorrectionInvocationId,
        principalId,
      }),
    ).pipe(Effect.result, Effect.forkChild);
    yield* Effect.sleep('20 millis');
    yield* Deferred.succeed(releaseRelationshipFirst, null);
    const relationshipFirstResult = yield* Fiber.join(relationshipFirst);
    const correctionAfterRelationship = yield* Fiber.join(correctionAfterRelationshipFiber);
    expect(Result.isSuccess(relationshipFirstResult)).toBe(true);
    expect(Result.isFailure(correctionAfterRelationship)).toBe(true);
    if (Result.isFailure(correctionAfterRelationship)) {
      expect(Schema.is(PartyCorrectionConflict)(correctionAfterRelationship.failure)).toBe(true);
      if (Schema.is(PartyCorrectionConflict)(correctionAfterRelationship.failure)) {
        expect(correctionAfterRelationship.failure.conflictingRelationshipRefs).toHaveLength(1);
      }
    }

    const afterRejectedCorrection = yield* admin
      .select({ currentType: parties.currentType })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, secondPersonId)));
    expect(afterRejectedCorrection).toEqual([{ currentType: 'PERSON' }]);
    expect(
      yield* admin
        .select()
        .from(partyRelationships)
        .where(inArray(partyRelationships.tenantId, [tenantId])),
    ).toHaveLength(1);
    expect(yield* admin.select().from(partyCorrections).where(eq(partyCorrections.tenantId, tenantId))).toHaveLength(1);
    // Compatible incoming rows must not consume the SQL limit before the outgoing conflict.
    const compatiblePeople = yield* Effect.all(Array.from({ length: 33 }, () => crypto.randomUUIDv4));
    const compatibleRelationships = yield* Effect.all(
      compatiblePeople.map((fromPartyId) =>
        Effect.all({
          actionInvocationId: crypto.randomUUIDv4,
          fromPartyId: Effect.succeed(fromPartyId),
          relationshipUuid: crypto.randomUUIDv4,
        }),
      ),
    );
    yield* admin.insert(parties).values(
      compatiblePeople.map((partyId) => ({
        currentType: 'PERSON',
        partyId,
        tenantId,
      })),
    );
    yield* admin.insert(partyRelationships).values(
      compatibleRelationships.map(({ actionInvocationId, fromPartyId, relationshipUuid }) => ({
        relationshipId: `00000000${relationshipUuid.slice(8)}`,
        tenantId,
        fromPartyId,
        toPartyId: secondPersonId,
        relationshipType: 'CONTACT_PERSON_OF',
        provenanceMethod: 'MANUAL_CONFIRMATION',
        provenanceSource: 'integration:legacy-compatible',
        acceptedByActionInvocationId: actionInvocationId,
        acceptedByPrincipalId: principalId,
        policyVersion: 'party-relationship.v1',
      })),
    );
    const extraOrganizationId = yield* crypto.randomUUIDv4;
    const finalConflictId = `ffffffff${(yield* crypto.randomUUIDv4).slice(8)}`;
    yield* admin.insert(parties).values({ partyId: extraOrganizationId, tenantId, currentType: 'ORGANIZATION' });
    yield* admin.insert(partyRelationships).values({
      relationshipId: finalConflictId,
      tenantId,
      fromPartyId: secondPersonId,
      toPartyId: extraOrganizationId,
      relationshipType: 'CONTACT_PERSON_OF',
      provenanceMethod: 'MANUAL_CONFIRMATION',
      provenanceSource: 'integration:bounded-conflict',
      acceptedByActionInvocationId: yield* crypto.randomUUIDv4,
      acceptedByPrincipalId: principalId,
      policyVersion: 'party-relationship.v1',
    });
    const conflictInvocationId = yield* crypto.randomUUIDv4;
    const conflict = yield* runScoped((transaction) =>
      correctPartyFactRecord(transaction, tenantId, secondCorrectionCommand, {
        actionInvocationId: conflictInvocationId,
        principalId,
      }),
    ).pipe(Effect.flip);
    expect(Schema.is(PartyCorrectionConflict)(conflict)).toBe(true);
    if (Schema.is(PartyCorrectionConflict)(conflict)) {
      expect(conflict.conflictingRelationshipRefs).toHaveLength(2);
      expect(conflict.conflictingRelationshipRefs?.map(({ resourceId }) => resourceId)).toContain(finalConflictId);
    }

    for (const currentType of ['PERSON', 'ORGANIZATION'] as const) {
      const canonicalId = yield* crypto.randomUUIDv4;
      const intermediateAliasId = yield* crypto.randomUUIDv4;
      const storedEndpointId = yield* crypto.randomUUIDv4;
      const targetAssertionId = yield* crypto.randomUUIDv4;
      const retainedRelationshipId = yield* crypto.randomUUIDv4;
      const mergeId = yield* crypto.randomUUIDv4;
      const nextType = currentType === 'PERSON' ? 'ORGANIZATION' : 'PERSON';
      yield* admin.insert(parties).values(
        [canonicalId, intermediateAliasId, storedEndpointId].map((partyId) => ({
          currentType,
          partyId,
          tenantId,
        })),
      );
      yield* admin.insert(partyFactAssertions).values({
        acceptedByActionInvocationId: yield* crypto.randomUUIDv4,
        acceptedByPrincipalId: principalId,
        assertionId: targetAssertionId,
        factKind: 'PARTY_TYPE',
        normalizedValue: currentType,
        partyId: canonicalId,
        policyVersion: 'party-correction.v1',
        provenanceMethod: 'MANUAL_REVIEW',
        provenanceSource: 'integration:retained-alias',
        state: 'ACTIVE',
        tenantId,
        validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z')),
      });
      const mergePartyRefs = [canonicalId, intermediateAliasId, storedEndpointId].map((partyId) =>
        makePartyRef(tenantId, partyId),
      );
      const survivorPartyRef = makePartyRef(tenantId, canonicalId);
      const candidateSnapshots = mergePartyRefs.map((partyRef) => ({
        candidate: {
          authoritativeEvidenceRank: 1,
          blockingAuthoritativeConflict: false,
          completenessRank: 1,
          createdAt: '2020-01-01T00:00:00.000Z',
          lifecycle: 'ACTIVE' as const,
          partyRef,
          referenceStabilityRank: 1,
        },
        criterionValue: true,
        eligibleBefore: true,
        retainedAfter: true,
      }));
      // Seed retained endpoints through the existing prepared-only merge schema.
      // This does not enable or execute the disabled production merge Action.
      yield* admin.insert(partyMerges).values({
        mergeId,
        policyVersion: 'party.merge-readiness.v1',
        readinessEvidence: {
          absorbedPartyRefs: mergePartyRefs.slice(1),
          blockingReasons: ['Consumer dry-run is required'],
          confirmedDuplicateDecisionId: 'confirmed-duplicate:retained-alias-fixture',
          consumerStatuses: [{ consumerKey: 'contacts', status: 'BLOCKED' }],
          decisionActorPrincipalId: principalId,
          selectionEvidenceChain: (
            ['CONFIRMED_DUPLICATE_SET', 'IDENTITY_SAFETY', 'STABLE_RESOURCE_IDENTITY'] as const
          ).map((criterion) => ({
            candidatePartyRefs: mergePartyRefs,
            candidateSnapshots,
            criterion,
            evidenceRefs: ['integration:retained-alias'],
            explanation: 'Prepared-only retained alias fixture',
            winnerPartyRef: criterion === 'STABLE_RESOURCE_IDENTITY' ? survivorPartyRef : null,
          })),
          selectionPolicyVersion: 'party-merge-survivor-selection.v1',
          selectionReason: 'STABLE_RESOURCE_IDENTITY',
          version: 1,
        },
        status: 'BLOCKED',
        survivorPartyId: canonicalId,
        tenantId,
      });
      yield* admin.insert(partyAliases).values([
        { aliasPartyId: intermediateAliasId, canonicalPartyId: canonicalId, mergeId, tenantId },
        { aliasPartyId: storedEndpointId, canonicalPartyId: intermediateAliasId, mergeId, tenantId },
      ]);
      yield* admin.insert(partyRelationships).values({
        acceptedByActionInvocationId: yield* crypto.randomUUIDv4,
        acceptedByPrincipalId: principalId,
        fromPartyId: currentType === 'PERSON' ? storedEndpointId : secondPersonId,
        policyVersion: 'party-relationship.v1',
        provenanceMethod: 'MANUAL_CONFIRMATION',
        provenanceSource: 'integration:retained-alias',
        relationshipId: retainedRelationshipId,
        relationshipType: 'CONTACT_PERSON_OF',
        tenantId,
        toPartyId: currentType === 'ORGANIZATION' ? storedEndpointId : secondOrganizationId,
      });
      const rejectedInvocationId = yield* crypto.randomUUIDv4;
      const rejected = yield* runScoped((transaction) =>
        correctPartyFactRecord(
          transaction,
          tenantId,
          makeCorrectionCommand(canonicalId.toUpperCase(), targetAssertionId, nextType),
          { actionInvocationId: rejectedInvocationId, principalId },
        ),
      ).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) {
        expect(Schema.is(PartyCorrectionConflict)(rejected.failure)).toBe(true);
        if (Schema.is(PartyCorrectionConflict)(rejected.failure)) {
          expect(rejected.failure.conflictingRelationshipRefs?.map(({ resourceId }) => resourceId)).toEqual([
            retainedRelationshipId,
          ]);
        }
      }
      expect(
        yield* admin.select({ currentType: parties.currentType }).from(parties).where(eq(parties.partyId, canonicalId)),
      ).toEqual([{ currentType }]);
      expect(
        yield* admin.select().from(partyFactAssertions).where(eq(partyFactAssertions.partyId, canonicalId)),
      ).toHaveLength(1);
      expect(yield* admin.select().from(partyCorrections).where(eq(partyCorrections.tenantId, tenantId))).toHaveLength(
        1,
      );
    }
  }),
);
