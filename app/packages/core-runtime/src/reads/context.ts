import { Effect, Predicate, Schema } from 'effect';
import type { OperationalScope } from '../operations/context.ts';
import type { ReadEvidenceCaptureMode } from './definition.ts';
import { ReadEvidenceValidationError } from './errors.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

export interface ReadEvidenceMetadata {
  readonly queryHash?: string;
  readonly resultCount: number;
  readonly resultFingerprintHash?: string;
  readonly resultFingerprintSchema?: string;
}

export interface ReadHandlerContext<Services> {
  readonly readKey: string;
  readonly scope: OperationalScope;
  readonly services: Services;
}

export interface ReadHandlerResult<Result> {
  readonly evidence: ReadEvidenceMetadata;
  readonly result: Result;
}

const sha256 = /^[\da-f]{64}$/u;
const evidenceKeys = new Set([
  'queryHash',
  'resultCount',
  'resultFingerprintHash',
  'resultFingerprintSchema',
]);
const invalidEvidence = () =>
  new ReadEvidenceValidationError({
    code: 'read_evidence_invalid',
    reason: 'The read evidence does not match its declared capture policy',
  });
const ReadEvidenceCandidateSchema = Schema.Struct({
  queryHash: Schema.optional(Schema.Unknown),
  resultCount: Schema.Unknown,
  resultFingerprintHash: Schema.optional(Schema.Unknown),
  resultFingerprintSchema: Schema.optional(Schema.Unknown),
});

export const validateReadEvidenceMetadata = <Value>(
  captureMode: ReadEvidenceCaptureMode,
  value: Value,
): Effect.Effect<Readonly<ReadEvidenceMetadata>, ReadEvidenceValidationError> =>
  Schema.decodeUnknownEffect(ReadEvidenceCandidateSchema, { onExcessProperty: 'error' })(
    value,
  ).pipe(
    Effect.mapError(invalidEvidence),
    Effect.flatMap((record) => {
      const {
        queryHash,
        resultCount,
        resultFingerprintHash: fingerprintHash,
        resultFingerprintSchema: fingerprintSchema,
      } = record;
      if (
        Object.keys(record).some((key) => !evidenceKeys.has(key)) ||
        !Predicate.isNumber(resultCount) ||
        !Number.isSafeInteger(resultCount) ||
        resultCount < 0 ||
        resultCount > 2_147_483_647
      ) {
        return Effect.fail(invalidEvidence());
      }
      if (
        captureMode === 'metadata_only' &&
        (queryHash !== undefined ||
          fingerprintHash !== undefined ||
          fingerprintSchema !== undefined)
      ) {
        return Effect.fail(invalidEvidence());
      }
      if (
        captureMode === 'hash_only' &&
        (queryHash !== undefined ||
          (fingerprintHash === undefined) !== (fingerprintSchema === undefined) ||
          (fingerprintHash !== undefined &&
            (!Predicate.isString(fingerprintHash) || !sha256.test(fingerprintHash))) ||
          (fingerprintSchema !== undefined &&
            (!Predicate.isString(fingerprintSchema) ||
              fingerprintSchema.length === 0 ||
              fingerprintSchema.length > 300)))
      ) {
        return Effect.fail(invalidEvidence());
      }
      return Effect.succeed(
        Object.freeze(
          withOptionalProperty(
            withOptionalProperty(
              withOptionalProperty({}, Predicate.isString(queryHash), 'queryHash', queryHash, {
                resultCount,
              }),
              Predicate.isString(fingerprintHash),
              'resultFingerprintHash',
              fingerprintHash,
              {},
            ),
            Predicate.isString(fingerprintSchema),
            'resultFingerprintSchema',
            fingerprintSchema,
            {},
          ),
        ),
      );
    }),
  );
