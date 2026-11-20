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
