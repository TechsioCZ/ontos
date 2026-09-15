import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  dispositionDecisions,
  legalHolds,
  ownerExecutionOutcomes,
  privacyMeasureDispatches,
  privacyRelations,
  retentionEvaluationWork,
  retentionExceptions,
  retentionRules,
} from '../../src/database/schema.ts';

const tenantId = 'e7000000-0000-4000-8000-000000000001';
const legalEntityId = 'e7000000-0000-4000-8000-000000000002';
const otherTenantId = 'e7000000-0000-4000-8000-000000000009';
const evaluatedAt = new Date('2026-09-14T12:00:00.000Z');

interface RoutineWorkRecord {
  readonly evaluatedAt?: unknown;
  readonly status?: unknown;
  readonly workerEvaluation?: {
    readonly blockerRefs?: unknown;
    readonly controllerRef?: unknown;
    readonly evaluationRef?: unknown;
    readonly evidenceRefs?: unknown;
    readonly outcome?: unknown;
    readonly policyRef?: unknown;
    readonly policyVersion?: unknown;
    readonly provenanceRef?: unknown;
  };
}

interface RoutineRow {
  readonly blocker_refs: readonly string[];
  readonly evaluated_at: Date | string | null;
  readonly outcome: string;
  readonly owner_outcome_ref: string | null;
  readonly [key: string]: Date | RoutineWorkRecord | readonly string[] | string | null;
  readonly reason: string;
  readonly status: string | null;
  readonly work_record: RoutineWorkRecord | null;
  readonly work_ref: string | null;
}

const one = <Row>(rows: readonly Row[]): Row => {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected one retention routine result row');
  }
  return row;
};

const pool = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString, max: 4 })),
    (clientPool) => Effect.promise(() => clientPool.end()).pipe(Effect.orDie),
  );

const ruleRecord = (ruleRef: string, contentScopeRef: string, ruleVersion = 1) => ({
  applicability: 'PROSPECTIVE_ONLY',
  authorityRef: 'authority:privacy-retention',
  businessStartAt: '2026-08-01T00:00:00Z',
  businessStartRef: 'business-event:record-created',
  contentScopeRef,
  controllerRef: 'controller:privacy-test',
  dispositionOutcome: 'DELETE',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  evidenceRefs: [`evidence:${ruleRef}:${ruleVersion}`],
  policyRef: 'policy:privacy-retention-test',
  policyVersion: '1',
  provenanceRef: `provenance:${ruleRef}:${ruleVersion}`,
  retentionWindow: { durationDays: 30, kind: 'DURATION' },
  retroactiveApprovalRef: null,
  ruleRef,
  ruleVersion,
  ruleVersionId: `rule-version:${ruleRef}:${ruleVersion}`,
});

const workRecord = (workRef: string, ruleRef: string, contentScopeRef: string, dueAt: string, ruleVersion = 1) => ({
  businessStartAt: '2026-08-01T00:00:00Z',
  businessStartRef: 'business-event:record-created',
  contentScopeRefs: [contentScopeRef],
  controllerRef: 'controller:privacy-test',
  dispositionOutcome: 'DELETE',
  dueAt,
  evaluatedAt: null,
  evidenceRefs: [`evidence:${ruleRef}:${ruleVersion}`],
  idempotencyRef: `idempotency:${workRef}`,
  policyRef: 'policy:privacy-retention-test',
  policyVersion: 1,
  provenanceRef: `provenance:${ruleRef}:${ruleVersion}`,
  ruleAuthorityRef: 'authority:privacy-retention',
  ruleRef,
  ruleVersion,
  ruleVersionId: `rule-version:${ruleRef}:${ruleVersion}`,
  source: 'PERIODIC',
  status: 'PENDING',
  workRef,
});

