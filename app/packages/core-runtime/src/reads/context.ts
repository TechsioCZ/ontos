import { Effect, Predicate, Schema } from 'effect';

import type { ListAccessPredicate } from '../access/decision/list-access.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ResourceIdentitySchema } from '../resources/scoped-resource-id.ts';
import type { ReadEvidenceCaptureMode } from './definition.ts';
import { ReadEvidenceValidationError } from './errors.ts';
import type { ReadHandlerUnavailable, ReadPermissionDenied, ReadPermissionUnavailable } from './errors.ts';

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
  /** Exact owner-visible record returned by a one-result read; evidence only, never authorization. */
  readonly targetResource?: {
    readonly resourceId: string;
    readonly resourceType: string;
  };
}

/**
 * What every owner step of a Read knows: the Read, its Core-verified scope, the verified composition,
 * and the access gate's own answer for this caller's rows and fields.
 */
export interface ReadPrepareContext {
  /** The Core-admitted composition revision, which remote owner calls must carry. */
  readonly compositionRevision?: string | undefined;
  /**
   * The declared result paths this caller's field grants deny (O17, O25). It is present exactly when
   * the access gate decided this read, and it is empty when every declared field group is granted, so
   * an owner can tell a granted answer from a missing one. A row-scoped read applies it to what its
   * own query matches, orders and reports as well as to the result it returns: a denied surface takes
   * no part in selecting a candidate, and its rows are still projected out of the payload.
   */
  readonly deniedFieldPaths?: readonly (readonly string[])[];
  /**
   * The owner's row filter for a list, search or report read (D16, O25). It is present exactly when
   * this read is row-scoped and answered by the access gate: the owner applies it inside its own
   * query, so a row the caller may not read never reaches the result. Its absence means the read is
   * not row-scoped (a detail read) or is not decided by v2 yet. An empty `groups` list means every row
   * of the scope is visible; the gate never answers an allowed list without a predicate.
   */
  readonly listAccess?: ListAccessPredicate;
  readonly readKey: string;
  readonly scope: OperationalScope;
}

/**
 * A short owner transaction after commit: admitted by the same composition revision, with the same operational
 * scope installed, and guarded like the Read's own transaction. It is for evaluations that interleave remote owner
 * calls with owner-state reads: each owner-state read gets its own short transaction, and no remote call ever runs
 * while one is open.
 *
 * Core first decides the owner rule that admitted `load` again in this transaction, so a grant revoked while `finish`
 * waited on a remote call refuses the Read (`ReadPermissionDenied` or `ReadPermissionUnavailable`, and Core refuses
 * the Read even if `finish` handles that failure). The callback then receives the owner's read services, built by
 * the same factory as `load`, never a database executor, and the transaction is READ ONLY in the database from that
 * point, so `finish` can read owner state but cannot write it. Because the callback runs while this transaction is
 * open, the read service factory of a staged Read builds database services only; its remote owner ports are built
 * in `prepare` or `finish`, outside any transaction. A failure of the transaction itself (database, scope,
 * composition fence, service factory) and a lost database connection under the callback are
 * `ReadHandlerUnavailable`; the callback's other failures reach `finish` unchanged.
 */
export type ReadOwnerTransaction<Services> = <Value, Failure, Requirements>(
  use: (services: Services) => Effect.Effect<Value, Failure, Requirements>,
) => Effect.Effect<
  Value,
  Failure | ReadHandlerUnavailable | ReadPermissionDenied | ReadPermissionUnavailable,
  Requirements
>;

/**
 * The owner transaction step: scoped database services and Core's copy of what `prepare` established, decoded
 * through the pipeline's `prepared` data schema before the transaction opened, so `Prepared` is that schema's
 * type. A pipeline without `prepare` has nothing prepared, so its load step may be called without it.
 */
export type ReadLoadContext<Services, Prepared = undefined> = ReadPrepareContext & {
  readonly services: Services;
} & (undefined extends Prepared ? { readonly prepared?: Prepared } : { readonly prepared: Prepared });

/**
 * The step after commit: Core's decoded copy of what `prepare` established (the same one `load` saw) and what
 * `load` read. `Services` is what the owner's read
 * service factory builds; a `finish` that never opens an owner transaction may leave it unnamed.
 */
export interface ReadFinishContext<Prepared, Loaded, Services = unknown> extends ReadPrepareContext {
  readonly loaded: Loaded;
  readonly prepared: Prepared;
  readonly transaction: ReadOwnerTransaction<Services>;
}

/** What a single-handler Read receives: the Read, its Core-verified scope, and the scoped owner services. */
export interface ReadHandlerContext<Services> {
  /** The declared result paths this caller's field grants deny (O17, O25); see {@link ReadPrepareContext}. */
  readonly deniedFieldPaths?: readonly (readonly string[])[];
  /** The owner's row filter for this row-scoped read (D16, O25); see {@link ReadPrepareContext}. */
  readonly listAccess?: ListAccessPredicate;
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
  'targetResource',
]);
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
const ReadEvidenceResourceIdSchema = ResourceIdentitySchema.pipe(Schema.brand('ReadEvidenceResourceId'));
const ReadEvidenceCandidateSchema = Schema.Struct({
  queryHash: Schema.optional(Schema.Unknown),
  resultCount: Schema.Unknown,
  resultFingerprintHash: Schema.optional(Schema.Unknown),
  resultFingerprintSchema: Schema.optional(Schema.Unknown),
  targetResource: Schema.optionalKey(
    Schema.Struct({
      resourceId: ReadEvidenceResourceIdSchema,
      resourceType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
    }),
  ),
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
        targetResource,
      } = record;
      if (
        Object.keys(record).some((key) => !evidenceKeys.has(key)) ||
        !isValidResultCount(resultCount) ||
        (targetResource !== undefined && resultCount !== 1)
      ) {
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
            targetResource === undefined ? {} : { targetResource: Object.freeze(targetResource) },
          ),
        ),
      );
    }),
  );
