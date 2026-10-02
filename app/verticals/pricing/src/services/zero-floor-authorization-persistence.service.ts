import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import {
  PricingZeroFloorAuthorizationSchema,
  PricingZeroFloorCurrentAuthorizationSetSchema,
} from '@app/pricing-contracts/domain/line-composition';
import type {
  PricingZeroFloorAuthorization,
  PricingZeroFloorAuthorizationQuery,
} from '@app/pricing-contracts/domain/line-composition';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Effect, Option, Schema } from 'effect';

import {
  ManagedZeroFloorAuthorizationRevisionSchema,
  ZeroFloorAuthorizationGovernanceApprovalEvidenceSchema,
  ZeroFloorAuthorizationScheduleAcknowledgementSchema,
  ZeroFloorAuthorizationScheduleSnapshotSchema,
} from '../../shared/actions/manage-zero-floor-authorization.ts';
import type {
  ExpectedZeroFloorAuthorizationCurrent,
  ZeroFloorAuthorizationScheduleAcknowledgement,
} from '../../shared/actions/manage-zero-floor-authorization.ts';

export type {
  ExpectedZeroFloorAuthorizationCurrent,
  ManagedZeroFloorAuthorizationRevision,
  ZeroFloorAuthorizationScheduleAcknowledgement,
  ZeroFloorAuthorizationScheduleSnapshot,
} from '../../shared/actions/manage-zero-floor-authorization.ts';

const ownerModuleKey = 'commerce.pricing';
const schema = 'pricing';
const scopeParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;
const ZeroFloorRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });
const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const positiveRevision = Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }));
const ZeroFloorActionInvocationIdSchema = stableReference.pipe(
  Schema.brand('ZeroFloorActionInvocationId'),
  Schema.decodeTo(Schema.String),
);
const sameAuthorization = Schema.toEquivalence(PricingZeroFloorAuthorizationSchema);

const approvalCoversAuthorization = (
  approved: PricingZeroFloorAuthorization,
  proposed: PricingZeroFloorAuthorization,
): boolean => {
  const approvedEndsAt = approved.effectivePeriod.endsAt;
  const proposedEndsAt = proposed.effectivePeriod.endsAt;
  return (
    proposed.effectivePeriod.startsAt >= approved.effectivePeriod.startsAt &&
    (approvedEndsAt === undefined || (proposedEndsAt !== undefined && proposedEndsAt <= approvedEndsAt)) &&
    sameAuthorization(
      {
        ...approved,
        authorizationRevision: proposed.authorizationRevision,
        effectivePeriod: proposed.effectivePeriod,
      },
      proposed,
    )
  );
};

export const createZeroFloorAuthorizationRoutine = defineScopedRoutine({
  name: 'create_zero_floor_authorization_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: ZeroFloorRoutineRowSchema,
  routineKey: 'pricing.create-zero-floor-authorization-v1',
  schema,
});

export const manageZeroFloorAuthorizationRoutine = defineScopedRoutine({
  name: 'manage_zero_floor_authorization_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: ZeroFloorRoutineRowSchema,
  routineKey: 'pricing.manage-zero-floor-authorization-v1',
  schema,
});

export const readCurrentZeroFloorAuthorizationSetRoutine = defineScopedRoutine({
  name: 'read_current_zero_floor_authorization_set_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: ZeroFloorRoutineRowSchema,
  routineKey: 'pricing.read-current-zero-floor-authorization-set-v1',
  schema,
});

export const readCurrentZeroFloorAuthorizationGovernanceProofRoutine = defineScopedRoutine({
  name: 'read_current_zero_floor_authorization_governance_proof_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: ZeroFloorRoutineRowSchema,
  routineKey: 'pricing.read-current-zero-floor-authorization-governance-proof-v1',
  schema,
});

export const verifyZeroFloorAuthorizationSetGenerationRoutine = defineScopedRoutine({
  name: 'verify_zero_floor_authorization_set_generation_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: ZeroFloorRoutineRowSchema,
  routineKey: 'pricing.verify-zero-floor-authorization-set-generation-v1',
  schema,
});

