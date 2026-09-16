import { randomUUID } from 'node:crypto';

/* eslint-disable effect-native/no-native-timers -- Real PostgreSQL lock ordering requires wall-clock overlap across connections. expires: 2026-12-31. */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { DateTime, Effect, Fiber, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { PartyCorrectionCommandSchema, PartyCorrectionConflict } from '../../shared/domain/correction-contracts.ts';
import { CreatePartyRelationshipPayloadSchema } from '../../shared/domain/relationship-contract.ts';
import {
  parties,
  partyCorrections,
  partyFactAssertions,
  partyRelations,
  partyRelationships,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';
import { correctPartyFactRecord } from '../../src/services/party-correction.service.ts';
import { createPartyRelationshipRecord } from '../../src/services/party-relationship-persistence.service.ts';
import { openBoundaryDatabases } from '../support/database-boundary.ts';

const tenantId = randomUUID();
const personId = randomUUID();
const organizationId = randomUUID();
const assertionId = randomUUID();
const correctionInvocationId = randomUUID();
const relationshipInvocationId = randomUUID();
const secondPersonId = randomUUID();
const secondOrganizationId = randomUUID();
const secondAssertionId = randomUUID();
const secondCorrectionInvocationId = randomUUID();
const secondRelationshipInvocationId = randomUUID();
const principalId = randomUUID();
type PartyAdmin = Pick<PartyTransaction, 'insert'>;

const makeCorrectionCommand = (partyId: string, targetAssertionId: string) =>
  Schema.decodeSync(PartyCorrectionCommandSchema)({
    evidenceRefs: ['integration:type-relationship'],
    evidenceSource: 'MANUAL_REVIEW',
    factKind: 'PARTY_TYPE',
    partyId: personId,
    policyVersion: 'party-correction.v1',
    provenance: { method: 'MANUAL_REVIEW', source: 'integration:type-relationship' },
    reasonCode: 'WRONG_PARTY_TYPE',
    replacementValue: 'ORGANIZATION',
    subjectEvidence: [
      {
        basis: 'REVIEWED_DOCUMENT',
        evidenceRef: 'integration:type-relationship',
        kind: 'ACTOR_ATTESTATION',
        observedSubject: 'ORGANIZATION',
        statement: 'Reviewed one external organization',
        subjectKey: 'one-subject',
      },
    ],
    targetAssertionId,
  });

const makeRelationshipPayload = (fromPartyId: string, toPartyId: string) =>
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

const seed = (admin: PartyAdmin) =>
  Effect.gen(function* seedFixture() {
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

it.live('Party Type correction and relationship creation serialize in either order without partial state', () =>
  Effect.gen(function* partyTypeRelationshipConcurrency() {
    const { admin, runtime } = yield* openBoundaryDatabases(
      (pool) => makeTestDatabaseFromPool(pool, partyRelations),
      2,
    );
    const runScoped = <Value, Failure>(operation: (transaction: PartyTransaction) => Effect.Effect<Value, Failure>) =>
      runtime.transaction((transaction) =>
        Effect.gen(function* scopedOperation() {
          yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
          return yield* operation(transaction);
        }),
      );
    // Corrections are append-only evidence. Random fixture identities isolate repeated runs
    // without weakening that production invariant through trigger-bypassing cleanup.
    yield* seed(admin);
    const correctionCommand = makeCorrectionCommand(personId, assertionId);
    const relationshipPayload = makeRelationshipPayload(personId, organizationId);
    const correctionFirst = yield* runScoped((transaction) =>
      Effect.gen(function* correctionFirstTransaction() {
        // Hold the corrected Party row before the service starts, forcing Create to wait
        // on the exact lock that correction uses and proving the correction-first ordering.
        yield* transaction
          .select()
          .from(parties)
          .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, personId)))
          .for('update');
        yield* Effect.sleep('100 millis');
        return yield* correctPartyFactRecord(transaction, tenantId, correctionCommand, {
          actionInvocationId: correctionInvocationId,
          principalId,
        });
      }),
    ).pipe(Effect.result, Effect.forkChild);
    yield* Effect.sleep('20 millis');
    const relationAfterCorrection = yield* runScoped((transaction) =>
      createPartyRelationshipRecord(transaction, tenantId, principalId, relationshipInvocationId, relationshipPayload),
    ).pipe(Effect.result);
    const correctionFirstResult = yield* Fiber.join(correctionFirst);
    expect(Result.isSuccess(correctionFirstResult)).toBe(true);
    expect(Result.isFailure(relationAfterCorrection)).toBe(true);

    const afterCorrection = yield* admin
      .select({ currentType: parties.currentType })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, personId)));
    expect(afterCorrection).toEqual([{ currentType: 'ORGANIZATION' }]);
    expect(yield* admin.select().from(partyRelationships).where(eq(partyRelationships.tenantId, tenantId))).toEqual([]);
    expect(yield* admin.select().from(partyCorrections).where(eq(partyCorrections.tenantId, tenantId))).toHaveLength(1);

    const secondCorrectionCommand = makeCorrectionCommand(secondPersonId, secondAssertionId);
    const secondRelationshipPayload = makeRelationshipPayload(secondPersonId, secondOrganizationId);
    const relationshipFirst = yield* runScoped((transaction) =>
      Effect.gen(function* relationshipFirstTransaction() {
        const created = yield* createPartyRelationshipRecord(
          transaction,
          tenantId,
          principalId,
          secondRelationshipInvocationId,
          secondRelationshipPayload,
        );
        yield* Effect.sleep('100 millis');
        return created;
      }),
    ).pipe(Effect.result, Effect.forkChild);
    yield* Effect.sleep('20 millis');
    const correctionAfterRelationship = yield* runScoped((transaction) =>
      correctPartyFactRecord(transaction, tenantId, secondCorrectionCommand, {
        actionInvocationId: secondCorrectionInvocationId,
        principalId,
      }),
    ).pipe(Effect.result);
    const relationshipFirstResult = yield* Fiber.join(relationshipFirst);
    expect(Result.isSuccess(relationshipFirstResult)).toBe(true);
    expect(Result.isFailure(correctionAfterRelationship)).toBe(true);
    if (Result.isFailure(correctionAfterRelationship)) {
      expect(Schema.is(PartyCorrectionConflict)(correctionAfterRelationship.failure)).toBe(true);
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
  }),
);
