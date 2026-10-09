import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import type { PricingCurrencyCodeSchema } from '@app/pricing-contracts/current-supported-currencies';
import {
  PricingCommercialFeeCurrentSetSchema,
  PricingCommercialFeeCurrentResolutionSchema,
  PricingCommercialFeeDefinitionSchema,
  PricingCommercialFeeIdentityKeySchema,
  PricingCommercialFeeRevisionIdSchema,
  PricingCommercialFeeScheduleAcknowledgementSchema,
  PricingCommercialFeeScheduleSnapshotSchema,
} from '@app/pricing-contracts/domain/commercial-fee';
import type {
  ExpectedPricingCommercialFeeCurrent,
  PricingCommercialFeeCatalogTargetEvidence,
  PricingCommercialFeeConfiguredAmount,
  PricingCommercialFeeCurrentResolution,
  PricingCommercialFeeEffectivePeriod,
  PricingCommercialFeeIdentityKey,
  PricingCommercialFeeScheduleAcknowledgement,
  PricingCommercialFeeVariantTarget,
} from '@app/pricing-contracts/domain/commercial-fee';
import type { PricingCommercialScope } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { Effect, Option, Schema } from 'effect';

const ownerModuleKey = 'commerce.pricing';
const schema = 'pricing';
const scopeParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;
const CommercialFeeRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });
const CommercialFeeActionInvocationIdStringSchema = Schema.String.check(Schema.isUUID());
const CommercialFeeActionInvocationIdSchema = CommercialFeeActionInvocationIdStringSchema.pipe(
  Schema.brand('CommercialFeeActionInvocationId'),
  Schema.decodeTo(CommercialFeeActionInvocationIdStringSchema),
);

export const defineCommercialFeeRoutine = defineScopedRoutine({
  name: 'define_commercial_fee_v2',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommercialFeeRoutineRowSchema,
  routineKey: 'pricing.define-commercial-fee-v2',
  schema,
});

export const readCurrentCommercialFeeRoutine = defineScopedRoutine({
  name: 'read_current_commercial_fee_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommercialFeeRoutineRowSchema,
  routineKey: 'pricing.read-current-commercial-fee-v1',
  schema,
});

export const readCurrentCommercialFeeSetRoutine = defineScopedRoutine({
  name: 'read_current_commercial_fee_set_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommercialFeeRoutineRowSchema,
  routineKey: 'pricing.read-current-commercial-fee-set-v1',
  schema,
});

export const verifyCommercialFeeSetGenerationRoutine = defineScopedRoutine({
  name: 'verify_commercial_fee_set_generation_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommercialFeeRoutineRowSchema,
  routineKey: 'pricing.verify-commercial-fee-set-generation-v1',
  schema,
});

export const lookupCommercialFeeActionResultRoutine = defineScopedRoutine({
  name: 'lookup_commercial_fee_action_result_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommercialFeeRoutineRowSchema,
  routineKey: 'pricing.lookup-commercial-fee-action-result-v1',
  schema,
});

export const readCommercialFeeScheduleRoutine = defineScopedRoutine({
  name: 'read_commercial_fee_schedule_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommercialFeeRoutineRowSchema,
  routineKey: 'pricing.read-commercial-fee-schedule-v1',
  schema,
});

export const reviseCommercialFeeRoutine = defineScopedRoutine({
  name: 'revise_commercial_fee_v2',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommercialFeeRoutineRowSchema,
  routineKey: 'pricing.revise-commercial-fee-v2',
  schema,
});

export const manageCommercialFeeRevisionRoutine = defineScopedRoutine({
  name: 'manage_commercial_fee_revision_v2',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: CommercialFeeRoutineRowSchema,
  routineKey: 'pricing.manage-commercial-fee-revision-v2',
  schema,
});

export const CommercialFeeConflictReasonSchema = Schema.Literals([
  'ACKNOWLEDGEMENT_STALE',
  'BOUNDARY_CROSSED',
  'EFFECTIVE_BOUNDARY_STALE',
  'EXPECTED_CURRENT_STALE',
  'EXPECTED_SCHEDULE_STALE',
  'IDENTITY_MISMATCH',
  'OVERLAPPING_SCHEDULE',
  'TARGET_REVISION_NOT_FOUND',
]);
export const DefineCommercialFeePersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    definition: PricingCommercialFeeDefinitionSchema,
    outcome: Schema.Literals(['COMMERCIAL_FEE_CREATED', 'COMMERCIAL_FEE_REUSED']),
  }),
  Schema.Struct({
    identityKey: PricingCommercialFeeIdentityKeySchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_CONFLICT'),
    reason: CommercialFeeConflictReasonSchema,
  }),
]);
export type DefineCommercialFeePersistenceOutcome = typeof DefineCommercialFeePersistenceOutcomeSchema.Type;

export const ReadCommercialFeeSchedulePersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal('COMMERCIAL_FEE_SCHEDULE'),
    schedule: PricingCommercialFeeScheduleSnapshotSchema,
  }),
  Schema.Struct({
    identityKey: PricingCommercialFeeIdentityKeySchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_SCHEDULE_ABSENT'),
  }),
  Schema.Struct({
    candidateRevisionIds: Schema.Array(PricingCommercialFeeDefinitionSchema.fields.revision.fields.revisionId).check(
      Schema.isMinLength(2),
    ),
    identityKey: PricingCommercialFeeIdentityKeySchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_SCHEDULE_CONFLICT'),
  }),
]);
export type ReadCommercialFeeSchedulePersistenceOutcome = typeof ReadCommercialFeeSchedulePersistenceOutcomeSchema.Type;

export const ReviseCommercialFeePersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literals(['COMMERCIAL_FEE_REVISED', 'COMMERCIAL_FEE_UNCHANGED']),
    schedule: PricingCommercialFeeScheduleSnapshotSchema,
  }),
  Schema.Struct({
    acknowledgement: PricingCommercialFeeScheduleAcknowledgementSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED'),
  }),
  Schema.Struct({
    identityKey: PricingCommercialFeeIdentityKeySchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_CONFLICT'),
    reason: CommercialFeeConflictReasonSchema,
  }),
]);
export type ReviseCommercialFeePersistenceOutcome = typeof ReviseCommercialFeePersistenceOutcomeSchema.Type;

export const CommercialFeeActionResultLookupOutcomeSchema = Schema.Union([
  Schema.Struct({
    actionInvocationId: CommercialFeeActionInvocationIdSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_ACTION_RESULT_FOUND'),
    result: Schema.Union([DefineCommercialFeePersistenceOutcomeSchema, ReviseCommercialFeePersistenceOutcomeSchema]),
  }),
  Schema.Struct({
    actionInvocationId: CommercialFeeActionInvocationIdSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_ACTION_RESULT_ABSENT'),
  }),
]);
export type CommercialFeeActionResultLookupOutcome = typeof CommercialFeeActionResultLookupOutcomeSchema.Type;

const stableOwnerReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000), Schema.isTrimmed());

export const CommercialFeeSetAuthoritySchema = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
  observedAt: PricingInstantSchema,
  ownerRevision: stableOwnerReference,
  ownerRootRef: stableOwnerReference,
  predicateRef: stableOwnerReference,
  verificationRef: stableOwnerReference,
}).check(
  Schema.makeFilter(({ nextApplicabilityBoundary, observedAt }) =>
    nextApplicabilityBoundary === undefined || nextApplicabilityBoundary > observedAt
      ? undefined
      : 'The next Commercial Fee applicability boundary must follow the owner observation',
  ),
);
export type CommercialFeeSetAuthority = typeof CommercialFeeSetAuthoritySchema.Type;

export const ReadCurrentCommercialFeeSetPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    authority: CommercialFeeSetAuthoritySchema,
    factProofs: Schema.Array(
      Schema.Struct({
        factRef: stableOwnerReference,
        factRevisionRef: stableOwnerReference,
        verificationRef: stableOwnerReference,
      }),
    ),
    feeSet: PricingCommercialFeeCurrentSetSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_SET_CURRENT'),
  }),
  Schema.Struct({
    candidateRevisionIds: Schema.Array(PricingCommercialFeeRevisionIdSchema).check(Schema.isMinLength(2)),
    outcome: Schema.Literal('COMMERCIAL_FEE_SET_CONFLICT'),
  }),
  Schema.Struct({
    outcome: Schema.Literal('COMMERCIAL_FEE_SET_MISSING'),
  }),
  Schema.Struct({
    outcome: Schema.Literal('COMMERCIAL_FEE_SET_UNVERIFIABLE'),
    reason: stableOwnerReference,
  }),
]);
export type ReadCurrentCommercialFeeSetPersistenceOutcome =
  typeof ReadCurrentCommercialFeeSetPersistenceOutcomeSchema.Type;

export const VerifyCommercialFeeSetGenerationPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    authority: CommercialFeeSetAuthoritySchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_SET_GENERATION_CURRENT'),
    verifiedThrough: PricingInstantSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('COMMERCIAL_FEE_SET_GENERATION_CHANGED'),
    verifiedThrough: PricingInstantSchema,
  }),
]);
export type VerifyCommercialFeeSetGenerationPersistenceOutcome =
  typeof VerifyCommercialFeeSetGenerationPersistenceOutcomeSchema.Type;

interface TrustedCommercialFeeCommand {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly reason: string;
  readonly requestCorrelationId: string;
  readonly trustedOperationAt: Date;
}

export interface DefineCommercialFeePersistenceCommand extends TrustedCommercialFeeCommand {
  readonly catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidence;
  readonly configuredAmount: PricingCommercialFeeConfiguredAmount;
  readonly effectivePeriod: PricingCommercialFeeEffectivePeriod;
  readonly identityKey: PricingCommercialFeeIdentityKey;
}

export interface ReadCurrentCommercialFeePersistenceQuery {
  readonly effectiveAt: typeof PricingInstantSchema.Type;
  readonly identityKey: PricingCommercialFeeIdentityKey;
}

export interface ReadCurrentCommercialFeeSetPersistenceQuery {
  readonly commercialScope: PricingCommercialScope;
  readonly currencyCode: typeof PricingCurrencyCodeSchema.Type;
  readonly effectiveAt: typeof PricingInstantSchema.Type;
  readonly target: PricingCommercialFeeVariantTarget;
}

export interface VerifyCommercialFeeSetGenerationPersistenceQuery extends ReadCurrentCommercialFeeSetPersistenceQuery {
  readonly authority: CommercialFeeSetAuthority;
  readonly through: typeof PricingInstantSchema.Type;
}

export interface CommercialFeeActionResultLookupQuery {
  readonly actionInvocationId: string;
}

export interface ReadCommercialFeeSchedulePersistenceQuery {
  readonly identityKey: PricingCommercialFeeIdentityKey;
  readonly trustedOperationAt: Date;
}

export type ReviseCommercialFeePersistenceCommand =
  | (TrustedCommercialFeeCommand & {
      readonly acknowledgement?: PricingCommercialFeeScheduleAcknowledgement;
      readonly catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidence;
      readonly configuredAmount: PricingCommercialFeeConfiguredAmount;
      readonly effectiveFrom: typeof PricingInstantSchema.Type;
      readonly expectedCurrent: ExpectedPricingCommercialFeeCurrent;
      readonly identityKey: PricingCommercialFeeIdentityKey;
      readonly intent: 'VALUE_ONLY_CURRENT';
    })
  | (TrustedCommercialFeeCommand & {
      readonly catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidence;
      readonly configuredAmount: PricingCommercialFeeConfiguredAmount;
      readonly effectivePeriod: PricingCommercialFeeEffectivePeriod;
      readonly expectedScheduleRevision: number;
      readonly identityKey: PricingCommercialFeeIdentityKey;
      readonly intent: 'SCHEDULE_REVISION';
    })
  | (TrustedCommercialFeeCommand & {
      readonly catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidence;
      readonly configuredAmount: PricingCommercialFeeConfiguredAmount;
      readonly expectedScheduleRevision: number;
      readonly identityKey: PricingCommercialFeeIdentityKey;
      readonly intent: 'CORRECT_REVISION';
      readonly targetEffectivePeriod: PricingCommercialFeeEffectivePeriod;
      readonly targetRevisionId: string;
    })
  | (TrustedCommercialFeeCommand & {
      readonly acknowledgement?: PricingCommercialFeeScheduleAcknowledgement;
      readonly effectiveTo: typeof PricingInstantSchema.Type;
      readonly expectedCurrent: ExpectedPricingCommercialFeeCurrent;
      readonly identityKey: PricingCommercialFeeIdentityKey;
      readonly intent: 'RETIRE_CURRENT';
    });

export class CommercialFeePersistenceUnavailable extends Schema.TaggedError<CommercialFeePersistenceUnavailable>()(
  'CommercialFeePersistenceUnavailable',
  { reason: Schema.String },
) {}

