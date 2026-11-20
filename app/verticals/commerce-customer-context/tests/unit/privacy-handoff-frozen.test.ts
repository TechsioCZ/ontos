/**
 * Frozen owner-side behaviour of the Privacy measure handoff. The literal was recorded from base 6adcc096f BEFORE the
 * handoff gained its optional owner scope; a handoff without one must keep reproducing it byte for byte.
 */
import { fingerprintPrivacyMeasureHandoff } from '../../src/privacy-measure-handoff.ts';
import { expect, it } from 'effect-rstest';

const handoff = {
  contentScopeRefs: ['b.scope', 'a.scope'],
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['evidence:2', 'evidence:1'],
  idempotencyKey: 'privacy-idempotency-1',
  kind: 'DELETE',
  measureId: 'measure-1',
  owningCapability: 'commerce.customer-context',
  preconditionRefs: [],
  requestedAt: '2026-11-20T10:00:00.000Z',
  requestedResult: 'erase',
  resourceRefs: ['r2', 'r1'],
  right: 'ERASURE',
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 1,
  subjectRef: 'subject-1',
  taskId: 'task-1',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;
it('keeps the owner receipt fingerprint of a handoff without an owner scope exactly', () => {
  expect(fingerprintPrivacyMeasureHandoff(handoff)).toBe(
    '5a2b26169c61f62a2886b9b4d5ac0944b7544c8b7166620ccbae3a5b372a3a6f',
  );
});
