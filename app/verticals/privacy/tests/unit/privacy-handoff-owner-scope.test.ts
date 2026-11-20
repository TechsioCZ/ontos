import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  PrivacyMeasureHandoffSchema,
  createPrivacyMeasureDispatch,
  prepareOwnerActionRequest,
  recordOwnerExecutionOutcome,
  validatePrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import type { PrivacyMeasureHandoff } from '../../shared/domain/privacy-measure-handoff.ts';
import { normalizeOwnerScope, PrivacyMeasureOwnerScopeSchema } from '../../shared/domain/privacy-owner-scope.ts';
import type { PrivacyMeasureOwnerScope } from '../../shared/domain/privacy-owner-scope.ts';

const tenantId = '30000000-0000-4000-8000-000000000001';
const base: PrivacyMeasureHandoff = {
  contentScopeRefs: ['communications.core.history'],
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: [],
  idempotencyKey: 'privacy-idempotency-1',
  kind: 'DELETE',
  measureId: 'measure-1',
  owningCapability: 'communications.core',
  preconditionRefs: [],
  requestedAt: '2026-11-20T10:00:00.000Z',
  requestedResult: 'erase message metadata',
  resourceRefs: ['communications.core.intent:intent-1'],
  right: 'ERASURE',
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 1,
  subjectRef: 'subject-1',
  taskId: 'task-1',
  tenantId,
};
const ownerScope = {
  controllerRef: 'controller-1',
  requestedScopePartRefs: ['communications.core.history'],
  requestedScopeRef: 'scope-1',
  trustedLookups: [
    {
      _tag: 'SUBJECT_REFERENCE' as const,
      lookupRef: 'lookup-1',
      moduleId: 'party.registry',
      resourceId: 'party-1',
      resourceType: 'party',
    },
  ],
};
const decode = Schema.decodeUnknownResult(PrivacyMeasureHandoffSchema);

it('carries the optional owner scope through the handoff codec and keeps its absence absent', () => {
  const withScope = decode({ ...base, ownerScope });
  expect(Result.isSuccess(withScope)).toBe(true);
  const encoded = Schema.encodeSync(Schema.fromJsonString(PrivacyMeasureHandoffSchema));
  const decoded = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({ ...base, ownerScope });
  expect(JSON.parse(encoded(decoded))).toMatchObject({ ownerScope });
  const without = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)(base);
  expect('ownerScope' in without).toBe(false);
  expect(encoded(without)).not.toContain('ownerScope');
});

it('rejects an owner scope without a requested scope, with duplicate parts or with duplicate lookups', () => {
  for (const invalid of [
    { ...ownerScope, requestedScopePartRefs: [] },
    { ...ownerScope, requestedScopePartRefs: ['a', 'a'] },
    { ...ownerScope, trustedLookups: [] },
    { ...ownerScope, trustedLookups: [...ownerScope.trustedLookups, ...ownerScope.trustedLookups] },
    { ...ownerScope, controllerRef: '' },
  ]) {
    expect(Result.isFailure(decode({ ...base, ownerScope: invalid }))).toBe(true);
  }
});

it('requires the exact owner scope only for a Communications measure', () => {
  expect(validatePrivacyMeasureHandoff(base)).toEqual(['A Communications measure must carry its exact owner scope']);
  expect(
    validatePrivacyMeasureHandoff(Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({ ...base, ownerScope })),
  ).toEqual([]);
  expect(validatePrivacyMeasureHandoff({ ...base, owningCapability: 'integration.symmy' })).toEqual([]);
});

it.effect('treats a changed owner scope under the same idempotency identity as a payload conflict', () =>
  Effect.gen(function* conflictOnScope() {
    const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({ ...base, ownerScope });
    const dispatch = yield* createPrivacyMeasureDispatch(handoff, '2026-11-20T10:00:00.000Z');
    const changed = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
      ...base,
      ownerScope: { ...ownerScope, controllerRef: 'another-controller' },
    });
    const outcome = {
      attempt: 1,
      evidenceRefs: [],
      idempotencyKey: handoff.idempotencyKey,
      includedResourceRefs: [],
      measureId: handoff.measureId,
      occurredAt: '2026-11-20T10:00:00.000Z',
      outcomeId: 'outcome-1',
      owningCapability: handoff.owningCapability,
      reason: 'received',
      recordedAt: '2026-11-20T10:00:00.000Z',
      remainingResourceRefs: handoff.resourceRefs,
      sourceDecisionRef: handoff.sourceDecisionRef,
      sourceDecisionRevision: handoff.sourceDecisionRevision,
      status: 'RECEIVED' as const,
      taskId: handoff.taskId,
    };
    const same = yield* Effect.result(
      recordOwnerExecutionOutcome(dispatch, prepareOwnerActionRequest(dispatch, 'a'), outcome, 'now'),
    );
    expect(Result.isSuccess(same)).toBe(true);
    const conflict = yield* Effect.result(
      recordOwnerExecutionOutcome(
        dispatch,
        prepareOwnerActionRequest({ ...dispatch, handoff: changed }, 'a'),
        outcome,
        'now',
      ),
    );
    expect(Result.isFailure(conflict)).toBe(true);
  }),
);