export const readZeroFloorAuthorizationScheduleRoutine = defineScopedRoutine({
  name: 'read_zero_floor_authorization_schedule_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: ZeroFloorRoutineRowSchema,
  routineKey: 'pricing.read-zero-floor-authorization-schedule-v1',
  schema,
});

export const lookupZeroFloorAuthorizationResultRoutine = defineScopedRoutine({
  name: 'lookup_zero_floor_authorization_result_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: ZeroFloorRoutineRowSchema,
  routineKey: 'pricing.lookup-zero-floor-authorization-result-v1',
  schema,
});

export const ZeroFloorAuthorizationSetAuthoritySchema = Schema.Struct({
  generation: positiveRevision,
  observedAt: PricingInstantSchema,
  ownerRevision: stableReference,
  ownerRootRef: stableReference,
  predicateRef: stableReference,
  verificationRef: stableReference,
});
export type ZeroFloorAuthorizationSetAuthority = typeof ZeroFloorAuthorizationSetAuthoritySchema.Type;

export const ZeroFloorAuthorizationGovernanceProofSchema = Schema.Struct({
  approvalEvidence: ZeroFloorAuthorizationGovernanceApprovalEvidenceSchema,
  authorization: PricingZeroFloorAuthorizationSchema,
  completenessEvidence: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  currentness: Schema.Struct({
    evaluatedAt: PricingInstantSchema,
    observedAt: PricingInstantSchema,
    revalidatedAt: PricingInstantSchema,
    status: Schema.Literal('CURRENT'),
  }),
  exactPredicateRef: stableReference,
  ownerRevision: stableReference,
}).check(
  Schema.makeFilter(
    ({ approvalEvidence, authorization, completenessEvidence, currentness, exactPredicateRef, ownerRevision }) => {
      if (
        !approvalCoversAuthorization(approvalEvidence.authorization, authorization) ||
        completenessEvidence.ownerRevision !== ownerRevision ||
        completenessEvidence.observedAt !== currentness.observedAt ||
        completenessEvidence.scope.kind !== 'EXACT_PREDICATE' ||
        completenessEvidence.scope.predicateRef !== exactPredicateRef
      ) {
        return 'ZERO_FLOOR governance proof must bind the exact predicate, owner Revision, and observation';
      }
      return currentness.evaluatedAt <= currentness.observedAt &&
        currentness.observedAt <= currentness.revalidatedAt &&
        approvalEvidence.approvedAt <= currentness.evaluatedAt &&
        approvalEvidence.validityPeriod.startsAt <= currentness.evaluatedAt &&
        currentness.evaluatedAt < approvalEvidence.validityPeriod.endsAt &&
        (completenessEvidence.nextApplicabilityBoundary === undefined ||
          currentness.evaluatedAt < completenessEvidence.nextApplicabilityBoundary)
        ? undefined
        : 'ZERO_FLOOR governance proof must be Current at the evaluated instant';
    },
  ),
);
export type ZeroFloorAuthorizationGovernanceProof = typeof ZeroFloorAuthorizationGovernanceProofSchema.Type;

export const ReadCurrentZeroFloorAuthorizationGovernanceProofOutcomeSchema = Schema.Struct({
  governanceProof: ZeroFloorAuthorizationGovernanceProofSchema,
  outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_GOVERNANCE_PROOF_CURRENT'),
});
export type ReadCurrentZeroFloorAuthorizationGovernanceProofOutcome =
  typeof ReadCurrentZeroFloorAuthorizationGovernanceProofOutcomeSchema.Type;

export const ZeroFloorAuthorizationConflictReasonSchema = Schema.Literals([
  'ACKNOWLEDGEMENT_STALE',
  'AUTHORIZATION_REF_ALREADY_BOUND',
  'BOUNDARY_CROSSED',
  'EXPECTED_CURRENT_STALE',
  'EXPECTED_GENERATION_STALE',
  'EXPECTED_SCHEDULE_STALE',
  'IDEMPOTENCY_CONFLICT',
  'OVERLAPPING_SCHEDULE',
  'SCOPE_EXPANSION_REQUIRES_SUCCESSOR',
  'TARGET_REVISION_NOT_FOUND',
]);

const ZeroFloorAuthorizationConflictSchema = Schema.Struct({
  authorizationRef: stableReference,
  outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_CONFLICT'),
  reason: ZeroFloorAuthorizationConflictReasonSchema,
});

export const CreateZeroFloorAuthorizationPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literals(['ZERO_FLOOR_AUTHORIZATION_CREATED', 'ZERO_FLOOR_AUTHORIZATION_REUSED']),
    revision: ManagedZeroFloorAuthorizationRevisionSchema,
    setGeneration: positiveRevision,
  }),
  ZeroFloorAuthorizationConflictSchema,
]);
export type CreateZeroFloorAuthorizationPersistenceOutcome =
  typeof CreateZeroFloorAuthorizationPersistenceOutcomeSchema.Type;

export const ManageZeroFloorAuthorizationPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    acknowledgement: ZeroFloorAuthorizationScheduleAcknowledgementSchema,
    outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_ACKNOWLEDGEMENT_REQUIRED'),
  }),
  Schema.Struct({
    approvalEvidence: ZeroFloorAuthorizationGovernanceApprovalEvidenceSchema,
    outcome: Schema.Literals(['ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED', 'ZERO_FLOOR_GOVERNANCE_APPROVAL_REUSED']),
    setGeneration: positiveRevision,
  }),
  Schema.Struct({
    outcome: Schema.Literals([
      'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED',
      'ZERO_FLOOR_AUTHORIZATION_ENDED',
      'ZERO_FLOOR_AUTHORIZATION_CORRECTED',
      'ZERO_FLOOR_AUTHORIZATION_UNCHANGED',
    ]),
    schedule: ZeroFloorAuthorizationScheduleSnapshotSchema,
    setGeneration: positiveRevision,
  }),
  ZeroFloorAuthorizationConflictSchema,
]);
export type ManageZeroFloorAuthorizationPersistenceOutcome =
  typeof ManageZeroFloorAuthorizationPersistenceOutcomeSchema.Type;

export const ReadCurrentZeroFloorAuthorizationSetPersistenceOutcomeSchema = Schema.Struct({
  authority: ZeroFloorAuthorizationSetAuthoritySchema,
  authorizationSet: PricingZeroFloorCurrentAuthorizationSetSchema,
  factProofs: Schema.Array(
    Schema.Struct({
      factRef: stableReference,
      factRevisionRef: stableReference,
      verificationRef: stableReference,
    }),
  ),
  outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_SET_CURRENT'),
});
export type ReadCurrentZeroFloorAuthorizationSetPersistenceOutcome =
  typeof ReadCurrentZeroFloorAuthorizationSetPersistenceOutcomeSchema.Type;

export const VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    generation: positiveRevision,
    outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CURRENT'),
    ownerRevision: stableReference,
    ownerRootRef: stableReference,
    verifiedThrough: PricingInstantSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CHANGED'),
    verifiedThrough: PricingInstantSchema,
  }),
]);
export type VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcome =
  typeof VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcomeSchema.Type;

export const ReadZeroFloorAuthorizationSchedulePersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_SCHEDULE'),
    schedule: ZeroFloorAuthorizationScheduleSnapshotSchema,
  }),
  Schema.Struct({
    authorizationRef: stableReference,
    outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_SCHEDULE_ABSENT'),
  }),
  ZeroFloorAuthorizationConflictSchema,
]);
export type ReadZeroFloorAuthorizationSchedulePersistenceOutcome =
  typeof ReadZeroFloorAuthorizationSchedulePersistenceOutcomeSchema.Type;

export const ZeroFloorAuthorizationResultLookupOutcomeSchema = Schema.Union([
  Schema.Struct({
    actionInvocationId: ZeroFloorActionInvocationIdSchema,
    outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_RESULT_FOUND'),
    result: Schema.Union([
      CreateZeroFloorAuthorizationPersistenceOutcomeSchema,
      ManageZeroFloorAuthorizationPersistenceOutcomeSchema,
    ]),
  }),
  Schema.Struct({
    actionInvocationId: ZeroFloorActionInvocationIdSchema,
    outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_RESULT_ABSENT'),
  }),
]);
export type ZeroFloorAuthorizationResultLookupOutcome = typeof ZeroFloorAuthorizationResultLookupOutcomeSchema.Type;

