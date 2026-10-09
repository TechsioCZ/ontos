import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AntiResurrectionProtectionSchema,
  AntiResurrectionProtectionError,
  assessAntiResurrection,
  createAntiResurrectionProtection,
} from '../../shared/domain/anti-resurrection.ts';
import type { AntiResurrectionEnforcementReceipt } from '../../shared/domain/anti-resurrection.ts';
import type {
  OwnerExecutionAuthorityResult,
  OwnerExecutionOutcome,
  PrivacyMeasureHandoff,
  PrivacyMeasureKind,
} from '../../shared/domain/privacy-measure-handoff.ts';

const destructiveHandoff = (kind: Extract<PrivacyMeasureKind, 'DELETE' | 'ANONYMIZE'>): PrivacyMeasureHandoff => ({
  contentScopeRefs: ['email'],
  controllerObligationRef: 'obligation-1',
  dispositionDecision: kind,
  expectedEvidenceRefs: ['destructive-proof'],
  idempotencyKey: `measure-1:${kind}`,
  kind,
  measureId: 'measure-1',
  owningCapability: 'accounts',
  preconditionRefs: ['no-legal-hold'],
  requestedAt: '2026-09-14T10:00:00Z',
  requestedResult: 'irreversible disposition',
  resourceRefs: ['account-1'],
  right: 'ERASURE',
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 2,
  subjectRef: 'subject-1',
  taskId: 'task-1',
  tenantId: 'tenant-1',
});

const successfulOutcome = (kind: Extract<PrivacyMeasureKind, 'DELETE' | 'ANONYMIZE'>): OwnerExecutionOutcome => ({
  attempt: 1,
  evidenceRefs: [`evidence-${kind}`],
  idempotencyKey: `measure-1:${kind}`,
  includedResourceRefs: ['account-1'],
  measureId: 'measure-1',
  occurredAt: '2026-09-14T10:01:00Z',
  outcomeId: `outcome-${kind}`,
  owningCapability: 'accounts',
  reason: `${kind} completed`,
  recordedAt: '2026-09-14T10:02:00Z',
  remainingResourceRefs: [],
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 2,
  status: 'SUCCEEDED',
  taskId: 'task-1',
});

const restrictionHandoff: PrivacyMeasureHandoff = {
  ...destructiveHandoff('DELETE'),
  dispositionDecision: 'RESTRICT',
  idempotencyKey: 'measure-1:RESTRICT',
  kind: 'RESTRICT',
  requestedResult: 'RESTRICTED',
  right: null,
};

const restrictionOutcome: OwnerExecutionOutcome = {
  ...successfulOutcome('DELETE'),
  idempotencyKey: 'measure-1:RESTRICT',
  outcomeId: 'outcome-RESTRICT',
};

const ownerAuthority = (
  handoff: PrivacyMeasureHandoff,
  outcome: OwnerExecutionOutcome,
): OwnerExecutionAuthorityResult => ({
  authorityRef: `authority-${outcome.outcomeId}`,
  contentScopeRefs: handoff.contentScopeRefs,
  evidenceRefs: outcome.evidenceRefs,
  outcome,
  receiptRef: outcome.outcomeId,
  resourceRefs: handoff.resourceRefs,
  subjectRef: handoff.subjectRef,
  tenantId: handoff.tenantId,
});

const enforcementReceipt = (handoff: PrivacyMeasureHandoff): AntiResurrectionEnforcementReceipt => {
  const measure = handoff.kind;
  if (measure !== 'DELETE' && measure !== 'ANONYMIZE' && measure !== 'RESTRICT') {
    throw new Error(`Unsupported anti-resurrection measure: ${measure}`);
  }
  return {
    authorityRef: `enforcement-authority-${handoff.taskId}`,
    contentScopeRefs: handoff.contentScopeRefs,
    evidenceRefs: ['gate-import', 'gate-replay', 'gate-projection', 'gate-backup'],
    measure,
    operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
    ownerModuleId: handoff.owningCapability,
    receiptRef: `enforcement-receipt-${handoff.taskId}`,
    resourceRefs: handoff.resourceRefs,
    subjectRef: handoff.subjectRef,
    taskId: handoff.taskId,
    tenantId: handoff.tenantId,
  };
};

const createProtection = (kind: Extract<PrivacyMeasureKind, 'DELETE' | 'ANONYMIZE'> = 'DELETE') =>
  createAntiResurrectionProtection({
    authority: ownerAuthority(destructiveHandoff(kind), successfulOutcome(kind)),
    enforcementReceipt: enforcementReceipt(destructiveHandoff(kind)),
    handoff: destructiveHandoff(kind),
    protectedAt: '2026-09-14T10:02:00Z',
    protectionId: `protection-${kind}`,
  });

const attempt = (operation: 'IMPORT' | 'REPLAY' | 'PROJECTION_REBUILD' | 'BACKUP_RECOVERY') => ({
  contentScopeRefs: ['email'],
  operation,
  resourceRefs: ['account-1'],
  sourceInputIsNew: false,
  sourceInputRef: null,
  subjectRef: 'subject-1',
  tenantId: 'tenant-1',
});

const newSourceEvidence = {
  contentScopeRefs: ['email'],
  evidenceRef: 'new-source-proof-1',
  resourceRefs: ['account-1'],
  sourceInputRef: 'new-source-event',
  subjectRef: 'subject-1',
  tenantId: 'tenant-1',
  verifiedAt: '2026-09-14T11:00:00Z',
} as const;

