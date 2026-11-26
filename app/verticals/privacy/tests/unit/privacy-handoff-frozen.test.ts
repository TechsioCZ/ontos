/**
 * Frozen owner-side behaviour of the Privacy measure handoff. The literal was recorded from base 6adcc096f BEFORE the
 * handoff gained its optional owner scope; a handoff without one must keep reproducing it byte for byte.
 */
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PrivacyMeasureHandoffSchema } from '../../shared/domain/privacy-measure-handoff.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/privacy-measure-dispatched.ts';

const handoff = {
  contentScopeRefs: ['b.scope', 'a.scope'],
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['evidence:2', 'evidence:1'],
  idempotencyKey: 'privacy-idempotency-1',
  kind: 'DELETE',
  measureId: 'measure-1',
  owningCapability: 'integration.symmy',
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
it('keeps the encoded handoff, its canonical hash and its outbox payload of a handoff without an owner scope exactly', () => {
  const decoded = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)(handoff);
  expect(Schema.encodeSync(Schema.fromJsonString(PrivacyMeasureHandoffSchema))(decoded)).toBe(
    '{"contentScopeRefs":["b.scope","a.scope"],"controllerObligationRef":null,"dispositionDecision":"DELETE","expectedEvidenceRefs":["evidence:2","evidence:1"],"idempotencyKey":"privacy-idempotency-1","kind":"DELETE","measureId":"measure-1","owningCapability":"integration.symmy","preconditionRefs":[],"requestedAt":"2026-11-20T10:00:00.000Z","requestedResult":"erase","resourceRefs":["r2","r1"],"right":"ERASURE","sourceDecisionRef":"decision-1","sourceDecisionRevision":1,"subjectRef":"subject-1","taskId":"task-1","tenantId":"30000000-0000-4000-8000-000000000001"}',
  );
  expect(computeCanonicalValueHash(decoded)).toBe('f436df624065a034d6bfa3f3e19f955352371e1b63effe95d1f7390c7c304f3d');
  expect(Schema.encodeSync(Schema.fromJsonString(OutboxPayloadSchema))({ handoff: decoded })).toBe(
    '{"handoff":{"contentScopeRefs":["b.scope","a.scope"],"controllerObligationRef":null,"dispositionDecision":"DELETE","expectedEvidenceRefs":["evidence:2","evidence:1"],"idempotencyKey":"privacy-idempotency-1","kind":"DELETE","measureId":"measure-1","owningCapability":"integration.symmy","preconditionRefs":[],"requestedAt":"2026-11-20T10:00:00.000Z","requestedResult":"erase","resourceRefs":["r2","r1"],"right":"ERASURE","sourceDecisionRef":"decision-1","sourceDecisionRevision":1,"subjectRef":"subject-1","taskId":"task-1","tenantId":"30000000-0000-4000-8000-000000000001"}}',
  );
});