export interface CommercialFeeActionResultLookupPersistence {
  readonly lookupResult: (
    query: CommercialFeeActionResultLookupQuery,
  ) => Effect.Effect<CommercialFeeActionResultLookupOutcome, CommercialFeePersistenceUnavailable>;
}

export interface CommercialFeePersistence {
  readonly define: (
    command: DefineCommercialFeePersistenceCommand,
  ) => Effect.Effect<DefineCommercialFeePersistenceOutcome, CommercialFeePersistenceUnavailable>;
  readonly readCurrent: (
    query: ReadCurrentCommercialFeePersistenceQuery,
  ) => Effect.Effect<PricingCommercialFeeCurrentResolution, CommercialFeePersistenceUnavailable>;
  readonly readCurrentSet: (
    query: ReadCurrentCommercialFeeSetPersistenceQuery,
  ) => Effect.Effect<ReadCurrentCommercialFeeSetPersistenceOutcome, CommercialFeePersistenceUnavailable>;
  readonly readSchedule: (
    query: ReadCommercialFeeSchedulePersistenceQuery,
  ) => Effect.Effect<ReadCommercialFeeSchedulePersistenceOutcome, CommercialFeePersistenceUnavailable>;
  readonly revise: (
    command: ReviseCommercialFeePersistenceCommand,
  ) => Effect.Effect<ReviseCommercialFeePersistenceOutcome, CommercialFeePersistenceUnavailable>;
  readonly verifySetGeneration: (
    query: VerifyCommercialFeeSetGenerationPersistenceQuery,
  ) => Effect.Effect<VerifyCommercialFeeSetGenerationPersistenceOutcome, CommercialFeePersistenceUnavailable>;
}

const unavailable = (cause: unknown): CommercialFeePersistenceUnavailable => {
  const failure = new CommercialFeePersistenceUnavailable({
    reason: 'Pricing Commercial Fee storage could not be verified',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const decodePayload = <A>(
  payloadSchema: Schema.ConstraintDecoder<A>,
  rows: readonly (typeof CommercialFeeRoutineRowSchema.Type)[],
): Effect.Effect<A, CommercialFeePersistenceUnavailable> => {
  const [row] = rows;
  const decoded =
    rows.length === 1 && row !== undefined ? Schema.decodeUnknownOption(payloadSchema)(row.payload) : Option.none();
  return Effect.fromOption(decoded).pipe(Effect.mapError(unavailable));
};

type ScopedTransaction = Pick<Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0], 'invoke'>;

export const commercialFeePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<CommercialFeePersistence & CommercialFeeActionResultLookupPersistence> =>
  Effect.succeed({
    define: (command) =>
      transaction.invoke(defineCommercialFeeRoutine, [command]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(DefineCommercialFeePersistenceOutcomeSchema, rows)),
      ),
    lookupResult: (query) =>
      transaction
        .invoke(lookupCommercialFeeActionResultRoutine, [
          { actingPrincipalId: scope.principalId, actionInvocationId: query.actionInvocationId },
        ])
        .pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(CommercialFeeActionResultLookupOutcomeSchema, rows)),
          Effect.filterOrFail(
            (outcome) => outcome.actionInvocationId === query.actionInvocationId,
            () => unavailable('Pricing Commercial Fee result lookup did not bind the original Action invocation'),
          ),
        ),
    readCurrent: (query) =>
      transaction.invoke(readCurrentCommercialFeeRoutine, [query]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(PricingCommercialFeeCurrentResolutionSchema, rows)),
      ),
    readCurrentSet: (query) =>
      transaction.invoke(readCurrentCommercialFeeSetRoutine, [query]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(ReadCurrentCommercialFeeSetPersistenceOutcomeSchema, rows)),
      ),
    readSchedule: (query) =>
      transaction.invoke(readCommercialFeeScheduleRoutine, [query]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(ReadCommercialFeeSchedulePersistenceOutcomeSchema, rows)),
      ),
    revise: (command) =>
      transaction
        .invoke(
          command.intent === 'CORRECT_REVISION' || command.intent === 'RETIRE_CURRENT'
            ? manageCommercialFeeRevisionRoutine
            : reviseCommercialFeeRoutine,
          [command],
        )
        .pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(ReviseCommercialFeePersistenceOutcomeSchema, rows)),
        ),
    verifySetGeneration: (query) =>
      transaction.invoke(verifyCommercialFeeSetGenerationRoutine, [query]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(VerifyCommercialFeeSetGenerationPersistenceOutcomeSchema, rows)),
      ),
  });
