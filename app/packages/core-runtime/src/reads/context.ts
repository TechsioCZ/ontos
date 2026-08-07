/* eslint-disable complexity -- Closed evidence validation keeps every fail-closed bound visible. */
import { Effect } from 'effect';
import type { OperationalScope } from '../operations/context.ts';
import type { ReadEvidenceCaptureMode } from './definition.ts';
import { ReadEvidenceValidationError } from './errors.ts';

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

export const validateReadEvidenceMetadata = (
  captureMode: ReadEvidenceCaptureMode,
  value: unknown,
): Effect.Effect<Readonly<ReadEvidenceMetadata>, ReadEvidenceValidationError> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Effect.fail(invalidEvidence());
  }
  const record = value as Readonly<Record<string, unknown>>;
  const {
    queryHash,
    resultCount,
    resultFingerprintHash: fingerprintHash,
    resultFingerprintSchema: fingerprintSchema,
  } = record;
  if (
    Object.keys(record).some((key) => !evidenceKeys.has(key)) ||
    typeof resultCount !== 'number' ||
    !Number.isSafeInteger(resultCount) ||
    resultCount < 0 ||
    resultCount > 2_147_483_647
  ) {
    return Effect.fail(invalidEvidence());
  }
  if (
    captureMode === 'metadata_only' &&
    (queryHash !== undefined || fingerprintHash !== undefined || fingerprintSchema !== undefined)
  ) {
    return Effect.fail(invalidEvidence());
  }
  if (
    captureMode === 'hash_only' &&
    (queryHash !== undefined ||
      (fingerprintHash === undefined) !== (fingerprintSchema === undefined) ||
      (fingerprintHash !== undefined &&
        (typeof fingerprintHash !== 'string' || !sha256.test(fingerprintHash))) ||
      (fingerprintSchema !== undefined &&
        (typeof fingerprintSchema !== 'string' ||
          fingerprintSchema.length === 0 ||
          fingerprintSchema.length > 300)))
  ) {
    return Effect.fail(invalidEvidence());
  }
  return Effect.succeed(
    Object.freeze({
      ...(typeof queryHash === 'string' ? { queryHash } : {}),
      resultCount,
      ...(typeof fingerprintHash === 'string' ? { resultFingerprintHash: fingerprintHash } : {}),
      ...(typeof fingerprintSchema === 'string'
        ? { resultFingerprintSchema: fingerprintSchema }
        : {}),
    }),
  );
};
