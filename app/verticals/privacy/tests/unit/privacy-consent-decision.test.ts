import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import {
  ConsentDecisionInvariantError,
  ConsentDecisionSchema,
  makeConsentDecisionStore,
  validateConsentDecision,
} from '../../shared/domain/privacy-consent-decision.ts';
import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';

const tenantId = '00000000-0000-4000-8000-000000000000';
const scope = {
  controllerRef: 'controller:one',
  materialDimensions: [],
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: 'subject:one',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:security',
    resourceType: 'privacy.core.processing-purpose',
    tenantId,
  },
  purposeMeaning: 'Send account security alerts',
  purposeVersionRef: 'purpose-v1',
  scopeRef: 'scope:security',
} as const;
const actor = {
  actor: {
    moduleId: 'core.identity',
    principalId: '00000000-0000-4000-8000-000000000002',
    principalType: 'user',
    tenantId,
  },
  attributedAt: '2026-01-01T00:00:00Z',
  authMethod: 'session',
  impersonatedBy: null,
} as const;
const decision = (decisionKind: ConsentDecision['decision'], id: string, effectiveAt: string): ConsentDecision => ({
  actorEvidence: actor,
  decision: decisionKind,
  decisionId: id,
  effectiveAt,
  flowEvidenceRefs: ['flow:checkout'],
  noticeEvidenceRefs: ['notice-provision:one'],
  provenanceRefs: ['action:consent'],
  recordedAt: effectiveAt === '2026-01-01T00:00:00Z' ? '2026-01-02T00:00:00Z' : effectiveAt,
  scope,
});

