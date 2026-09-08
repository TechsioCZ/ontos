// @effect-diagnostics globalDate:off -- Existing compatibility boundary; expires: 2026-12-31.
/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- This focused harness models only the Drizzle system boundary used by the Relationship service. expires: 2026-12-31. */
import { DateTime, Effect, Layer, Option, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { PartyAliasWriteRejected } from '../../shared/domain/merge-alias-resolution.ts';
import {
  CreatePartyRelationshipPayloadSchema,
  EndPartyRelationshipPayloadSchema,
  PartyRelationshipCorrectionRequired,
  UpdatePartyRelationshipPayloadSchema,
} from '../../shared/domain/relationship-contract.ts';
import {
  createPartyRelationshipRecord,
  endPartyRelationshipRecord,
  findPartyRelationshipRecord,
  updatePartyRelationshipRecord,
} from '../../src/services/party-relationship-persistence.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const fromPartyId = '20000000-0000-4000-8000-000000000001';
const toPartyId = '30000000-0000-4000-8000-000000000001';
const relationshipId = '40000000-0000-4000-8000-000000000001';
const actionInvocationId = '50000000-0000-4000-8000-000000000001';
const principalId = '60000000-0000-4000-8000-000000000001';
const decodeCreatePayload = Schema.decodeUnknownSync(
  CreatePartyRelationshipPayloadSchema
);
const decodeUpdatePayload = Schema.decodeUnknownSync(
  UpdatePartyRelationshipPayloadSchema
);
const decodeEndPayload = Schema.decodeUnknownSync(
  EndPartyRelationshipPayloadSchema
);

const ref = (resourceId: string) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId,
});

const relationshipRef = {
  moduleId: 'party.registry' as const,
  resourceId: relationshipId,
  resourceType: 'party.registry.party-relationship' as const,
  tenantId,
};

const canonicalEndpointReads = [
  [],
  [{ partyId: fromPartyId }],
  [],
  [{ partyId: toPartyId }],
];

const relationshipRow = (
  overrides: Readonly<Record<string, unknown>> = {}
) => ({
  acceptedByActionInvocationId: actionInvocationId,
  acceptedByPrincipalId: principalId,
  assertionState: 'ACTIVE',
  endEvidenceReference: null,
  endProvenanceMethod: null,
  endProvenanceSource: null,
  endReason: null,
  endedByActionInvocationId: null,
  endedByPrincipalId: null,
  endedRecordedAt: null,
  fromPartyId,
  policyVersion: 'party.relationship.contact-person-of.v1',
  provenanceMethod: 'MANUAL_CONFIRMATION',
  provenanceSource: 'ENGAGEMENT_REVIEW',
  recordedAt: DateTime.toDateUtc(
    DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')
  ),
  relationshipId,
  relationshipType: 'CONTACT_PERSON_OF',
  retractsRelationshipId: null,
  revision: 1,
  supersedesRelationshipId: null,
  tenantId,
  toPartyId,
  validFrom: null,
  validTo: null,
  ...overrides,
});

interface Harness {
  readonly insertValues: readonly Readonly<Record<string, unknown>>[];
  readonly transaction: Parameters<typeof createPartyRelationshipRecord>[0];
  readonly updateSets: readonly Readonly<Record<string, unknown>>[];
}

const transactionHarness = (
  selects: readonly (readonly Readonly<Record<string, unknown>>[])[],
  inserts: readonly (readonly Readonly<Record<string, unknown>>[])[] = [],
  updates: readonly (readonly Readonly<Record<string, unknown>>[])[] = []
): Harness => {
  const selectQueue = [...selects];
  const insertQueue = [...inserts];
  const updateQueue = [...updates];
  const insertValues: Readonly<Record<string, unknown>>[] = [];
  const updateSets: Readonly<Record<string, unknown>>[] = [];
  const select = () => {
    const rows = selectQueue.shift() ?? [];
    const chain = Object.assign(Effect.succeed(rows), {
      for: () => Effect.succeed(rows),
      from: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      where: () => chain,
    });
    return chain;
  };
  const insert = () => {
    const rows = insertQueue.shift() ?? [];
    const chain = {
      returning: () => Effect.succeed(rows),
      values: (values: Readonly<Record<string, unknown>>) => {
        insertValues.push(values);
        return chain;
      },
    };
    return chain;
  };
  const update = () => {
    const rows = updateQueue.shift() ?? [];
    const chain = {
      returning: () => Effect.succeed(rows),
      set: (values: Readonly<Record<string, unknown>>) => {
        updateSets.push(values);
        return chain;
      },
      where: () => chain,
    };
    return chain;
  };
  // SAFETY: the harness implements precisely the select/insert/update fluent surface used here.
  const transaction = { insert, select, update } as unknown as Parameters<
    typeof createPartyRelationshipRecord
  >[0];
  return { insertValues, transaction, updateSets };
};

