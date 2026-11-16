import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { eq } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import { measureExecutionEligibilityRead } from '../../src/api/measure-execution-eligibility.read.ts';
import {
  dispositionDecisions,
  legalHolds,
  privacyMeasureDispatches,
  ownerExecutionOutcomes,
  retentionEvaluationWork,
  retentionRules,
} from '../../src/database/schema.ts';
import { privacyRegistration } from '../../vertical.registration.ts';
import { makeMeasureExecutionFixture } from '../support/measure-execution.fixture.ts';

const asDate = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));

it.live('rechecks a real stored exact measure against current native rule, protections and decision ambiguity', () =>
  Effect.gen(function* nativeMeasureExecution() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-07T12:00:00.000Z')));
    const native = yield* makeNativeReadTestContext({
      access: 'allowed',
      contextPermissions: ['privacy.core.measure-execution-eligibility.read'],
      moduleId: 'privacy.core',
      ownerFixtureRetention: 'retain-complete-context',
    }).pipe(Effect.provideService(NativeReadTestOwnerRegistration, privacyRegistration));
    const { tenantId } = native.principal;
    const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
    const fixture = makeMeasureExecutionFixture(tenantId);
    const crypto = yield* Crypto.Crypto;
    yield* native
      .prepareOwner((transaction) =>
        Effect.gen(function* setupExactApprovedNativeRecords() {
          const rule = {
            applicability: 'PROSPECTIVE_ONLY',
            authorityRef: 'fixture:approved-rule-authority',
            businessStartAt: '2026-09-01T00:00:00.000Z',
            businessStartRef: 'fixture:terminal-business-event',
            contentScopeRef: fixture.content,
            controllerRef: fixture.decisionWire.controllerRef,
            dispositionOutcome: 'DELETE',
            effectiveFrom: '2026-09-01T00:00:00.000Z',
            effectiveTo: null,
            evidenceRefs: fixture.decisionWire.evidenceRefs,
            policyRef: fixture.decisionWire.policyRef,
            policyVersion: 1,
            provenanceRef: fixture.decisionWire.provenanceRef,
            retentionWindow: { durationDays: 1, kind: 'DURATION' },
            retroactiveApprovalRef: null,
            ruleRef: fixture.decision.ruleRef,
            ruleVersion: 1,
            ruleVersionId: fixture.decision.ruleVersionId,
          };
          yield* transaction.insert(retentionRules).values({
            actionInvocationId: yield* crypto.randomUUIDv4(),
            contentScopeRef: fixture.content,
            effectiveFrom: asDate(rule.effectiveFrom),
            legalEntityId,
            ruleRecord: rule,
            ruleRef: rule.ruleRef,
            ruleVersion: 1,
            tenantId,
          });
          const work = {
            businessStartAt: rule.businessStartAt,
            businessStartRef: rule.businessStartRef,
            contentScopeRefs: [fixture.content],
            controllerRef: rule.controllerRef,
            dispositionOutcome: 'DELETE',
            dueAt: '2026-09-02T00:00:00.000Z',
            evaluatedAt: fixture.decidedAt,
            evidenceRefs: rule.evidenceRefs,
            idempotencyRef: `fixture:work-key:${tenantId}`,
            policyRef: rule.policyRef,
            policyVersion: 1,
            provenanceRef: rule.provenanceRef,
            ruleAuthorityRef: rule.authorityRef,
            ruleRef: rule.ruleRef,
            ruleVersion: 1,
            ruleVersionId: rule.ruleVersionId,
            source: 'PERIODIC',
            status: 'READY',
            workerEvaluation: {
              ...fixture.evaluationWire,
              messageId: yield* crypto.randomUUIDv4(),
              ownerOutcomeRef: null,
            },
            workRef: fixture.evaluation.evaluationRef,
          };
          yield* transaction.insert(retentionEvaluationWork).values({
            dueAt: asDate(work.dueAt),
            evaluatedAt: asDate(fixture.decidedAt),
            idempotencyRef: work.idempotencyRef,
            legalEntityId,
            ruleRef: rule.ruleRef,
            ruleVersion: 1,
            status: 'READY',
            tenantId,
            workRecord: work,
            workRef: work.workRef,
          });
          yield* transaction.insert(dispositionDecisions).values({
            decidedAt: asDate(fixture.decidedAt),
            decisionRecord: fixture.decisionWire,
            decisionRef: fixture.decision.decisionRef,
            legalEntityId,
            outcome: 'DELETE',
            ruleRef: rule.ruleRef,
            ruleVersion: 1,
            tenantId,
          });
          yield* transaction.insert(privacyMeasureDispatches).values({
            handoffRecord: fixture.handoff,
            idempotencyKey: fixture.handoff.idempotencyKey,
            legalEntityId,
            measureId: fixture.handoff.measureId,
            status: 'RECEIVED',
            tenantId,
          });
        }),
      )
      .pipe(Effect.provide(native.layer));
    const read = (handoff = fixture.handoff) =>
      native.runtime
        .runRead({
          input: { handoff },
          principal: native.principal,
          registration: measureExecutionEligibilityRead,
          transport: { correlationId: 'fixture:exact-measure' },
        })
        .pipe(Effect.provide(native.layer));
    expect((yield* read()).status).toBe('CURRENT_APPROVED');
    yield* native
      .prepareOwner((transaction) =>
        transaction
          .update(retentionEvaluationWork)
          .set({ status: 'INDETERMINATE' })
          .where(eq(retentionEvaluationWork.workRef, fixture.evaluation.evaluationRef)),
      )
      .pipe(Effect.provide(native.layer));
    expect((yield* read()).status).toBe('BLOCKED');
    yield* native
      .prepareOwner((transaction) =>
        transaction
          .update(retentionEvaluationWork)
          .set({ status: 'READY' })
          .where(eq(retentionEvaluationWork.workRef, fixture.evaluation.evaluationRef)),
      )
      .pipe(Effect.provide(native.layer));
    expect((yield* read()).status).toBe('CURRENT_APPROVED');
    yield* native
      .prepareOwner((transaction) =>
        transaction
          .update(privacyMeasureDispatches)
          .set({ status: 'BLOCKED' })
          .where(eq(privacyMeasureDispatches.measureId, fixture.handoff.measureId)),
      )
      .pipe(Effect.provide(native.layer));
    expect((yield* read()).status).toBe('BLOCKED');
    yield* native
      .prepareOwner((transaction) =>
        transaction.insert(ownerExecutionOutcomes).values({
          attempt: 1,
          legalEntityId,
          measureId: fixture.handoff.measureId,
          outcomeId: `internal:blocked:${tenantId}`,
          outcomeRecord: {
            attempt: 1,
            evidenceRefs: ['internal:owner-current-hold'],
            idempotencyKey: fixture.handoff.idempotencyKey,
            includedResourceRefs: [],
            measureId: fixture.handoff.measureId,
            occurredAt: fixture.decidedAt,
            outcomeId: `internal:blocked:${tenantId}`,
            owningCapability: 'integration.symmy',
            reason: 'Native current hold temporarily blocked owner execution',
            recordedAt: fixture.decidedAt,
            remainingResourceRefs: fixture.handoff.resourceRefs,
            sourceDecisionRef: fixture.handoff.sourceDecisionRef,
            sourceDecisionRevision: 1,
            status: 'BLOCKED',
            taskId: fixture.handoff.taskId,
          },
          status: 'BLOCKED',
          tenantId,
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect((yield* read()).status).toBe('CURRENT_APPROVED');
    yield* native
      .prepareOwner((transaction) =>
        transaction
          .update(privacyMeasureDispatches)
          .set({ status: 'RECEIVED' })
          .where(eq(privacyMeasureDispatches.measureId, fixture.handoff.measureId)),
      )
      .pipe(Effect.provide(native.layer));
    expect((yield* read()).status).toBe('CURRENT_APPROVED');
    expect((yield* read({ ...fixture.handoff, taskId: 'fixture:forged-task' })).status).toBe('BLOCKED');
    expect((yield* read({ ...fixture.handoff, contentScopeRefs: ['integration.symmy.job-intent'] })).status).toBe(
      'BLOCKED',
    );
    yield* native
      .prepareOwner((transaction) =>
        Effect.gen(function* holdExactContent() {
          const now = DateTime.formatIso(yield* DateTime.now);
          const hold = {
            actorPrincipalRef: native.principal.principalId,
            authorityKind: 'LEGAL_HOLD_AUTHORITY',
            authorityRef: 'fixture:hold-authority',
            contentScopeRefs: [fixture.content],
            controllerRef: fixture.decision.controllerRef,
            effectiveFrom: '2026-11-01T00:00:00.000Z',
            effectiveTo: '2026-12-01T00:00:00.000Z',
            evidenceRefs: ['fixture:hold-evidence'],
            holdRef: `fixture:hold:${tenantId}`,
            policyRef: fixture.decision.policyRef,
            policyVersion: 1,
            provenanceRef: 'fixture:hold-provenance',
            reasonTypeRef: 'fixture:hold-reason',
            reasonTypeVersion: 1,
            releaseConditionRef: null,
            releasedAt: null,
            releasedByPrincipalRef: null,
            releaseEvidenceRefs: [],
            releaseReasonRef: null,
            releaseRef: null,
            reviewDueAt: '2026-11-20T00:00:00.000Z',
            reviewedAt: null,
            reviewEvidenceRefs: [],
            reviewRef: 'fixture:hold-review',
          };
          yield* transaction.insert(legalHolds).values({
            actionInvocationId: yield* crypto.randomUUIDv4(),
            effectiveFrom: asDate(hold.effectiveFrom),
            effectiveTo: asDate(hold.effectiveTo),
            holdRecord: hold,
            holdRef: hold.holdRef,
            legalEntityId,
            recordedAt: asDate(now),
            tenantId,
          });
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect((yield* read()).status).toBe('BLOCKED');
    yield* native
      .prepareOwner((transaction) =>
        transaction.insert(dispositionDecisions).values({
          decidedAt: asDate(fixture.decidedAt),
          decisionRecord: { ...fixture.decisionWire, decisionRef: `fixture:conflicting-decision:${tenantId}` },
          decisionRef: `fixture:conflicting-decision:${tenantId}`,
          legalEntityId,
          outcome: 'DELETE',
          ruleRef: fixture.decision.ruleRef,
          ruleVersion: 1,
          tenantId,
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect(yield* read()).toMatchObject({ reason: 'DECISION_UNRESOLVED', status: 'BLOCKED' });
  }).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(TestClock.layer())),
);
