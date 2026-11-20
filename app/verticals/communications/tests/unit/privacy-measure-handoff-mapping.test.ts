import { NodeCrypto } from '@effect/platform-node';
import {
  PrivacyMeasureHandoffSchema,
  validateOwnerExecutionAuthorityResult,
} from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { DateTime, Effect, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  communicationsMeasureOf,
  fingerprintCommunicationsHandoff,
  ownerScopeCanonicalText,
  privacyOutcomeOf,
  rejectedOutcomeOf,
  sha256Hex,
} from '../../shared/privacy-owner/measure-handoff.ts';
import { evaluateCommunicationsOwnerMeasure } from '../../shared/privacy-owner/outcome.ts';
import { scopePartRefs } from '../../shared/privacy-owner/inventory.ts';
import {
  allComplete,
  confirmedAt,
  coverageOf,
  evidenceOf,
  foundCoverage,
  intentRef,
  measureOf,
} from './support/privacy-owner-fixtures.ts';

const tenantId = '00000000-0000-4000-8000-0000000000a1';
const lookup = {
  _tag: 'SUBJECT_REFERENCE' as const,
  lookupRef: 'FICTIONAL-lookup-1',
  moduleId: 'party.registry',
  resourceId: 'party-1',
  resourceType: 'party',
};
const ownerScope = {
  controllerRef: 'FICTIONAL-controller',
  requestedScopePartRefs: [...scopePartRefs],
  requestedScopeRef: 'FICTIONAL-requested-scope',
  trustedLookups: [lookup],
};
type HandoffInput = Partial<typeof PrivacyMeasureHandoffSchema.Encoded>;
const handoffOf = (overrides: HandoffInput = {}): PrivacyMeasureHandoff =>
  Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
    contentScopeRefs: ['communications.core.history'],
    controllerObligationRef: null,
    dispositionDecision: 'DELETE',
    expectedEvidenceRefs: ['FICTIONAL-expected-evidence'],
    idempotencyKey: 'FICTIONAL-idempotency-1',
    kind: 'DELETE',
    measureId: 'FICTIONAL-measure-1',
    ownerScope,
    owningCapability: 'communications.core',
    preconditionRefs: [],
    requestedAt: '2026-11-19T10:00:00.000Z',
    requestedResult: 'erase message metadata',
    resourceRefs: [intentRef('a'), intentRef('b')],
    right: 'ERASURE',
    sourceDecisionRef: 'FICTIONAL-decision-1',
    sourceDecisionRevision: 1,
    subjectRef: 'FICTIONAL-subject-1',
    taskId: 'FICTIONAL-task-1',
    tenantId,
    ...overrides,
  });

const outcomeOfKind = (overrides: HandoffInput) => {
  const result = communicationsMeasureOf(handoffOf(overrides));
  return Result.isSuccess(result) ? result.success.measure.intendedOutcome : result.failure;
};
const dispatched = (overrides: HandoffInput = {}) => {
  const result = communicationsMeasureOf(handoffOf(overrides));
  if (Result.isFailure(result)) {
    throw new Error(`fixture rejected: ${result.failure}`);
  }
  return result.success;
};
const reasonOf = (handoff: PrivacyMeasureHandoff) => {
  const result = communicationsMeasureOf(handoff);
  return Result.isFailure(result) ? result.failure : 'ACCEPTED';
};