it.layer(
  Layer.effectDiscard(
    TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T10:00:00.000Z'))
    )
  )
)('relationship persistence', (relationshipIt) => {
  relationshipIt.effect(
    'create persists an active assertion with unknown start and derives current state',
    () =>
      Effect.gen(function* testProgram1() {
        const created = relationshipRow();
        const harness = transactionHarness(
          [
            [
              { archivedAt: null, currentType: 'PERSON', partyId: fromPartyId },
              {
                archivedAt: null,
                currentType: 'ORGANIZATION',
                partyId: toPartyId,
              },
            ],
            ...canonicalEndpointReads,
            [],
          ],
          [[created]]
        );

        const result = yield* createPartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeCreatePayload({
            fromPartyRef: ref(fromPartyId),
            provenance: {
              method: 'MANUAL_CONFIRMATION',
              source: 'ENGAGEMENT_REVIEW',
            },
            relationshipType: 'CONTACT_PERSON_OF',
            toPartyRef: ref(toPartyId),
            validFrom: null,
            validTo: null,
          })
        );

        expect(result.outcome).toBe('CREATED');
        expect(result.relationship.state).toBe('CURRENT');
        expect(harness.insertValues[0]?.['assertionState']).toBe('ACTIVE');
        expect(harness.insertValues[0]?.['validFrom']).toBe(null);
        expect('state' in (harness.insertValues[0] ?? {})).toBe(false);
        expect('isCurrent' in (harness.insertValues[0] ?? {})).toBe(false);
      })
  );

  relationshipIt.effect(
    'update refines an unknown historical validFrom through the persistence service',
    () =>
      Effect.gen(function* testProgram2() {
        const refinedAt = '2025-01-01T00:00:00.000Z';
        const validTo = DateTime.toDateUtc(
          DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')
        );
        const current = relationshipRow({ validTo });
        const updated = relationshipRow({
          revision: 2,
          validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(refinedAt)),
          validTo,
        });
        const harness = transactionHarness(
          [[current], ...canonicalEndpointReads, []],
          [],
          [[updated]]
        );

        const result = yield* updatePartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeUpdatePayload({
            changeReason:
              'Reliable engagement evidence established the relationship start',
            expectedRevision: 1,
            provenance: {
              method: 'DOCUMENT_REVIEW',
              source: 'ENGAGEMENT_RECORD',
            },
            relationshipRef,
            validFrom: refinedAt,
          })
        );

        expect(result.outcome).toBe('CHANGED');
        expect(
          DateTime.formatIso(Option.getOrThrow(result.relationship.validFrom))
        ).toBe(refinedAt);
        expect(result.relationship.state).toBe('HISTORICAL');
        expect(harness.updateSets[0]?.['validFrom']).toEqual(
          DateTime.toDateUtc(DateTime.makeUnsafe(refinedAt))
        );
        expect(harness.updateSets[0]?.['revision']).toBe(2);
      })
  );

  relationshipIt.effect(
    'end keeps a future-ended relationship current and exposes bounded end history',
    () =>
      Effect.gen(function* testProgram3() {
        const effectiveAt = '2099-01-01T00:00:00.000Z';
        const survivorId = '70000000-0000-4000-8000-000000000001';
        const current = relationshipRow({
          validFrom: DateTime.toDateUtc(
            DateTime.makeUnsafe('2025-01-01T00:00:00.000Z')
          ),
        });
        const ended = relationshipRow({
          endProvenanceMethod: 'MANUAL_CONFIRMATION',
          endProvenanceSource: 'ENGAGEMENT_REVIEW',
          endReason: 'A successor contact takes responsibility',
          endedByActionInvocationId: actionInvocationId,
          endedByPrincipalId: principalId,
          endedRecordedAt: DateTime.toDateUtc(
            DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')
          ),
          revision: 2,
          validFrom: DateTime.toDateUtc(
            DateTime.makeUnsafe('2025-01-01T00:00:00.000Z')
          ),
          validTo: DateTime.toDateUtc(DateTime.makeUnsafe(effectiveAt)),
        });
        const harness = transactionHarness(
          [
            [current],
            [
              {
                aliasPartyId: fromPartyId,
                canonicalPartyId: survivorId,
                tenantId,
              },
            ],
            [],
            [{ partyId: survivorId }],
            [],
            [{ partyId: toPartyId }],
          ],
          [],
          [[ended]]
        );

        const result = yield* endPartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeEndPayload({
            effectiveAt,
            expectedRevision: 1,
            provenance: {
              method: 'MANUAL_CONFIRMATION',
              source: 'ENGAGEMENT_REVIEW',
            },
            reason: 'A successor contact takes responsibility',
            relationshipRef,
          })
        );

        expect(result.relationship.state).toBe('CURRENT');
        expect(result.relationship.from.canonicalPartyRef.resourceId).toBe(
          survivorId
        );
        expect(result.relationship.from.storedPartyRef.resourceId).toBe(
          fromPartyId
        );
        expect(result.relationship.endHistory.length).toBe(1);
        const [endEvidence] = result.relationship.endHistory;
        expect(endEvidence).toBeDefined();
        if (endEvidence === undefined) {
          throw new Error('Expected endEvidence');
        }
        expect(DateTime.formatIso(endEvidence.effectiveAt)).toBe(effectiveAt);
        expect(Option.getOrThrow(endEvidence.reason)).toBe(
          'A successor contact takes responsibility'
        );
        expect('state' in (harness.updateSets[0] ?? {})).toBe(false);
        expect('isCurrent' in (harness.updateSets[0] ?? {})).toBe(false);
      })
  );

  relationshipIt.effect(
    'detail derives scheduled state and resolves stored endpoint aliases independently',
    () =>
      Effect.gen(function* testProgram4() {
        const canonicalFrom = '70000000-0000-4000-8000-000000000001';
        const middleAlias = '80000000-0000-4000-8000-000000000001';
        const scheduled = relationshipRow({
          validFrom: DateTime.toDateUtc(
            DateTime.makeUnsafe('2099-01-01T00:00:00.000Z')
          ),
        });
        const harness = transactionHarness([
          [scheduled],
          [
            {
              aliasPartyId: fromPartyId,
              canonicalPartyId: middleAlias,
              tenantId,
            },
          ],
          [
            {
              aliasPartyId: middleAlias,
              canonicalPartyId: canonicalFrom,
              tenantId,
            },
          ],
          [],
          [{ partyId: canonicalFrom }],
          [],
          [{ partyId: toPartyId }],
        ]);

        const detail = yield* findPartyRelationshipRecord(
          harness.transaction,
          tenantId,
          relationshipId
        );

        expect(detail?.state).toBe('SCHEDULED');
        expect(detail?.from.storedPartyRef.resourceId).toBe(fromPartyId);
        expect(detail?.from.canonicalPartyRef.resourceId).toBe(canonicalFrom);
        expect(detail).toBeDefined();
        if (detail === undefined || detail === null) {
          throw new Error('Expected detail');
        }
        expect(Option.getOrThrow(detail.from.requestedAlias).resourceId).toBe(
          fromPartyId
        );
        expect(Option.isNone(detail.to.requestedAlias)).toBe(true);
      })
  );

  relationshipIt.effect(
    'non-active assertions never read as current even with an open effective interval',
    () =>
      Effect.forEach(
        ['RETRACTED', 'SUPERSEDED', 'DISPUTED'],
        (assertionState) =>
          Effect.gen(function* testProgram6() {
            const harness = transactionHarness([
              [relationshipRow({ assertionState })],
              ...canonicalEndpointReads,
            ]);
            const detail = yield* findPartyRelationshipRecord(
              harness.transaction,
              tenantId,
              relationshipId
            );

            expect(detail?.assertionState).toBe(assertionState);
            expect(detail?.state).toBe('HISTORICAL');
          })
      )
  );

  relationshipIt.effect(
    'durable relationship update resolves alias-backed stored endpoints without rewriting them',
    () =>
      Effect.gen(function* testProgram7() {
        const survivorId = '70000000-0000-4000-8000-000000000001';
        const updated = relationshipRow({
          revision: 2,
          validFrom: DateTime.toDateUtc(
            DateTime.makeUnsafe('2099-01-01T00:00:00.000Z')
          ),
        });
        const harness = transactionHarness(
          [
            [relationshipRow()],
            [
              {
                aliasPartyId: fromPartyId,
                canonicalPartyId: survivorId,
                tenantId,
              },
            ],
            [],
            [{ partyId: survivorId }],
            [],
            [{ partyId: toPartyId }],
            [],
          ],
          [],
          [[updated]]
        );
        const result = yield* updatePartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeUpdatePayload({
            changeReason: 'A revised planned start',
            expectedRevision: 1,
            provenance: {
              method: 'MANUAL_CONFIRMATION',
              source: 'ENGAGEMENT_REVIEW',
            },
            relationshipRef,
            validFrom: '2099-01-01T00:00:00.000Z',
          })
        );

        expect(result.outcome).toBe('CHANGED');
        expect(result.relationship.from.canonicalPartyRef.resourceId).toBe(
          survivorId
        );
        expect(result.relationship.from.storedPartyRef.resourceId).toBe(
          fromPartyId
        );
        expect('fromPartyId' in (harness.updateSets[0] ?? {})).toBe(false);
      })
  );

  relationshipIt.effect(
    'create rejects an explicit alias endpoint with canonical survivor guidance',
    () =>
      Effect.gen(function* testProgram8() {
        const survivorId = '70000000-0000-4000-8000-000000000001';
        const harness = transactionHarness([
          [
            {
              archivedAt: DateTime.toDateUtc(
                DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')
              ),
              currentType: 'PERSON',
              partyId: fromPartyId,
            },
            {
              archivedAt: null,
              currentType: 'ORGANIZATION',
              partyId: toPartyId,
            },
          ],
          [
            {
              aliasPartyId: fromPartyId,
              canonicalPartyId: survivorId,
              tenantId,
            },
          ],
          [],
          [{ partyId: survivorId }],
        ]);
        const rejection = yield* createPartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeCreatePayload({
            fromPartyRef: ref(fromPartyId),
            provenance: {
              method: 'MANUAL_CONFIRMATION',
              source: 'ENGAGEMENT_REVIEW',
            },
            relationshipType: 'CONTACT_PERSON_OF',
            toPartyRef: ref(toPartyId),
            validFrom: null,
            validTo: null,
          })
        ).pipe(Effect.flip);

        expect(Predicate.isTagged(rejection, 'PartyAliasWriteRejected')).toBe(
          true
        );
        if (Schema.is(PartyAliasWriteRejected)(rejection)) {
          expect(rejection.canonicalPartyRef.resourceId).toBe(survivorId);
        }
        expect(harness.insertValues.length).toBe(0);
      })
  );

  relationshipIt.effect(
    'a known historical start cannot be rewritten by ordinary update',
    () =>
      Effect.gen(function* testProgram9() {
        const harness = transactionHarness([
          [
            relationshipRow({
              validFrom: DateTime.toDateUtc(
                DateTime.makeUnsafe('2025-01-01T00:00:00.000Z')
              ),
            }),
          ],
          ...canonicalEndpointReads,
        ]);
        const rejection = yield* updatePartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeUpdatePayload({
            changeReason: 'The previous start was wrong',
            expectedRevision: 1,
            provenance: {
              method: 'DOCUMENT_REVIEW',
              source: 'ENGAGEMENT_RECORD',
            },
            relationshipRef,
            validFrom: '2025-02-01T00:00:00.000Z',
          })
        ).pipe(Effect.flip);

        expect(
          Predicate.isTagged(rejection, 'PartyRelationshipCorrectionRequired')
        ).toBe(true);
        if (Schema.is(PartyRelationshipCorrectionRequired)(rejection)) {
          expect(rejection.fact).toBe('validFrom');
        }
        expect(harness.updateSets.length).toBe(0);
      })
  );

  relationshipIt.effect(
    'removing a future planned end clears its current evidence and retains prior audit detail',
    () =>
      Effect.gen(function* testProgram10() {
        const current = relationshipRow({
          endProvenanceMethod: 'MANUAL_CONFIRMATION',
          endProvenanceSource: 'ENGAGEMENT_REVIEW',
          endReason: 'A planned contact handover',
          endedByActionInvocationId: actionInvocationId,
          endedByPrincipalId: principalId,
          endedRecordedAt: DateTime.toDateUtc(
            DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')
          ),
          validTo: DateTime.toDateUtc(
            DateTime.makeUnsafe('2099-01-01T00:00:00.000Z')
          ),
        });
        const updated = relationshipRow({ revision: 2 });
        const harness = transactionHarness(
          [[current], ...canonicalEndpointReads, []],
          [],
          [[updated]]
        );
        const result = yield* updatePartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeUpdatePayload({
            changeReason: 'The planned handover was canceled',
            expectedRevision: 1,
            provenance: {
              method: 'MANUAL_CONFIRMATION',
              source: 'ENGAGEMENT_REVIEW',
            },
            relationshipRef,
            validTo: null,
          })
        );

        expect(result.outcome).toBe('CHANGED');
        expect(Option.isNone(result.relationship.validTo)).toBe(true);
        expect(result.relationship.endHistory).toEqual([]);
        expect(harness.updateSets[0]?.['endReason']).toBe(null);
        expect(harness.updateSets[0]?.['endedRecordedAt']).toBe(null);
        if (result.outcome === 'CHANGED') {
          const [previousEndEvidence] = result.previous.endHistory;
          expect(previousEndEvidence).toBeDefined();
          if (previousEndEvidence === undefined) {
            throw new Error('Expected previousEndEvidence');
          }
          expect(Option.getOrThrow(previousEndEvidence.reason)).toBe(
            'A planned contact handover'
          );
        }
      })
  );

  relationshipIt.effect(
    'update can shorten a future planned end to a valid retrospective end with new evidence',
    () =>
      Effect.gen(function* testProgram11() {
        const validFrom = DateTime.toDateUtc(
          DateTime.makeUnsafe('2025-01-01T00:00:00.000Z')
        );
        const effectiveAt = '2026-02-01T00:00:00.000Z';
        const current = relationshipRow({
          validFrom,
          validTo: DateTime.toDateUtc(
            DateTime.makeUnsafe('2099-01-01T00:00:00.000Z')
          ),
        });
        const updated = relationshipRow({
          endProvenanceMethod: 'DOCUMENT_REVIEW',
          endProvenanceSource: 'ENGAGEMENT_RECORD',
          endReason: 'The handover actually completed earlier',
          endedByActionInvocationId: actionInvocationId,
          endedByPrincipalId: principalId,
          endedRecordedAt: DateTime.toDateUtc(
            DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')
          ),
          revision: 2,
          validFrom,
          validTo: DateTime.toDateUtc(DateTime.makeUnsafe(effectiveAt)),
        });
        const harness = transactionHarness(
          [[current], ...canonicalEndpointReads, []],
          [],
          [[updated]]
        );
        const result = yield* updatePartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeUpdatePayload({
            changeReason: 'The handover actually completed earlier',
            expectedRevision: 1,
            provenance: {
              method: 'DOCUMENT_REVIEW',
              source: 'ENGAGEMENT_RECORD',
            },
            relationshipRef,
            validTo: effectiveAt,
          })
        );

        expect(result.outcome).toBe('CHANGED');
        expect(result.relationship.state).toBe('HISTORICAL');
        const [endEvidence] = result.relationship.endHistory;
        expect(endEvidence).toBeDefined();
        if (endEvidence === undefined) {
          throw new Error('Expected endEvidence');
        }
        expect(DateTime.formatIso(endEvidence.effectiveAt)).toBe(effectiveAt);
        expect(harness.updateSets[0]?.['endProvenanceSource']).toBe(
          'ENGAGEMENT_RECORD'
        );
        expect(harness.updateSets[0]?.['endedByActionInvocationId']).toBe(
          actionInvocationId
        );
      })
  );

  relationshipIt.effect(
    'an evidence-backed end without a generic reason stays visible and retries exactly',
    () =>
      Effect.gen(function* testProgram12() {
        const effectiveAt = '2026-02-01T00:00:00.000Z';
        const ended = relationshipRow({
          endProvenanceMethod: 'DOCUMENT_REVIEW',
          endProvenanceSource: 'ENGAGEMENT_RECORD',
          endedByActionInvocationId: actionInvocationId,
          endedByPrincipalId: principalId,
          endedRecordedAt: DateTime.toDateUtc(
            DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')
          ),
          revision: 2,
          validTo: DateTime.toDateUtc(DateTime.makeUnsafe(effectiveAt)),
        });
        const harness = transactionHarness(
          [[relationshipRow()], ...canonicalEndpointReads],
          [],
          [[ended]]
        );
        const payload = {
          effectiveAt,
          expectedRevision: 1,
          provenance: {
            method: 'DOCUMENT_REVIEW',
            source: 'ENGAGEMENT_RECORD',
          },
          relationshipRef,
        };
        const result = yield* endPartyRelationshipRecord(
          harness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeEndPayload(payload)
        );
        expect(result.relationship.endHistory.length).toBe(1);
        const [endEvidence] = result.relationship.endHistory;
        expect(endEvidence).toBeDefined();
        if (endEvidence === undefined) {
          throw new Error('Expected endEvidence');
        }
        expect(Option.isNone(endEvidence.reason)).toBe(true);
        expect(harness.updateSets[0]?.['endReason']).toBe(null);

        const retryHarness = transactionHarness([
          [ended],
          ...canonicalEndpointReads,
        ]);
        const retry = yield* endPartyRelationshipRecord(
          retryHarness.transaction,
          tenantId,
          principalId,
          actionInvocationId,
          decodeEndPayload({
            ...payload,
            expectedRevision: 2,
          })
        );
        expect(retry.outcome).toBe('UNCHANGED');
        expect(retryHarness.updateSets.length).toBe(0);
      })
  );
});
