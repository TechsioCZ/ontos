import { Effect, Predicate, Schema } from 'effect';

import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import type { ReadEvidenceCaptureMode } from './definition.ts';
import { ReadEvidenceValidationError } from './errors.ts';
import type { ReadHandlerExecutionError, ReadHandlerUnavailable } from './errors.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
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

/** What every owner step of a Read knows: the Read, its Core-verified scope, and the verified composition. */
export interface ReadPrepareContext {
  /** The composition revision the gateway verified, which remote owner calls must carry. */
  readonly compositionRevision?: string | undefined;
  readonly readKey: string;
  readonly scope: OperationalScope;
}

/**
 * A short owner transaction after commit: admitted by the same composition revision, with the same operational
 * scope installed, and guarded like the Read's own transaction. It is for evaluations that interleave remote owner
 * calls with owner-state reads: each owner-state read gets its own short transaction, and no remote call ever runs
 * while one is open.
 */
export type ReadOwnerTransaction = <Value, Failure, Requirements>(
  use: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
) => Effect.Effect<
  Value,
  Failure | OperationContextUnavailable | ReadHandlerExecutionError | ReadHandlerUnavailable,
  Requirements
>;

/**
 * The owner transaction step: scoped database services and whatever `prepare` established. A pipeline without
 * `prepare` has nothing prepared, so its load step may be called without it.
 */
export type ReadLoadContext<Services, Prepared = undefined> = ReadPrepareContext & {
  readonly services: Services;
} & (undefined extends Prepared ? { readonly prepared?: Prepared } : { readonly prepared: Prepared });

/** The step after commit: what `prepare` established and what `load` read. */
export interface ReadFinishContext<Prepared, Loaded> extends ReadPrepareContext {
  readonly loaded: Loaded;
  readonly prepared: Prepared;
  readonly transaction: ReadOwnerTransaction;
}

export interface ReadHandlerResult<Result> {
  readonly evidence: ReadEvidenceMetadata;
  readonly result: Result;
}

const sha256 = /^[\da-f]{64}$/u;
const evidenceKeys = new Set(['queryHash', 'resultCount', 'resultFingerprintHash', 'resultFingerprintSchema']);
const invalidEvidence = (cause?: unknown): ReadEvidenceValidationError => {
  const failure = new ReadEvidenceValidationError({
    code: 'read_evidence_invalid',
    reason: 'The read evidence does not match its declared capture policy',
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
};
const ReadEvidenceCandidateSchema = Schema.Struct({
  queryHash: Schema.optional(Schema.Unknown),
  resultCount: Schema.Unknown,
  resultFingerprintHash: Schema.optional(Schema.Unknown),
  resultFingerprintSchema: Schema.optional(Schema.Unknown),
});

type ReadEvidenceCandidate = typeof ReadEvidenceCandidateSchema.Type;

const isValidResultCount = Schema.is(
  Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_647, minimum: 0 })),
);

const hasInvalidFingerprintHash = (value: ReadEvidenceCandidate['resultFingerprintHash']): boolean =>
  value !== undefined && (!Predicate.isString(value) || !sha256.test(value));

const hasInvalidFingerprintSchema = (value: ReadEvidenceCandidate['resultFingerprintSchema']): boolean =>
  value !== undefined && (!Predicate.isString(value) || value.length === 0 || value.length > 300);

const hasInvalidHashEvidence = (record: ReadEvidenceCandidate): boolean =>
  record.queryHash !== undefined ||
  (record.resultFingerprintHash === undefined) !== (record.resultFingerprintSchema === undefined) ||
  hasInvalidFingerprintHash(record.resultFingerprintHash) ||
  hasInvalidFingerprintSchema(record.resultFingerprintSchema);

export const validateReadEvidenceMetadata = <Value>(
  captureMode: ReadEvidenceCaptureMode,
  value: Value,
): Effect.Effect<Readonly<ReadEvidenceMetadata>, ReadEvidenceValidationError> =>
  Schema.decodeUnknownEffect(ReadEvidenceCandidateSchema, {
    onExcessProperty: 'error',
  })(value).pipe(
    Effect.mapError(invalidEvidence),
    Effect.flatMap((record) => {
      const {
        queryHash,
        resultCount,
        resultFingerprintHash: fingerprintHash,
        resultFingerprintSchema: fingerprintSchema,
      } = record;
      if (Object.keys(record).some((key) => !evidenceKeys.has(key)) || !isValidResultCount(resultCount)) {
        return Effect.fail(invalidEvidence());
      }
      if (
        captureMode === 'metadata_only' &&
        (queryHash !== undefined || fingerprintHash !== undefined || fingerprintSchema !== undefined)
      ) {
        return Effect.fail(invalidEvidence());
      }
      if (captureMode === 'hash_only' && hasInvalidHashEvidence(record)) {
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