describe('the owner-contract measure of a Privacy handoff', () => {
  it('takes every field from the handoff and its own owner scope and invents none', () => {
    const result = communicationsMeasureOf(handoffOf({ controllerObligationRef: 'FICTIONAL-obligation-1' }));
    expect(Result.isSuccess(result)).toBe(true);
    const measure = Result.isSuccess(result) ? result.success.measure : undefined;
    expect(measure).toEqual({
      expectedEvidenceRefs: ['FICTIONAL-expected-evidence'],
      idempotencyKey: 'FICTIONAL-idempotency-1',
      intendedOutcome: 'DELETE',
      measureRef: 'FICTIONAL-measure-1',
      preconditionRefs: [],
      requestedAt: '2026-11-19T10:00:00.000Z',
      scope: {
        controllerRef: 'FICTIONAL-controller',
        dsrControllerObligationRef: 'FICTIONAL-obligation-1',
        ownerCapability: 'communications.core',
        requestedScopePartRefs: scopePartRefs,
        requestedScopeRef: 'FICTIONAL-requested-scope',
        subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'FICTIONAL-subject-1' },
        tenantId,
        trustedLookupRefs: ['FICTIONAL-lookup-1'],
      },
      sourceDecisionRef: 'FICTIONAL-decision-1',
      sourceDecisionRevision: '1',
      targetContentRefs: [intentRef('a'), intentRef('b')],
    });
  });

  it('maps the kinds Communications can evaluate and rejects, by name, the ones it cannot', () => {
    expect(outcomeOfKind({ dispositionDecision: 'ANONYMIZE', kind: 'ANONYMIZE' })).toBe('ANONYMIZE');
    expect(outcomeOfKind({ dispositionDecision: null, kind: 'RECTIFY', right: 'RECTIFICATION' })).toBe('RECTIFY');
    expect(outcomeOfKind({ dispositionDecision: 'RESTRICT', kind: 'RESTRICT' })).toBe(
      'ENFORCE_DISPOSITION_RESTRICTION',
    );
    expect(
      outcomeOfKind({ dispositionDecision: null, kind: 'RESTRICT', requestedResult: 'processing restriction' }),
    ).toBe('ENFORCE_PROCESSING_RESTRICTION');
    expect(outcomeOfKind({ dispositionDecision: null, kind: 'RESTRICT', requestedResult: 'something' })).toBe(
      'RESTRICTION_KIND_IS_AMBIGUOUS',
    );
    expect(outcomeOfKind({ dispositionDecision: null, kind: 'EXPORT', right: 'ACCESS' })).toBe(
      'EXPORT_IS_NOT_A_COMMUNICATIONS_OWNER_MEASURE',
    );
  });

  it('rejects a handoff of another owner, without an owner scope or with targets that are not a unique set', () => {
    expect(reasonOf(handoffOf({ owningCapability: 'integration.symmy' }))).toBe('HANDOFF_IS_NOT_FOR_COMMUNICATIONS');
    const { ownerScope: _absent, ...unscoped } = handoffOf();
    expect(reasonOf(unscoped)).toBe('HANDOFF_OWNER_SCOPE_IS_ABSENT_OR_INVALID');
    expect(reasonOf(handoffOf({ resourceRefs: ['x', 'x'] }))).toBe('HANDOFF_OWNER_SCOPE_IS_ABSENT_OR_INVALID');
  });
});