describe('Privacy anti-resurrection protection', () => {
  it.effect('creates scope-bound protections only from successful DELETE and ANONYMIZE outcomes', () =>
    Effect.gen(function* createsDestructiveProtections() {
      for (const kind of ['DELETE', 'ANONYMIZE'] as const) {
        const protection = yield* createProtection(kind);
        expect(protection).toMatchObject({
          contentScopeRefs: ['email'],
          measure: kind,
          outcomeStatus: 'SUCCEEDED',
          ownerExecutionOutcomeRef: `outcome-${kind}`,
          resourceRefs: ['account-1'],
        });
      }
    }),
  );

  it.effect('creates a protection for an exact owner-enforced Disposition RESTRICT', () =>
    Effect.gen(function* createsRestrictionProtection() {
      const protection = yield* createAntiResurrectionProtection({
        authority: ownerAuthority(restrictionHandoff, restrictionOutcome),
        enforcementReceipt: enforcementReceipt(restrictionHandoff),
        handoff: restrictionHandoff,
        protectedAt: '2026-09-14T10:02:00Z',
        protectionId: 'protection-RESTRICT',
      });
      expect(protection.measure).toBe('RESTRICT');
      expect(assessAntiResurrection([protection], attempt('REPLAY')).decision).toBe('BLOCK');
      expect(
        assessAntiResurrection(
          [protection],
          { ...attempt('IMPORT'), sourceInputIsNew: true, sourceInputRef: 'new-source-event' },
          newSourceEvidence,
        ).decision,
      ).toBe('BLOCK');
    }),
  );

  it.effect('rejects non-successful and out-of-scope destructive outcomes through the typed error channel', () =>
    Effect.gen(function* rejectsInvalidDestructiveOutcomes() {
      const handoff = destructiveHandoff('DELETE');
      const partial = createAntiResurrectionProtection({
        authority: ownerAuthority(handoff, { ...successfulOutcome('DELETE'), status: 'PARTIAL' }),
        enforcementReceipt: enforcementReceipt(handoff),
        handoff,
        protectedAt: '2026-09-14T10:02:00Z',
        protectionId: 'protection-partial',
      });
      const wrongScope = createAntiResurrectionProtection({
        authority: ownerAuthority(handoff, { ...successfulOutcome('DELETE'), includedResourceRefs: ['account-2'] }),
        enforcementReceipt: enforcementReceipt(handoff),
        handoff,
        protectedAt: '2026-09-14T10:02:00Z',
        protectionId: 'protection-wrong-scope',
      });
      expect(Schema.is(AntiResurrectionProtectionError)(yield* Effect.flip(partial))).toBe(true);
      expect(Schema.is(AntiResurrectionProtectionError)(yield* Effect.flip(wrongScope))).toBe(true);
    }),
  );

  it.effect('blocks stale import, replay, projection rebuild, and backup recovery', () =>
    Effect.gen(function* blocksStaleInputs() {
      const protection = yield* createProtection();
      for (const operation of ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'] as const) {
        expect(assessAntiResurrection([protection], attempt(operation))).toMatchObject({
          blockedResourceRefs: ['account-1'],
          decision: 'BLOCK',
          matchedProtectionIds: ['protection-DELETE'],
          unaffectedResourceRefs: [],
        });
      }
    }),
  );

  it.effect('returns a partial assessment for a batch containing protected A and unaffected B', () =>
    Effect.gen(function* assessesBatchByExactResource() {
      const protection = yield* createProtection();
      expect(
        assessAntiResurrection([protection], {
          ...attempt('REPLAY'),
          resourceRefs: ['account-1', 'account-2'],
        }),
      ).toMatchObject({
        blockedResourceRefs: ['account-1'],
        decision: 'PARTIAL',
        matchedProtectionIds: ['protection-DELETE'],
        unaffectedResourceRefs: ['account-2'],
      });
    }),
  );

  it.effect('does not trust a caller claim that source input is new', () =>
    Effect.gen(function* requiresTrustedNewSourceEvidence() {
      const protection = yield* createProtection();
      const claimedNewAttempt = {
        ...attempt('IMPORT'),
        sourceInputIsNew: true,
        sourceInputRef: 'new-source-event',
      } as const;

      expect(assessAntiResurrection([protection], claimedNewAttempt).decision).toBe('BLOCK');
      expect(assessAntiResurrection([protection], claimedNewAttempt, newSourceEvidence).decision).toBe('ALLOW');
      expect(
        assessAntiResurrection([protection], claimedNewAttempt, {
          ...newSourceEvidence,
          resourceRefs: ['account-2'],
        }).decision,
      ).toBe('BLOCK');
    }),
  );

  it.effect('is scope-bound and does not blacklist a subject globally', () =>
    Effect.gen(function* keepsProtectionScopeBound() {
      const protection = yield* createProtection();
      expect(
        assessAntiResurrection([protection], {
          ...attempt('REPLAY'),
          contentScopeRefs: ['email'],
          resourceRefs: ['account-2'],
        }).decision,
      ).toBe('ALLOW');
      expect(
        assessAntiResurrection([protection], {
          ...attempt('REPLAY'),
          contentScopeRefs: ['phone'],
          resourceRefs: ['account-1'],
        }).decision,
      ).toBe('ALLOW');
    }),
  );

  it('does not accept a protection without a complete owner-local enforcement receipt', () => {
    expect(() =>
      Schema.decodeUnknownSync(AntiResurrectionProtectionSchema)({
        contentScopeRefs: ['email'],
        evidenceRefs: ['outcome-DELETE'],
        measure: 'DELETE',
        outcomeStatus: 'SUCCEEDED',
        ownerExecutionOutcomeRef: 'outcome-DELETE',
        protectedAt: '2026-09-14T10:02:00Z',
        protectionId: 'protection-missing-receipt',
        resourceRefs: ['account-1'],
        sourceDecisionRef: 'decision-1',
        sourceDecisionRevision: 2,
        subjectRef: 'subject-1',
        tenantId: 'tenant-1',
      }),
    ).toThrow();
  });
});
