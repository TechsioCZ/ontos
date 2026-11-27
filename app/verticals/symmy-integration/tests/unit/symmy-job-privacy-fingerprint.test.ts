import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Exit, Schema } from 'effect';
import { Digest } from 'effect/crypto';
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
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('digests with unchanged SHA-256 bytes and keeps a broken native digest a defect', () =>
  Effect.gen(function* nativeDigestChannels() {
    expect(yield* symmyJobPrivacyDigest('abc').pipe(Effect.provide(NodeCrypto.layer))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const broken = new Error('Fixture SHA-256 primitive is broken');
    const exit = yield* Effect.exit(
      fingerprintSymmyJobPrivacyHandoff(handoff).pipe(
        Effect.provideService(
          Digest.Digest,
          Digest.Digest.of({ digest: () => Effect.die(broken), digestHex: () => Effect.die(broken) }),
        ),
      ),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(Exit.hasFails(exit)).toBe(false);
  }),
);