describe('Consent Decisions', () => {
  it.effect('requires an exact retained grant for withdrawal after the historical Purpose Version ends', () =>
    Effect.gen(function* retainedPurposeWithdrawal() {
      const version = {
        effectiveFrom: '2025-01-01T00:00:00Z',
        effectiveTo: '2026-02-01T00:00:00Z',
        materialChangeAssessment: null,
        meaning: scope.purposeMeaning,
        recordedAt: '2025-01-01T00:00:00Z',
        requiredConsentDimensions: [],
        versionId: scope.purposeVersionRef,
        versionNumber: 1,
      };
      const noGrant = makeConsentDecisionStore();
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            noGrant.record(decision('WITHDRAWN', 'withdraw:no-basis', '2026-03-01T00:00:00Z'), version),
          ),
        ),
      ).toBe(true);
      expect(noGrant.history(scope.scopeRef)).toEqual([]);
      for (const at of ['2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z']) {
        const store = makeConsentDecisionStore();
        const grant = decision('GRANTED', `grant:${at}`, '2026-01-01T00:00:00Z');
        yield* store.record(grant, version);
        const withdrawn = decision('WITHDRAWN', `withdraw:${at}`, at);
        yield* store.record(withdrawn, version);
        expect(store.history(scope.scopeRef)).toEqual([grant, withdrawn]);
        expect(store.current(scope.scopeRef)).toEqual({ decision: withdrawn, outcome: 'CURRENT' });
      }
      for (const kind of ['GRANTED', 'REFUSED'] as const) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              makeConsentDecisionStore().record(decision(kind, `ended:${kind}`, '2026-03-01T00:00:00Z'), version),
            ),
          ),
        ).toBe(true);
      }
      const wrongScope = makeConsentDecisionStore();
      yield* wrongScope.record(decision('GRANTED', 'grant:original', '2026-01-01T00:00:00Z'), version);
      const withdrawal = decision('WITHDRAWN', 'withdraw:changed-controller', '2026-03-01T00:00:00Z');
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            wrongScope.record(
              {
                ...withdrawal,
                scope: { ...withdrawal.scope, controllerRef: 'controller:other' },
              },
              version,
            ),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    'does not convert refusal, conflicting history, or a changed original scope into retained grant authority',
    () =>
      Effect.gen(function* invalidRetainedWithdrawalBases() {
        const version = {
          effectiveFrom: '2025-01-01T00:00:00Z',
          effectiveTo: '2026-02-01T00:00:00Z',
          materialChangeAssessment: null,
          meaning: scope.purposeMeaning,
          recordedAt: '2025-01-01T00:00:00Z',
          versionId: scope.purposeVersionRef,
          versionNumber: 1,
        };
        const withdrawn = decision('WITHDRAWN', 'withdraw:invalid-basis', '2026-03-01T00:00:00Z');
        const refusedOnly = makeConsentDecisionStore();
        yield* refusedOnly.record(decision('REFUSED', 'refused:only', '2026-01-01T00:00:00Z'), version);
        expect(Exit.isFailure(yield* Effect.exit(refusedOnly.record(withdrawn, version)))).toBe(true);
        const conflicting = makeConsentDecisionStore();
        yield* conflicting.record(decision('GRANTED', 'choice:one', '2026-01-01T00:00:00Z'), version);
        yield* conflicting.record(decision('REFUSED', 'choice:two', '2026-01-01T00:00:00Z'), version);
        expect(Exit.isFailure(yield* Effect.exit(conflicting.record(withdrawn, version)))).toBe(true);
        for (const changed of [
          { ...scope, purposeVersionRef: 'purpose-v2' },
          { ...scope, materialDimensions: [{ kind: 'SITE' as const, value: 'different-site' }] },
          { ...scope, processingPurposeRef: { ...scope.processingPurposeRef, resourceId: 'purpose:other' } },
        ]) {
          const store = makeConsentDecisionStore();
          yield* store.record(decision('GRANTED', 'original:scope', '2026-01-01T00:00:00Z'), version);
          expect(Exit.isFailure(yield* Effect.exit(store.record({ ...withdrawn, scope: changed }, version)))).toBe(
            true,
          );
        }
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              makeConsentDecisionStore().record(
                decision('WITHDRAWN', 'before:version', '2024-12-31T00:00:00Z'),
                version,
              ),
            ),
          ),
        ).toBe(true);
        // The existing in-period withdrawal semantics are not an ended-version exemption.
        yield* makeConsentDecisionStore().record(
          decision('WITHDRAWN', 'within:version', '2026-01-10T00:00:00Z'),
          version,
        );
      }),
  );

  it.effect('keeps a scope bound to its original typed Subject across distinct decisions and times', () =>
    Effect.gen(function* immutableConsentSubject() {
      const store = makeConsentDecisionStore();
      const withdrawn = decision('WITHDRAWN', 'decision:subject-a', '2026-01-01T00:00:00Z');
      yield* store.record(withdrawn);
      const granted = decision('GRANTED', 'decision:subject-b', '2026-02-01T00:00:00Z');
      const result = yield* Effect.exit(
        store.record({
          ...granted,
          scope: { ...granted.scope, privacySubjectRef: { ...scope.privacySubjectRef, resourceId: 'subject:other' } },
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(store.current(scope.scopeRef)).toEqual({ decision: withdrawn, outcome: 'CURRENT' });
      expect(store.history(scope.scopeRef)).toEqual([withdrawn]);
    }),
  );

  it('accepts explicit decisions and preserves the full evidence envelope', () => {
    const granted = decision('GRANTED', 'decision:grant', '2026-01-01T00:00:00Z');
    expect(validateConsentDecision(granted)).toBeUndefined();
    const decoded = Schema.decodeUnknownSync(ConsentDecisionSchema)(granted);
    expect(decoded.decision).toBe('GRANTED');
    expect(decoded.scope.scopeRef).toBe('scope:security');
  });

  it.effect('supports refusal, withdrawal, and re-grant as immutable history', () =>
    Effect.gen(function* retainsConsentHistory() {
      const store = makeConsentDecisionStore();
      yield* store.record(decision('GRANTED', 'decision:grant', '2026-01-01T00:00:00Z'));
      yield* store.record(decision('WITHDRAWN', 'decision:withdraw', '2026-02-01T00:00:00Z'));
      yield* store.record(decision('GRANTED', 'decision:regrant', '2026-03-01T00:00:00Z'));
      expect(store.history('scope:security').map(({ decision: kind }) => kind)).toEqual([
        'GRANTED',
        'WITHDRAWN',
        'GRANTED',
      ]);
      expect(store.current('scope:security')).toMatchObject({
        decision: { decision: 'GRANTED' },
        outcome: 'CURRENT',
      });
    }),
  );

  it('accepts actor or trusted flow attribution while retaining notice and provenance evidence', () => {
    const incomplete = decision('GRANTED', 'decision:bad', '2026-02-01T00:00:00Z');
    expect(validateConsentDecision({ ...incomplete, flowEvidenceRefs: [] })).toBeUndefined();
    expect(
      validateConsentDecision({
        ...incomplete,
        actorEvidence: null,
        flowEvidenceRefs: ['flow:trusted-checkout'],
        flowEvidenceTrust: 'TRUSTED_OPERATION_CONTEXT',
      }),
    ).toBeUndefined();
    expect(validateConsentDecision({ ...incomplete, actorEvidence: null, flowEvidenceRefs: [] })).toContain(
      'actor evidence or trusted flow evidence',
    );
    expect(validateConsentDecision({ ...incomplete, recordedAt: '2026-01-01T00:00:00Z' })).toContain('precede');
    expect(validateConsentDecision({ ...incomplete, noticeEvidenceRefs: [] })).toBeDefined();
    expect(validateConsentDecision({ ...incomplete, provenanceRefs: [] })).toBeDefined();
    expect(makeConsentDecisionStore().current('scope:security')).toEqual({ outcome: 'ABSENT' });
  });

  it('validates pinned meaning against the supplied historical Purpose Version', () => {
    const historicalPurposeVersion = {
      effectiveFrom: '2025-01-01T00:00:00Z',
      effectiveTo: null,
      materialChangeAssessment: null,
      meaning: scope.purposeMeaning,
      recordedAt: '2025-01-01T00:00:00Z',
      requiredConsentDimensions: ['COMMUNICATION_CHANNEL'] as const,
      versionId: scope.purposeVersionRef,
      versionNumber: 1,
    };
    const granted = decision('GRANTED', 'decision:historical-purpose', '2026-02-01T00:00:00Z');
    expect(validateConsentDecision(granted, historicalPurposeVersion)).toContain('COMMUNICATION_CHANNEL');
    expect(
      validateConsentDecision(
        {
          ...granted,
          scope: {
            ...granted.scope,
            materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' }],
          },
        },
        historicalPurposeVersion,
      ),
    ).toBeUndefined();
    expect(
      validateConsentDecision(
        {
          ...granted,
          scope: {
            ...granted.scope,
            materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' }],
            purposeMeaning: 'Caller-supplied different meaning',
          },
        },
        historicalPurposeVersion,
      ),
    ).toContain('Purpose meaning');
  });

  it.effect('distinguishes absence from an explicit refusal', () =>
    Effect.gen(function* distinguishesAbsentConsent() {
      const absent = makeConsentDecisionStore();
      expect(absent.currentResolution('scope:security')).toEqual({ outcome: 'ABSENT' });

      const refused = makeConsentDecisionStore();
      yield* refused.record(decision('REFUSED', 'decision:refusal', '2026-01-01T00:00:00Z'));
      expect(refused.currentResolution('scope:security')).toMatchObject({
        decision: { decision: 'REFUSED' },
        outcome: 'CURRENT',
      });
    }),
  );

  it.effect('makes public retries idempotent and rejects a changed retry payload', () =>
    Effect.gen(function* handlesConsentRetry() {
      const store = makeConsentDecisionStore();
      const first = {
        ...decision('GRANTED', 'decision:retry', '2026-01-01T00:00:00Z'),
        idempotencyKey: 'consent:retry',
      };
      expect(yield* store.record(first)).toStrictEqual(first);
      expect(yield* store.record({ ...first })).toStrictEqual(first);
      expect(store.history('scope:security')).toHaveLength(1);
      const error = yield* Effect.flip(store.record({ ...first, decision: 'REFUSED' }));
      expect(error).toBeInstanceOf(ConsentDecisionInvariantError);
      expect(error.reason).toBe('Consent Decision idempotency conflict');
    }),
  );

  it.effect('uses authoritative effective time, not arrival or recorded time, and never resurrects', () =>
    Effect.gen(function* ordersConsentByEffectiveTime() {
      const store = makeConsentDecisionStore();
      yield* store.record(decision('WITHDRAWN', 'decision:withdrawal', '2026-03-01T00:00:00Z'));
      yield* store.record(decision('GRANTED', 'decision:delayed-old-grant', '2026-02-01T00:00:00Z'));
      expect(store.currentResolution('scope:security')).toMatchObject({
        decision: { decision: 'WITHDRAWN' },
        outcome: 'CURRENT',
      });
    }),
  );

  it.effect('leaves genuinely concurrent choices unresolved instead of choosing last write', () =>
    Effect.gen(function* preservesConsentConflict() {
      const store = makeConsentDecisionStore();
      yield* store.record(decision('GRANTED', 'decision:grant-race', '2026-04-01T00:00:00Z'));
      yield* store.record(decision('WITHDRAWN', 'decision:withdraw-race', '2026-04-01T00:00:00Z'));
      expect(store.current('scope:security')).toMatchObject({
        outcome: 'CONFLICT',
        reason: 'SAME_EFFECTIVE_TIME',
      });
      expect(store.currentResolution('scope:security')).toMatchObject({ outcome: 'CONFLICT' });
      expect(store.history('scope:security')).toHaveLength(2);
    }),
  );
});
