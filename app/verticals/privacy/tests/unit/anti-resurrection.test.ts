import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AntiResurrectionProtectionError,
  assessAntiResurrection,
  createAntiResurrectionProtection,
} from '../../shared/domain/anti-resurrection.ts';
import type {
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

const createProtection = (kind: Extract<PrivacyMeasureKind, 'DELETE' | 'ANONYMIZE'> = 'DELETE') =>
  createAntiResurrectionProtection({
    handoff: destructiveHandoff(kind),
    outcome: successfulOutcome(kind),
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

  it.effect('rejects non-successful and out-of-scope destructive outcomes through the typed error channel', () =>
    Effect.gen(function* rejectsInvalidDestructiveOutcomes() {
      const handoff = destructiveHandoff('DELETE');
      const partial = createAntiResurrectionProtection({
        handoff,
        outcome: { ...successfulOutcome('DELETE'), status: 'PARTIAL' },
        protectedAt: '2026-09-14T10:02:00Z',
        protectionId: 'protection-partial',
      });
      const wrongScope = createAntiResurrectionProtection({
        handoff,
        outcome: { ...successfulOutcome('DELETE'), includedResourceRefs: ['account-2'] },
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
          decision: 'BLOCK',
          matchedProtectionIds: ['protection-DELETE'],
        });
      }
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
});
