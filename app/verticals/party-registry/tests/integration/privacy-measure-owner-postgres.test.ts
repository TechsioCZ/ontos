import { loadDatabaseConnectionPair } from '@app/core-runtime';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  acquireTestPool,
  makeTestDatabaseFromPool,
  privacyMeasureDeferredCases,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { counterparties, parties, partyRelations, privacyMeasureExecutions } from '../../src/db/schema.ts';
import { privacyMeasureExecutionService } from '../../src/services/privacy-measure-execution.service.ts';
import { hasPostgreSqlCode } from '../support/database-boundary.ts';

const tenantId = 'e1000000-0000-4000-8000-000000000001';
const legalEntityId = 'e2000000-0000-4000-8000-000000000002';
const principalId = 'e3000000-0000-4000-8000-000000000003';
const partyId = 'e4000000-0000-4000-8000-000000000004';
const counterpartyId = 'e5000000-0000-4000-8000-000000000005';
const firstInvocationId = 'e6000000-0000-4000-8000-000000000006';
const replayInvocationId = 'e6000000-0000-4000-8000-000000000007';

const handoff: PrivacyMeasureHandoff = {
  contentScopeRefs: ['party.registry.counterparty.lifecycle'],
  controllerObligationRef: 'obligation:party-owner-postgres',
  dispositionDecision: 'RESTRICT',
  expectedEvidenceRefs: ['party.registry.counterparty.restricted'],
  idempotencyKey: 'party-owner-postgres:1',
  kind: 'RESTRICT',
  measureId: 'measure:party-owner-postgres',
  owningCapability: 'party.registry',
  preconditionRefs: ['decision:party-owner-postgres'],
  requestedAt: '2026-09-14T10:00:00.000Z',
  requestedResult: 'RESTRICTED',
  resourceRefs: [`party.registry|party.registry.counterparty|${legalEntityId}|${counterpartyId}`],
  right: null,
  sourceDecisionRef: 'decision:party-owner-postgres',
  sourceDecisionRevision: 1,
  subjectRef: 'subject:party-owner-postgres',
  taskId: 'task:party-owner-postgres',
  tenantId,
};

it.live('records unsupported Party measures without changing canonical lifecycle state', () =>
  Effect.scoped(
    Effect.gen(function* partyPrivacyMeasurePostgresAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* acquireTestPool(connections.admin.connectionString);
      const runtimePool = yield* acquireTestPool(connections.runtime.connectionString);
      const admin = yield* makeTestDatabaseFromPool(adminPool, partyRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, partyRelations);
      const scope = {
        authMethod: 'system' as const,
        correlationId: 'party-owner-postgres',
        legalEntityId,
        principalId,
        tenantId,
      };
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanPartyOwnerFixture() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.delete(privacyMeasureExecutions).where(eq(privacyMeasureExecutions.tenantId, tenantId));
            yield* transaction.delete(counterparties).where(eq(counterparties.tenantId, tenantId));
            yield* transaction.delete(parties).where(eq(parties.tenantId, tenantId));
          }),
        );
      const execute = (actionInvocationId: string, input = handoff) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* executeInScope() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            const service = yield* privacyMeasureExecutionService(transaction, scope);
            return yield* service.execute(input, actionInvocationId);
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* admin.insert(parties).values({
        currentDisplayName: 'Privacy owner PostgreSQL fixture',
        currentType: 'ORGANIZATION',
        partyId,
        tenantId,
      });
      yield* admin.insert(counterparties).values({
        acceptedByActionInvocationId: firstInvocationId,
        acceptedByPrincipalId: principalId,
        counterpartyId,
        creationReason: 'Privacy owner PostgreSQL acceptance',
        evidenceRefs: ['evidence:party-owner-postgres'],
        legalEntityId,
        partyId,
        policyVersion: 'party.owner-privacy.v1',
        provenanceMethod: 'TEST',
        provenanceSource: 'privacy-owner-postgres',
        sourceRecordRefs: [],
        tenantId,
      });

      const first = yield* execute(firstInvocationId);
      const replay = yield* execute(replayInvocationId);
      expect(first.status).toBe('BUSINESS_REJECTED');
      expect(first.includedResourceRefs).toEqual([]);
      expect(first.remainingResourceRefs).toEqual(handoff.resourceRefs);
      expect(replay).toEqual(first);
      const [counterparty] = yield* admin
        .select({ archivedAt: counterparties.archivedAt })
        .from(counterparties)
        .where(eq(counterparties.counterpartyId, counterpartyId));
      expect(counterparty?.archivedAt).toBeNull();
      expect(
        yield* admin
          .select({ outcomeId: privacyMeasureExecutions.outcomeId })
          .from(privacyMeasureExecutions)
          .where(eq(privacyMeasureExecutions.tenantId, tenantId)),
      ).toEqual([{ outcomeId: first.outcomeId }]);

      const processingRestriction = yield* execute('e6000000-0000-4000-8000-000000000008', {
        ...handoff,
        dispositionDecision: null,
        expectedEvidenceRefs: ['party.registry.counterparty.processing-restricted'],
        idempotencyKey: 'party-owner-postgres:processing-restriction',
        measureId: 'measure:party-owner-postgres:processing-restriction',
        requestedResult: 'ARCHIVED',
        right: 'RESTRICTION',
      });
      expect(processingRestriction.status).toBe('BUSINESS_REJECTED');
      expect(processingRestriction.includedResourceRefs).toEqual([]);
      expect(processingRestriction.remainingResourceRefs).toEqual(handoff.resourceRefs);

      for (const [index, measure] of privacyMeasureDeferredCases.entries()) {
        const later = yield* execute(`e6100000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, {
          ...handoff,
          ...measure,
          idempotencyKey: `party-owner-postgres:${measure.kind.toLowerCase()}`,
          measureId: `measure:party-owner-postgres:${measure.kind.toLowerCase()}`,
          requestedResult: `${measure.kind.toLowerCase()} deferred`,
        });
        expect(later.status).toBe('BUSINESS_REJECTED');
        expect(later.includedResourceRefs).toEqual([]);
        expect(later.remainingResourceRefs).toEqual(handoff.resourceRefs);
      }

      expect(
        (yield* admin
          .select({ archivedAt: counterparties.archivedAt })
          .from(counterparties)
          .where(eq(counterparties.counterpartyId, counterpartyId)))[0]?.archivedAt,
      ).toBeNull();

      yield* admin
        .update(counterparties)
        .set({ archivedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-14T11:00:00.000Z')) })
        .where(eq(counterparties.counterpartyId, counterpartyId));
      yield* admin
        .update(counterparties)
        .set({ archivedAt: null })
        .where(eq(counterparties.counterpartyId, counterpartyId));
      expect(
        (yield* admin
          .select({ archivedAt: counterparties.archivedAt })
          .from(counterparties)
          .where(eq(counterparties.counterpartyId, counterpartyId)))[0]?.archivedAt,
      ).toBeNull();

      const immutableFailure = yield* Effect.flip(
        admin
          .update(privacyMeasureExecutions)
          .set({ occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-14T11:00:00.000Z')) })
          .where(eq(privacyMeasureExecutions.tenantId, tenantId)),
      );
      expect(hasPostgreSqlCode('55000')(immutableFailure)).toBe(true);
    }),
  ),
);
