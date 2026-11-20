/**
 * Frozen owner-side behaviour of the Privacy measure handoff. The literal was recorded from base 6adcc096f BEFORE the
 * handoff gained its optional owner scope; a handoff without one must keep reproducing it byte for byte.
 */
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { fingerprintSymmyJobPrivacyHandoff } from '../../src/services/symmy-job-privacy-fingerprint.ts';
import { NodeCrypto } from '@effect/platform-node';

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
it.effect('keeps the owner receipt fingerprint of a handoff without an owner scope exactly', () =>
  Effect.gen(function* frozenFingerprint() {
    const value = yield* fingerprintSymmyJobPrivacyHandoff(handoff).pipe(Effect.provide(NodeCrypto.layer));
    expect(value).toBe('eccd4b1ac56a56c881fa745a71ad43048887dc579df1a1064396facdbf8dd79b');
  }),
);
