import { webCryptoDigestFixture } from '@app/core-runtime/testing/webcrypto-digest';
import { WebCrypto } from 'effect/crypto';
import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  fingerprintSymmyJobPrivacyHandoff,
  symmyJobPrivacyDigest,
} from '../../src/services/symmy-job-privacy-fingerprint.ts';

const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  contentScopeRefs: ['integration.symmy.job:10000000-0000-4000-8000-000000000001#integration.symmy.job-intent'],
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['evidence-b', 'evidence-a'],
  idempotencyKey: 'internal-owner-receipt',
  kind: 'DELETE',
  measureId: 'internal-measure',
  owningCapability: 'integration.symmy',
  preconditionRefs: ['precondition-b', 'precondition-a'],
  requestedAt: '2026-11-07T00:00:00.000Z',
  requestedResult: 'Erase the exact operational intent',
  resourceRefs: ['integration.symmy.job:10000000-0000-4000-8000-000000000001'],
  right: 'ERASURE',
  sourceDecisionRef: 'internal-current-decision',
  sourceDecisionRevision: 1,
  subjectRef: 'internal-subject',
  taskId: 'internal-task',
  tenantId: '10000000-0000-4000-8000-000000000002',
});

it.effect('binds the complete immutable handoff while normalizing only unordered reference sets', () =>
  Effect.gen(function* verifyBinding() {
    const original = yield* fingerprintSymmyJobPrivacyHandoff(handoff);
    const reordered = yield* fingerprintSymmyJobPrivacyHandoff({
      ...handoff,
      expectedEvidenceRefs: ['evidence-a', 'evidence-b'],
      preconditionRefs: ['precondition-a', 'precondition-b'],
    });
    expect(reordered).toBe(original);
    const changedSubject = yield* fingerprintSymmyJobPrivacyHandoff({ ...handoff, subjectRef: 'other-subject' });
    const changedDecision = yield* fingerprintSymmyJobPrivacyHandoff({ ...handoff, sourceDecisionRevision: 2 });
    expect(changedSubject).not.toBe(original);
    expect(changedDecision).not.toBe(original);
  }),
);

it.effect('preserves SHA-256 bytes and maps a native rejection to typed unavailability', () =>
  Effect.gen(function* digestOutage() {
    expect(yield* symmyJobPrivacyDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const error = yield* fingerprintSymmyJobPrivacyHandoff(handoff).pipe(
      Effect.provide(
        WebCrypto.layer(webCryptoDigestFixture(() => Promise.reject(new Error('private digest failure')))),
      ),
      Effect.flip,
    );
    expect(error.code).toBe('privacy_execution_unavailable');
    expect(Object.hasOwn(error, 'cause')).toBe(false);
  }),
);