it.live('rechecks current PostgreSQL state, catches up overdue work, and completes only from owner outcome', () =>
  Effect.scoped(
    Effect.gen(function* retentionWorkerPostgresAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* pool(connections.admin.connectionString);
      const runtimePool = yield* pool(connections.runtime.connectionString);
      const admin = yield* makeTestDatabaseFromPool(adminPool, privacyRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, privacyRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanRetentionFixtures() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.delete(ownerExecutionOutcomes).where(eq(ownerExecutionOutcomes.tenantId, tenantId));
            yield* transaction.delete(privacyMeasureDispatches).where(eq(privacyMeasureDispatches.tenantId, tenantId));
            yield* transaction.delete(dispositionDecisions).where(eq(dispositionDecisions.tenantId, tenantId));
            yield* transaction.delete(retentionEvaluationWork).where(eq(retentionEvaluationWork.tenantId, tenantId));
            yield* transaction.delete(legalHolds).where(eq(legalHolds.tenantId, tenantId));
            yield* transaction.delete(retentionExceptions).where(eq(retentionExceptions.tenantId, tenantId));
            yield* transaction.delete(retentionRules).where(eq(retentionRules.tenantId, tenantId));
          }),
        );

      const invoke = (workRef: string, messageId: string, at = evaluatedAt, scopeTenantId = tenantId) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* invokeInScope() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${scopeTenantId}, true),
                         set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            return yield* transaction
              .execute<RoutineRow>(
                sql`select * from privacy.process_retention_evaluation_work(
                  ${tenantId}::uuid,
                  ${legalEntityId}::uuid,
                  ${workRef}::text,
                  ${messageId}::uuid,
                  ${at}::timestamptz
                )`,
                'objects',
              )
              .pipe(Effect.map(one));
          }),
        );

      const insertRule = (ruleRef: string, contentScopeRef: string, invocationId: string, ruleVersion = 1) =>
        admin.insert(retentionRules).values({
          actionInvocationId: invocationId,
          contentScopeRef,
          effectiveFrom: new Date(ruleVersion === 1 ? '2026-01-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z'),
          legalEntityId,
          ruleRecord: {
            ...ruleRecord(ruleRef, contentScopeRef, ruleVersion),
            effectiveFrom: ruleVersion === 1 ? '2026-01-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z',
          },
          ruleRef,
          ruleVersion,
          tenantId,
        });

      const insertWork = (workRef: string, ruleRef: string, contentScopeRef: string, dueAt: string, ruleVersion = 1) =>
        admin.insert(retentionEvaluationWork).values({
          dueAt: new Date(dueAt),
          idempotencyRef: `idempotency:${workRef}`,
          legalEntityId,
          ruleRef,
          ruleVersion,
          status: 'PENDING',
          tenantId,
          workRecord: workRecord(workRef, ruleRef, contentScopeRef, dueAt, ruleVersion),
          workRef,
        });

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const readyRuleRef = 'retention:worker-ready';
      const readyScope = 'customer.contact.email';
      const readyWorkRef = 'retention-work:postgres-ready';
      const readyMessageId = 'e7100000-0000-4000-8000-000000000001';
      yield* insertRule(readyRuleRef, readyScope, 'e7200000-0000-4000-8000-000000000001');
      yield* insertWork(readyWorkRef, readyRuleRef, readyScope, '2026-08-31T00:00:00.000Z');

      const ready = yield* invoke(readyWorkRef, readyMessageId);
      expect(ready.outcome).toBe('EVALUATED');
      expect(ready.status).toBe('READY');
      expect(ready.work_record?.status).toBe('READY');
      expect(ready.work_record?.evaluatedAt).toBe('2026-09-14T12:00:00.000Z');
      expect(ready.work_record?.workerEvaluation).toMatchObject({
        blockerRefs: [],
        controllerRef: 'controller:privacy-test',
        evaluationRef: readyWorkRef,
        evidenceRefs: [`evidence:${readyRuleRef}:1`],
        outcome: 'DELETE',
        policyRef: 'policy:privacy-retention-test',
        policyVersion: 1,
        provenanceRef: `provenance:${readyRuleRef}:1`,
      });

      const legacyRuleRef = 'retention:worker-legacy';
      const legacyScope = 'customer.contact.legacy';
      const legacyWorkRef = 'retention-work:postgres-legacy';
      const legacyRule = ruleRecord(legacyRuleRef, legacyScope);
      const {
        controllerRef: _controllerRef,
        dispositionOutcome: _dispositionOutcome,
        evidenceRefs: _evidenceRefs,
        policyRef: _policyRef,
        policyVersion: _policyVersion,
        provenanceRef: _provenanceRef,
        ...legacyRuleRecord
      } = legacyRule;
      yield* admin.insert(retentionRules).values({
        actionInvocationId: 'e7200000-0000-4000-8000-000000000007',
        contentScopeRef: legacyScope,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        legalEntityId,
        ruleRecord: legacyRuleRecord,
        ruleRef: legacyRuleRef,
        ruleVersion: 1,
        tenantId,
      });
      yield* insertWork(legacyWorkRef, legacyRuleRef, legacyScope, '2026-08-31T00:00:00.000Z');
      const legacy = yield* invoke(legacyWorkRef, 'e7100000-0000-4000-8000-000000000007');
      expect(legacy.outcome).toBe('STATE_UNAVAILABLE');
      expect(legacy.status).toBe('INDETERMINATE');
      expect(legacy.reason).toBe('AUTHORITATIVE_EVALUATION_INCOMPLETE');

      const mismatchedDueRuleRef = 'retention:worker-due-mismatch';
      const mismatchedDueScope = 'customer.contact.due-mismatch';
      const mismatchedDueWorkRef = 'retention-work:postgres-due-mismatch';
      yield* insertRule(mismatchedDueRuleRef, mismatchedDueScope, 'e7200000-0000-4000-8000-000000000008');
      yield* insertWork(mismatchedDueWorkRef, mismatchedDueRuleRef, mismatchedDueScope, '2026-09-01T00:00:00.000Z');
      const mismatchedDue = yield* invoke(mismatchedDueWorkRef, 'e7100000-0000-4000-8000-000000000008');
      expect(mismatchedDue.outcome).toBe('STATE_AMBIGUOUS');
      expect(mismatchedDue.status).toBe('INDETERMINATE');
      expect(mismatchedDue.reason).toBe('AUTHORITATIVE_DUE_AT_MISMATCH');

      const replay = yield* invoke(readyWorkRef, readyMessageId, new Date('2026-09-15T12:00:00.000Z'));
      expect(replay.outcome).toBe('REPLAY');
      expect(new Date(replay.evaluated_at ?? 0).toISOString()).toBe(evaluatedAt.toISOString());

      const mismatchedHoldRelease = yield* Effect.flip(
        admin.insert(legalHolds).values({
          actionInvocationId: 'e7200000-0000-4000-8000-000000000010',
          effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-10-01T00:00:00.000Z'),
          holdRecord: {
            actorPrincipalRef: 'principal:retention-test',
            authorityKind: 'LEGAL_HOLD_AUTHORITY',
            authorityRef: 'authority:legal',
            contentScopeRefs: [readyScope],
            controllerRef: 'controller:privacy-test',
            effectiveFrom: '2026-09-01T00:00:00.000Z',
            effectiveTo: '2026-10-01T00:00:00.000Z',
            evidenceRefs: ['evidence:hold:release-mismatch'],
            holdRef: 'hold:release-mismatch',
            policyRef: 'policy:privacy-retention-test',
            policyVersion: 1,
            provenanceRef: 'provenance:hold:release-mismatch',
            reasonTypeRef: 'reason:legal-hold',
            reasonTypeVersion: 1,
            releaseConditionRef: 'condition:hold-released',
            releasedAt: '2026-09-12T00:00:00.000Z',
            releasedByPrincipalRef: 'principal:retention-test',
            releaseEvidenceRefs: ['evidence:hold-release'],
            releaseReasonRef: 'reason:hold-released',
            releaseRef: 'release:hold:release-mismatch',
            reviewDueAt: '2026-09-20T00:00:00.000Z',
            reviewedAt: null,
            reviewEvidenceRefs: [],
            reviewRef: 'review:hold:release-mismatch',
          },
          holdRef: 'hold:release-mismatch',
          legalEntityId,
          recordedAt: new Date('2026-09-10T00:00:00.000Z'),
          releasedAt: new Date('2026-09-13T00:00:00.000Z'),
          tenantId,
        }),
      );
      expect(mismatchedHoldRelease).toBeDefined();

      const mismatchedExceptionRelease = yield* Effect.flip(
        admin.insert(retentionExceptions).values({
          actionInvocationId: 'e7200000-0000-4000-8000-000000000011',
          effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-10-01T00:00:00.000Z'),
          exceptionRecord: {
            actorPrincipalRef: 'principal:retention-test',
            authorityKind: 'EXCEPTION_AUTHORITY',
            authorityRef: 'authority:retention-exception',
            contentScopeRefs: [readyScope],
            controllerRef: 'controller:privacy-test',
            effectiveFrom: '2026-09-01T00:00:00.000Z',
            effectiveTo: '2026-10-01T00:00:00.000Z',
            evidenceRefs: ['evidence:exception:release-mismatch'],
            exceptionRef: 'exception:release-mismatch',
            policyRef: 'policy:privacy-retention-test',
            policyVersion: 1,
            provenanceRef: 'provenance:exception:release-mismatch',
            reasonTypeRef: 'reason:retention-exception',
            reasonTypeVersion: 1,
            releaseConditionRef: 'condition:exception-released',
            releasedAt: '2026-09-12T00:00:00.000Z',
            releasedByPrincipalRef: 'principal:retention-test',
            releaseEvidenceRefs: ['evidence:exception-release'],
            releaseReasonRef: 'reason:exception-released',
            releaseRef: 'release:exception:release-mismatch',
            reviewDueAt: '2026-09-20T00:00:00.000Z',
            reviewedAt: null,
            reviewEvidenceRefs: [],
            reviewRef: 'review:exception:release-mismatch',
          },
          exceptionRef: 'exception:release-mismatch',
          legalEntityId,
          recordedAt: new Date('2026-09-10T00:00:00.000Z'),
          releasedAt: new Date('2026-09-13T00:00:00.000Z'),
          tenantId,
        }),
      );
      expect(mismatchedExceptionRelease).toBeDefined();

      const blockedWorkRef = 'retention-work:postgres-blocked';
      yield* insertWork(blockedWorkRef, readyRuleRef, readyScope, '2026-08-31T00:00:00.000Z');
      yield* admin.insert(legalHolds).values({
        actionInvocationId: 'e7200000-0000-4000-8000-000000000002',
        effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-10-01T00:00:00.000Z'),
        holdRecord: {
          actorPrincipalRef: 'principal:retention-test',
          authorityKind: 'LEGAL_HOLD_AUTHORITY',
          authorityRef: 'authority:legal',
          contentScopeRefs: [readyScope],
          controllerRef: 'controller:privacy-test',
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveTo: '2026-10-01T00:00:00.000Z',
          evidenceRefs: ['evidence:hold:customer-email'],
          holdRef: 'hold:customer-email',
          policyRef: 'policy:privacy-retention-test',
          policyVersion: 1,
          provenanceRef: 'provenance:hold:customer-email',
          reasonTypeRef: 'reason:legal-hold',
          reasonTypeVersion: 1,
          releaseConditionRef: null,
          releasedAt: null,
          releasedByPrincipalRef: null,
          releaseEvidenceRefs: [],
          releaseReasonRef: null,
          releaseRef: null,
          reviewDueAt: '2026-09-20T00:00:00.000Z',
          reviewedAt: null,
          reviewEvidenceRefs: [],
          reviewRef: 'review:hold:customer-email',
        },
        holdRef: 'hold:customer-email',
        legalEntityId,
        recordedAt: new Date('2026-09-10T00:00:00.000Z'),
        tenantId,
      });
      const blocked = yield* invoke(blockedWorkRef, 'e7100000-0000-4000-8000-000000000002');
      expect(blocked.status).toBe('BLOCKED');
      expect(blocked.blocker_refs).toEqual(['legal-hold:hold:customer-email']);

      const exceptionRuleRef = 'retention:worker-exception';
      const exceptionScope = 'customer.contact.address';
      const exceptionWorkRef = 'retention-work:postgres-exception';
      yield* insertRule(exceptionRuleRef, exceptionScope, 'e7200000-0000-4000-8000-000000000005');
      yield* insertWork(exceptionWorkRef, exceptionRuleRef, exceptionScope, '2026-08-31T00:00:00.000Z');
      yield* admin.insert(retentionExceptions).values({
        actionInvocationId: 'e7200000-0000-4000-8000-000000000006',
        effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-10-01T00:00:00.000Z'),
        exceptionRecord: {
          actorPrincipalRef: 'principal:retention-test',
          authorityKind: 'EXCEPTION_AUTHORITY',
          authorityRef: 'authority:retention-exception',
          contentScopeRefs: [exceptionScope],
          controllerRef: 'controller:privacy-test',
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveTo: '2026-10-01T00:00:00.000Z',
          evidenceRefs: ['evidence:exception:customer-address'],
          exceptionRef: 'exception:customer-address',
          policyRef: 'policy:privacy-retention-test',
          policyVersion: 1,
          provenanceRef: 'provenance:exception:customer-address',
          reasonTypeRef: 'reason:retention-exception',
          reasonTypeVersion: 1,
          releaseConditionRef: null,
          releasedAt: null,
          releasedByPrincipalRef: null,
          releaseEvidenceRefs: [],
          releaseReasonRef: null,
          releaseRef: null,
          reviewDueAt: '2026-09-20T00:00:00.000Z',
          reviewedAt: null,
          reviewEvidenceRefs: [],
          reviewRef: 'review:exception:customer-address',
        },
        exceptionRef: 'exception:customer-address',
        legalEntityId,
        recordedAt: new Date('2026-09-10T00:00:00.000Z'),
        tenantId,
      });
      const excepted = yield* invoke(exceptionWorkRef, 'e7100000-0000-4000-8000-000000000006');
      expect(excepted.status).toBe('BLOCKED');
      expect(excepted.blocker_refs).toEqual(['retention-exception:exception:customer-address']);

      const ambiguousWorkRef = 'retention-work:postgres-ambiguous';
      yield* insertWork(ambiguousWorkRef, readyRuleRef, readyScope, '2026-08-31T00:00:00.000Z');
      yield* insertRule(readyRuleRef, readyScope, 'e7200000-0000-4000-8000-000000000003', 2);
      const ambiguous = yield* invoke(ambiguousWorkRef, 'e7100000-0000-4000-8000-000000000003');
      expect(ambiguous.outcome).toBe('STATE_AMBIGUOUS');
      expect(ambiguous.status).toBe('INDETERMINATE');
      expect(ambiguous.work_record?.status).toBe('INDETERMINATE');

      const outcomeMismatchRuleRef = 'retention:worker-outcome-mismatch';
      const outcomeMismatchScope = 'customer.contact.outcome-mismatch';
      const outcomeMismatchWorkRef = 'retention-work:postgres-outcome-mismatch';
      yield* insertRule(outcomeMismatchRuleRef, outcomeMismatchScope, 'e7200000-0000-4000-8000-000000000009');
      yield* insertWork(
        outcomeMismatchWorkRef,
        outcomeMismatchRuleRef,
        outcomeMismatchScope,
        '2026-08-31T00:00:00.000Z',
      );
      yield* admin.insert(dispositionDecisions).values({
        decidedAt: new Date('2026-09-13T15:30:00.000Z'),
        decisionRecord: {
          blockerRefs: [],
          contentScopeRefs: [outcomeMismatchScope],
          controllerRef: 'controller:privacy-test',
          decidedAt: '2026-09-13T15:30:00.000Z',
          decisionRef: 'disposition:worker-outcome-mismatch',
          evaluationRef: outcomeMismatchWorkRef,
          evidenceRefs: [`evidence:${outcomeMismatchRuleRef}:1`],
          outcome: 'RETAIN',
          ownerExecutionOutcomeRef: null,
          policyRef: 'policy:privacy-retention-test',
          policyVersion: 1,
          provenanceRef: `provenance:${outcomeMismatchRuleRef}:1`,
          reasonRefs: ['reason:retention-expired'],
          ruleRef: outcomeMismatchRuleRef,
          ruleVersion: 1,
        },
        decisionRef: 'disposition:worker-outcome-mismatch',
        legalEntityId,
        outcome: 'RETAIN',
        ruleRef: outcomeMismatchRuleRef,
        ruleVersion: 1,
        tenantId,
      });
      const outcomeMismatch = yield* invoke(outcomeMismatchWorkRef, 'e7100000-0000-4000-8000-000000000009');
      expect(outcomeMismatch.outcome).toBe('STATE_AMBIGUOUS');
      expect(outcomeMismatch.status).toBe('INDETERMINATE');
      expect(outcomeMismatch.reason).toBe('DISPOSITION_STATE_INVALID');

      const completedRuleRef = 'retention:worker-completed';
      const completedScope = 'customer.contact.phone';
      const completedWorkRef = 'retention-work:postgres-completed';
      const decisionRef = 'disposition:worker-completed';
      const measureId = 'measure:worker-completed';
      const ownerOutcomeRef = 'owner-outcome:worker-completed';
      yield* insertRule(completedRuleRef, completedScope, 'e7200000-0000-4000-8000-000000000004');
      yield* insertWork(completedWorkRef, completedRuleRef, completedScope, '2026-08-31T00:00:00.000Z');
      yield* admin.insert(dispositionDecisions).values({
        decidedAt: new Date('2026-09-13T15:30:00.000Z'),
        decisionRecord: {
          blockerRefs: [],
          contentScopeRefs: [completedScope],
          controllerRef: 'controller:privacy-test',
          decidedAt: '2026-09-13T15:30:00.000Z',
          decisionRef,
          evaluationRef: completedWorkRef,
          evidenceRefs: ['evidence:retention-rule'],
          outcome: 'DELETE',
          ownerExecutionOutcomeRef: null,
          policyRef: 'policy:privacy-retention-test',
          policyVersion: 1,
          provenanceRef: `provenance:${completedRuleRef}:1`,
          reasonRefs: ['reason:retention-expired'],
          ruleRef: completedRuleRef,
          ruleVersion: 1,
        },
        decisionRef,
        legalEntityId,
        outcome: 'DELETE',
        ruleRef: completedRuleRef,
        ruleVersion: 1,
        tenantId,
      });
      yield* admin.insert(privacyMeasureDispatches).values({
        handoffRecord: {
          contentScopeRefs: [completedScope],
          controllerObligationRef: null,
          dispositionDecision: 'DELETE',
          expectedEvidenceRefs: ['evidence:owner-delete'],
          idempotencyKey: 'idempotency:measure:worker-completed',
          kind: 'DELETE',
          measureId,
          owningCapability: 'party.registry',
          preconditionRefs: ['precondition:retention-current'],
          requestedAt: '2026-09-13T16:00:00.000Z',
          requestedResult: 'Delete the expired exact content scope',
          resourceRefs: ['party:customer:worker-completed'],
          right: null,
          sourceDecisionRef: decisionRef,
          sourceDecisionRevision: 1,
          subjectRef: 'privacy-subject:worker-completed',
          taskId: 'retention-task:worker-completed',
          tenantId,
        },
        idempotencyKey: 'idempotency:measure:worker-completed',
        legalEntityId,
        measureId,
        status: 'SUCCEEDED',
        tenantId,
      });
      yield* admin.insert(ownerExecutionOutcomes).values({
        attempt: 1,
        legalEntityId,
        measureId,
        outcomeId: ownerOutcomeRef,
        outcomeRecord: {
          attempt: 1,
          evidenceRefs: ['evidence:owner-delete'],
          idempotencyKey: 'idempotency:measure:worker-completed',
          includedResourceRefs: ['party:customer:worker-completed'],
          measureId,
          occurredAt: '2026-09-13T16:05:00.000Z',
          outcomeId: ownerOutcomeRef,
          owningCapability: 'party.registry',
          reason: 'The exact expired content scope was deleted',
          recordedAt: '2026-09-13T16:05:01.000Z',
          remainingResourceRefs: [],
          sourceDecisionRef: decisionRef,
          sourceDecisionRevision: 1,
          status: 'SUCCEEDED',
          taskId: 'retention-task:worker-completed',
        },
        status: 'SUCCEEDED',
        tenantId,
      });

      const completed = yield* invoke(completedWorkRef, 'e7100000-0000-4000-8000-000000000004');
      expect(completed.status).toBe('COMPLETED');
      expect(completed.owner_outcome_ref).toBe(ownerOutcomeRef);

      const scopeMismatch = yield* invoke(
        completedWorkRef,
        'e7100000-0000-4000-8000-000000000005',
        evaluatedAt,
        otherTenantId,
      );
      expect(scopeMismatch.outcome).toBe('SCOPE_MISMATCH');
    }),
  ),
);
