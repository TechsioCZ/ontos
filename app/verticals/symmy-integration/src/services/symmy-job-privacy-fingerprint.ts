import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { Crypto, Effect, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { SymmyJobPrivacyExecutionError } from './symmy-job-privacy-execution-error.ts';

export const symmyJobPrivacyDigest = Effect.fn('SymmyJobPrivacy.digest')(function* digest(value: string) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(
    yield* crypto
      .digest('SHA-256', new TextEncoder().encode(value))
      .pipe(
        Effect.catchTag('PlatformError', () =>
          Effect.fail(new SymmyJobPrivacyExecutionError({ code: 'privacy_execution_unavailable' })),
        ),
      ),
  );
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