interface TrustedZeroFloorAuthorizationCommand {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly reason: string;
  readonly requestCorrelationId: string;
  readonly trustedOperationAt: typeof PricingInstantSchema.Type;
}

export interface CreateZeroFloorAuthorizationPersistenceCommand extends TrustedZeroFloorAuthorizationCommand {
  readonly authorization: PricingZeroFloorAuthorization;
  readonly expectedSetGeneration: number;
  readonly governanceProof: ZeroFloorAuthorizationGovernanceProof;
}

export type ManageZeroFloorAuthorizationPersistenceCommand =
  | (TrustedZeroFloorAuthorizationCommand & {
      readonly approvalRevision: string;
      readonly authorization: PricingZeroFloorAuthorization;
      readonly expectedSetGeneration: number;
      readonly intent: 'APPROVE';
      readonly validityPeriod: {
        readonly endsAt: typeof PricingInstantSchema.Type;
        readonly startsAt: typeof PricingInstantSchema.Type;
      };
    })
  | (TrustedZeroFloorAuthorizationCommand & {
      readonly acknowledgement?: ZeroFloorAuthorizationScheduleAcknowledgement;
      readonly authorization: PricingZeroFloorAuthorization;
      readonly expectedCurrent: ExpectedZeroFloorAuthorizationCurrent;
      readonly expectedSetGeneration: number;
      readonly governanceProof: ZeroFloorAuthorizationGovernanceProof;
      readonly intent: 'SUCCESSOR';
    })
  | (TrustedZeroFloorAuthorizationCommand & {
      readonly acknowledgement?: ZeroFloorAuthorizationScheduleAcknowledgement;
      readonly authorization: PricingZeroFloorAuthorization;
      readonly authorizationRef: string;
      readonly effectiveTo: string;
      readonly expectedCurrent: ExpectedZeroFloorAuthorizationCurrent;
      readonly expectedSetGeneration: number;
      readonly intent: 'END_CURRENT';
    })
  | (TrustedZeroFloorAuthorizationCommand & {
      readonly acknowledgement?: ZeroFloorAuthorizationScheduleAcknowledgement;
      readonly authorization: PricingZeroFloorAuthorization;
      readonly expectedScheduleRevision: number;
      readonly expectedSetGeneration: number;
      readonly governanceProof: ZeroFloorAuthorizationGovernanceProof;
      readonly intent: 'CORRECT_REVISION';
      readonly targetRevision: string;
    });

export interface ReadCurrentZeroFloorAuthorizationSetPersistenceQuery {
  readonly query: PricingZeroFloorAuthorizationQuery;
}

export interface ReadCurrentZeroFloorAuthorizationGovernanceProofQuery {
  readonly authorization: PricingZeroFloorAuthorization;
  readonly effectiveAt: typeof PricingInstantSchema.Type;
}

export interface VerifyZeroFloorAuthorizationSetGenerationPersistenceQuery {
  readonly generation: number;
  readonly observedAt: typeof PricingInstantSchema.Type;
  readonly ownerRevision: string;
  readonly ownerRootRef: string;
  readonly query: PricingZeroFloorAuthorizationQuery;
  readonly through: string;
}

export interface ReadZeroFloorAuthorizationSchedulePersistenceQuery {
  readonly authorizationRef: string;
  readonly tenantId: string;
  readonly trustedOperationAt: typeof PricingInstantSchema.Type;
}

export interface ZeroFloorAuthorizationResultLookupQuery {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
}

export class ZeroFloorAuthorizationPersistenceUnavailable extends Schema.TaggedError<ZeroFloorAuthorizationPersistenceUnavailable>()(
  'ZeroFloorAuthorizationPersistenceUnavailable',
  { reason: Schema.String },
) {}

