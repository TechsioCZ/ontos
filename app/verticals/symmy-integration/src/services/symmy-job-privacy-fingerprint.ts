import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { Effect, Schema } from 'effect';
import { Digest } from 'effect/crypto';
import { Hex } from 'effect/encoding';
import { SymmyJobPrivacyExecutionError } from './symmy-job-privacy-execution-error.ts';

export const symmyJobPrivacyDigest = Effect.fn('SymmyJobPrivacy.digest')(function* digest(value: string) {
  const messageDigest = yield* Digest.Digest;
  return Hex.encode(yield* messageDigest.digest(Digest.sha256, new TextEncoder().encode(value)));
});

/** Same exact public handoff codec and set normalization as the established Privacy owner receipt pattern. */
export const fingerprintSymmyJobPrivacyHandoff = Effect.fn('SymmyJobPrivacy.fingerprint')(function* fingerprint(
  handoff: PrivacyMeasureHandoff,
) {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PrivacyMeasureHandoffSchema))({
    ...handoff,
    contentScopeRefs: handoff.contentScopeRefs.toSorted(),
    expectedEvidenceRefs: handoff.expectedEvidenceRefs.toSorted(),
    preconditionRefs: handoff.preconditionRefs.toSorted(),
    resourceRefs: handoff.resourceRefs.toSorted(),
  }).pipe(
    Effect.catchTag('SchemaError', () =>
      Effect.fail(new SymmyJobPrivacyExecutionError({ code: 'privacy_execution_conflict' })),
    ),
  );
  return yield* symmyJobPrivacyDigest(encoded);
});