type Assessment = NonNullable<PrivacyMeasureOwnerScope['blockerAssessment']>;
const assessment: Assessment = {
  assessedByRef: 'privacy-assessment-1',
  blockers: [
    {
      blockerRef: 'hold-b',
      contentRefs: ['communications.core.intent:b2', 'communications.core.intent:b1'],
      kind: 'LEGAL_HOLD',
    },
    { blockerRef: 'hold-a', contentRefs: ['communications.core.intent:a1'], kind: 'RETENTION_OBLIGATION' },
  ],
};
const handoffWith = (blockerAssessment: Assessment) =>
  Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
    ...base,
    ownerScope: { ...ownerScope, blockerAssessment },
  });
const scopeWith = (blockerAssessment: Assessment) =>
  Schema.decodeUnknownSync(PrivacyMeasureOwnerScopeSchema)({ ...ownerScope, blockerAssessment });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(PrivacyMeasureHandoffSchema));

it("carries Privacy's blocker assessment on the owner scope and rejects a malformed one", () => {
  expect(JSON.parse(encodeJson(handoffWith(assessment)))).toMatchObject({
    ownerScope: { blockerAssessment: assessment },
  });
  // an empty list is the explicit statement "assessed, none found"; its absence is "not assessed" and stays absent
  expect(
    Result.isSuccess(
      decode({ ...base, ownerScope: { ...ownerScope, blockerAssessment: { ...assessment, blockers: [] } } }),
    ),
  ).toBe(true);
  expect(encodeJson(Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({ ...base, ownerScope }))).not.toContain(
    'blocker',
  );
  const [first] = assessment.blockers;
  for (const invalid of [
    { ...assessment, assessedByRef: '' },
    { ...assessment, blockers: [{ ...first, contentRefs: [] }] },
    { ...assessment, blockers: [{ ...first, kind: 'HIDDEN' }] },
    { ...assessment, blockers: [first, first] },
    { blockers: [] },
  ]) {
    expect(Result.isFailure(decode({ ...base, ownerScope: { ...ownerScope, blockerAssessment: invalid } }))).toBe(true);
  }
});

it('orders the blocker references canonically, so the coordinator and the owner fingerprint the same scope the same way', () => {
  const normalized = normalizeOwnerScope(scopeWith(assessment));
  expect(normalized.blockerAssessment?.blockers.map(({ blockerRef }) => blockerRef)).toEqual(['hold-a', 'hold-b']);
  expect(normalized.blockerAssessment?.blockers[1]?.contentRefs).toEqual([
    'communications.core.intent:b1',
    'communications.core.intent:b2',
  ]);
  const plain = Schema.decodeUnknownSync(PrivacyMeasureOwnerScopeSchema)(ownerScope);
  expect(normalizeOwnerScope(plain)).toEqual(plain);
});

it.effect(
  'binds the blocker assessment into the handoff identity: another assessment conflicts, a reordered one does not',
  () =>
    Effect.gen(function* assessmentIdentity() {
      const handoff = handoffWith(assessment);
      const dispatch = yield* createPrivacyMeasureDispatch(handoff, '2026-11-20T10:00:00.000Z');
      const outcome = {
        attempt: 1,
        evidenceRefs: [],
        idempotencyKey: handoff.idempotencyKey,
        includedResourceRefs: [],
        measureId: handoff.measureId,
        occurredAt: '2026-11-20T10:00:00.000Z',
        outcomeId: 'outcome-1',
        owningCapability: handoff.owningCapability,
        reason: 'received',
        recordedAt: '2026-11-20T10:00:00.000Z',
        remainingResourceRefs: handoff.resourceRefs,
        sourceDecisionRef: handoff.sourceDecisionRef,
        sourceDecisionRevision: handoff.sourceDecisionRevision,
        status: 'RECEIVED' as const,
        taskId: handoff.taskId,
      };
      const matches = (candidate: PrivacyMeasureHandoff) =>
        Effect.result(
          recordOwnerExecutionOutcome(
            dispatch,
            prepareOwnerActionRequest({ ...dispatch, handoff: candidate }, 'a'),
            outcome,
            'now',
          ),
        );
      const [first, second] = assessment.blockers;
      const swapped = second === undefined || first === undefined ? [] : [second, first];
      expect(Result.isSuccess(yield* matches(handoffWith({ ...assessment, blockers: swapped })))).toBe(true);
      for (const other of [
        handoffWith({ ...assessment, assessedByRef: 'another-assessment' }),
        handoffWith({ ...assessment, blockers: assessment.blockers.slice(1) }),
        handoffWith({ assessedByRef: assessment.assessedByRef, blockers: [] }),
        Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({ ...base, ownerScope }),
      ]) {
        expect(Result.isFailure(yield* matches(other))).toBe(true);
      }
    }),
);

it('refuses at dispatch a Communications measure whose targets are not its own content references', () => {
  const scoped = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({ ...base, ownerScope });
  expect(validatePrivacyMeasureHandoff(scoped)).toEqual([]);
  for (const resourceRefs of [
    ['party.registry|party|le|x'],
    ['communications.core.intent:'],
    ['communications.core.intent:ok', 'bad'],
  ]) {
    expect(validatePrivacyMeasureHandoff({ ...scoped, resourceRefs })).toEqual([
      'A Communications measure must target only Communications content references',
    ]);
  }
  // another owner's vocabulary is its own owner's concern
  expect(
    validatePrivacyMeasureHandoff({ ...base, owningCapability: 'integration.symmy', resourceRefs: ['x'] }),
  ).toEqual([]);
});