export interface ZeroFloorAuthorizationPersistence {
  readonly create: (
    command: CreateZeroFloorAuthorizationPersistenceCommand,
  ) => Effect.Effect<CreateZeroFloorAuthorizationPersistenceOutcome, ZeroFloorAuthorizationPersistenceUnavailable>;
  readonly lookupResult: (
    query: ZeroFloorAuthorizationResultLookupQuery,
  ) => Effect.Effect<ZeroFloorAuthorizationResultLookupOutcome, ZeroFloorAuthorizationPersistenceUnavailable>;
  readonly manage: (
    command: ManageZeroFloorAuthorizationPersistenceCommand,
  ) => Effect.Effect<ManageZeroFloorAuthorizationPersistenceOutcome, ZeroFloorAuthorizationPersistenceUnavailable>;
  readonly readCurrentSet: (
    query: ReadCurrentZeroFloorAuthorizationSetPersistenceQuery,
  ) => Effect.Effect<
    ReadCurrentZeroFloorAuthorizationSetPersistenceOutcome,
    ZeroFloorAuthorizationPersistenceUnavailable
  >;
  readonly readGovernanceProof: (
    query: ReadCurrentZeroFloorAuthorizationGovernanceProofQuery,
  ) => Effect.Effect<
    ReadCurrentZeroFloorAuthorizationGovernanceProofOutcome,
    ZeroFloorAuthorizationPersistenceUnavailable
  >;
  readonly readSchedule: (
    query: ReadZeroFloorAuthorizationSchedulePersistenceQuery,
  ) => Effect.Effect<
    ReadZeroFloorAuthorizationSchedulePersistenceOutcome,
    ZeroFloorAuthorizationPersistenceUnavailable
  >;
  readonly verifyGeneration: (
    query: VerifyZeroFloorAuthorizationSetGenerationPersistenceQuery,
  ) => Effect.Effect<
    VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcome,
    ZeroFloorAuthorizationPersistenceUnavailable
  >;
}

const unavailable = (cause: unknown): ZeroFloorAuthorizationPersistenceUnavailable => {
  const failure = new ZeroFloorAuthorizationPersistenceUnavailable({
    reason: 'Pricing ZERO_FLOOR Authorization storage could not be verified',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const decodePayload = <A>(
  payloadSchema: Schema.ConstraintDecoder<A>,
  rows: readonly (typeof ZeroFloorRoutineRowSchema.Type)[],
): Effect.Effect<A, ZeroFloorAuthorizationPersistenceUnavailable> => {
  const [row] = rows;
  const decoded =
    rows.length === 1 && row !== undefined ? Schema.decodeUnknownOption(payloadSchema)(row.payload) : Option.none();
  return Effect.fromOption(decoded, () =>
    unavailable('ZERO_FLOOR governance routine returned an invalid or ambiguous outcome'),
  );
};

type ScopedTransaction = Pick<Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0], 'invoke'>;

export const zeroFloorAuthorizationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<ZeroFloorAuthorizationPersistence> =>
  Effect.succeed({
    create: (command) =>
      transaction.invoke(createZeroFloorAuthorizationRoutine, [command]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(CreateZeroFloorAuthorizationPersistenceOutcomeSchema, rows)),
      ),
    lookupResult: ({ actionInvocationId }) =>
      transaction
        .invoke(lookupZeroFloorAuthorizationResultRoutine, [
          { actingPrincipalId: scope.principalId, actionInvocationId },
        ])
        .pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(ZeroFloorAuthorizationResultLookupOutcomeSchema, rows)),
        ),
    manage: (command) =>
      transaction.invoke(manageZeroFloorAuthorizationRoutine, [command]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(ManageZeroFloorAuthorizationPersistenceOutcomeSchema, rows)),
      ),
    readCurrentSet: (query) =>
      transaction.invoke(readCurrentZeroFloorAuthorizationSetRoutine, [query]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(ReadCurrentZeroFloorAuthorizationSetPersistenceOutcomeSchema, rows)),
      ),
    readGovernanceProof: (query) =>
      transaction.invoke(readCurrentZeroFloorAuthorizationGovernanceProofRoutine, [query]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(ReadCurrentZeroFloorAuthorizationGovernanceProofOutcomeSchema, rows)),
      ),
    readSchedule: (query) =>
      transaction.invoke(readZeroFloorAuthorizationScheduleRoutine, [query]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) => decodePayload(ReadZeroFloorAuthorizationSchedulePersistenceOutcomeSchema, rows)),
      ),
    verifyGeneration: (query) =>
      transaction.invoke(verifyZeroFloorAuthorizationSetGenerationRoutine, [query]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap((rows) =>
          decodePayload(VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcomeSchema, rows),
        ),
      ),
  });