describe('the scope digest and the handoff fingerprint', () => {
  it('binds evidence to the exact scope: controller, subject, requested scope, lookups and obligation all change it', () => {
    const base = ownerScopeCanonicalText(dispatched());
    expect(
      ownerScopeCanonicalText(
        dispatched({ ownerScope: { ...ownerScope, requestedScopePartRefs: [...scopePartRefs].toReversed() } }),
      ),
    ).toBe(base);
    for (const changed of [
      dispatched({ ownerScope: { ...ownerScope, controllerRef: 'another-controller' } }),
      dispatched({ ownerScope: { ...ownerScope, requestedScopeRef: 'another-scope' } }),
      dispatched({ ownerScope: { ...ownerScope, trustedLookups: [{ ...lookup, resourceId: 'party-2' }] } }),
      dispatched({ subjectRef: 'another-subject' }),
      dispatched({ controllerObligationRef: 'FICTIONAL-obligation-1' }),
    ]) {
      expect(ownerScopeCanonicalText(changed)).not.toBe(base);
    }
  });

  it.effect('fingerprints the exact handoff with a stable, order-free digest', () =>
    Effect.gen(function* fingerprints() {
      const first = yield* fingerprintCommunicationsHandoff(handoffOf());
      expect(first).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        yield* fingerprintCommunicationsHandoff(handoffOf({ resourceRefs: [intentRef('b'), intentRef('a')] })),
      ).toBe(first);
      expect(yield* fingerprintCommunicationsHandoff(handoffOf({ taskId: 'another-task' }))).not.toBe(first);
      expect(
        yield* fingerprintCommunicationsHandoff(handoffOf({ ownerScope: { ...ownerScope, controllerRef: 'another' } })),
      ).not.toBe(first);
      expect(yield* sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe('the cross-owner fingerprint contract', () => {
  it.effect('fingerprints the shared literal handoff exactly as Privacy does', () =>
    Effect.gen(function* crossOwnerFingerprint() {
      const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
        contentScopeRefs: ['communications.core.history'],
        controllerObligationRef: null,
        dispositionDecision: 'DELETE',
        expectedEvidenceRefs: ['FICTIONAL-expected-evidence'],
        idempotencyKey: 'FICTIONAL-idempotency-1',
        kind: 'DELETE',
        measureId: 'FICTIONAL-measure-1',
        ownerScope: {
          controllerRef: 'FICTIONAL-controller',
          requestedScopePartRefs: ['communications.history', 'communications.attachment-link-references'],
          requestedScopeRef: 'FICTIONAL-requested-scope',
          trustedLookups: [
            {
              _tag: 'SUBJECT_REFERENCE',
              lookupRef: 'FICTIONAL-lookup-1',
              moduleId: 'party.registry',
              resourceId: 'party-1',
              resourceType: 'party',
            },
          ],
        },
        owningCapability: 'communications.core',
        preconditionRefs: [],
        requestedAt: '2026-11-19T10:00:00.000Z',
        requestedResult: 'erase message metadata',
        resourceRefs: ['communications.core.intent:b', 'communications.core.intent:a'],
        right: 'ERASURE',
        sourceDecisionRef: 'FICTIONAL-decision-1',
        sourceDecisionRevision: 1,
        subjectRef: 'FICTIONAL-subject-1',
        taskId: 'FICTIONAL-task-1',
        tenantId: '00000000-0000-4000-8000-0000000000a1',
      });
      expect(yield* fingerprintCommunicationsHandoff(handoff)).toBe(
        'd766e8d812c4955f2c7c853cd14efe8da22fb34ea88abfb67f38e5a1fd1fdf3c',
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe("the owner's answer in Privacy's own Owner Execution Outcome vocabulary", () => {
  const handoff = handoffOf();
  const common = {
    attempt: 1,
    handoff,
    occurredAt: DateTime.makeUnsafe('2026-11-19T11:00:00.000Z'),
    outcomeId: 'communications.core.privacy-owner-outcome:fixture:1',
    recordedAt: DateTime.makeUnsafe('2026-11-19T12:00:00.000Z'),
  };
  const mapped = (outcome: ReturnType<typeof evaluateCommunicationsOwnerMeasure>) =>
    privacyOutcomeOf({ ...common, outcome });
  const evaluate = (
    overrides: Parameters<typeof evaluateCommunicationsOwnerMeasure>[0] extends infer Input ? Partial<Input> : never,
  ) =>
    evaluateCommunicationsOwnerMeasure({
      blockers: [],
      confirmedAt,
      coverage: foundCoverage(),
      evidence: [],
      evidenceRefs: ['FICTIONAL-handoff-evidence'],
      measure: measureOf(),
      outcomeRef: common.outcomeId,
      ...overrides,
    });
  /** Privacy accepts an owner receipt only if every approved Resource is included or remaining: prove it for every status. */
  const accepted = (outcome: ReturnType<typeof mapped>) =>
    validateOwnerExecutionAuthorityResult(
      handoff,
      { attempt: 1, measureId: handoff.measureId, taskId: handoff.taskId },
      {
        authorityRef: 'communications.core.api.privacy-owner-execution-outcome',
        contentScopeRefs: handoff.contentScopeRefs,
        evidenceRefs: outcome.evidenceRefs,
        outcome,
        receiptRef: outcome.outcomeId,
        resourceRefs: handoff.resourceRefs,
        subjectRef: handoff.subjectRef,
        tenantId: handoff.tenantId,
      },
    );

  it('reports a measure nobody confirmed anything for as RECEIVED with every Resource remaining, never as a result', () => {
    const outcome = mapped(evaluate({}));
    expect(outcome).toMatchObject({ reason: 'AWAITING_HUMAN_CONFIRMED_OWNER_ACTION', status: 'RECEIVED' });
    expect(outcome.includedResourceRefs).toEqual([]);
    expect(outcome.remainingResourceRefs).toEqual([intentRef('a'), intentRef('b')]);
    expect(accepted(outcome)).toBeUndefined();
  });

  it('maps ACHIEVED to SUCCEEDED and PARTIAL to PARTIAL with the exact included and remaining partition', () => {
    const achieved = mapped(evaluate({ coverage: coverageOf(allComplete()), evidence: [evidenceOf()] }));
    expect(achieved.status).toBe('SUCCEEDED');
    expect(achieved.includedResourceRefs).toEqual([intentRef('a'), intentRef('b')]);
    expect(achieved.remainingResourceRefs).toEqual([]);
    expect(accepted(achieved)).toBeUndefined();
    const partial = mapped(
      evaluate({
        coverage: coverageOf(allComplete()),
        evidence: [evidenceOf({ results: [{ contentRef: intentRef('a'), result: 'REMOVED' }] })],
      }),
    );
    expect(partial.status).toBe('PARTIAL');
    expect(partial.includedResourceRefs).toEqual([intentRef('a')]);
    expect(partial.remainingResourceRefs).toEqual([intentRef('b')]);
    expect(accepted(partial)).toBeUndefined();
  });

  it('keeps the names Privacy and the owner contract share, and never settles a Resource for them', () => {
    const inProgress = mapped(evaluate({ evidence: [evidenceOf({ phase: 'IN_PROGRESS', results: [] })] }));
    expect(inProgress.status).toBe('IN_PROGRESS');
    const failedAfter = mapped(
      evaluate({
        coverage: coverageOf(allComplete()),
        evidence: [evidenceOf({ results: [{ contentRef: intentRef('a'), result: 'FAILED_AFTER_POSSIBLE_MUTATION' }] })],
      }),
    );
    expect(failedAfter.status).toBe('INDETERMINATE');
    const failedBefore = mapped(
      evaluate({
        coverage: coverageOf(allComplete()),
        evidence: [
          evidenceOf({
            results: [
              { contentRef: intentRef('a'), result: 'FAILED_BEFORE_ANY_MUTATION' },
              { contentRef: intentRef('b'), result: 'FAILED_BEFORE_ANY_MUTATION' },
            ],
          }),
        ],
      }),
    );
    expect(failedBefore.status).toBe('TECHNICAL_FAILED');
    const blocked = mapped(
      evaluate({ blockers: [{ blockerRef: 'FICTIONAL-hold', contentRefs: [intentRef('a')], kind: 'LEGAL_HOLD' }] }),
    );
    expect(blocked.status).toBe('BLOCKED');
    const noData = mapped(evaluate({ coverage: coverageOf(allComplete()) }));
    expect(noData.status).toBe('NOT_APPLICABLE');
    for (const outcome of [inProgress, failedAfter, failedBefore, blocked, noData]) {
      expect(outcome.includedResourceRefs, outcome.status).toEqual([]);
      expect(outcome.remainingResourceRefs, outcome.status).toEqual([intentRef('a'), intentRef('b')]);
      expect(accepted(outcome), outcome.status).toBeUndefined();
    }
  });

  it('answers a handoff it cannot evaluate with a truthful BUSINESS_REJECTED that Privacy accepts', () => {
    const rejected = rejectedOutcomeOf({
      ...common,
      evidenceRefs: ['communications.core.privacy-measure-handoff:fixture'],
      reason: 'EXPORT_IS_NOT_A_COMMUNICATIONS_OWNER_MEASURE',
    });
    expect(rejected).toMatchObject({
      includedResourceRefs: [],
      reason: 'EXPORT_IS_NOT_A_COMMUNICATIONS_OWNER_MEASURE',
      status: 'BUSINESS_REJECTED',
    });
    expect(accepted(rejected)).toBeUndefined();
  });
});
