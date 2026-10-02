import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import {
  OwnerProvenCurrentQuantityTierSetSchema,
  QuantityTierIdentityKeySchema,
  QuantityTierScheduleAcknowledgementSchema,
  QuantityTierScheduleReadResultSchema,
  QuantityTierScheduleRevisionSchema,
  QuantityTierScheduleSnapshotSchema,
  QuantityTierSetAuthoritySchema,
  QuantityTierSetFactProofSchema,
  QuantityTierDefinitionSchema,
  ScheduledQuantityTierRevisionSchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import type {
  ExpectedQuantityTierCurrent,
  QuantityTierEffectivePeriod,
  QuantityTierIdentityKey,
  QuantityTierResultingUnitPrice,
  QuantityTierScheduleAcknowledgement,
  QuantityTierScheduleReadResult,
} from '@app/pricing-contracts/domain/quantity-tier';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { Effect, Option, Schema } from 'effect';

import { QuantityTierActionResultLookupOutcomeSchema } from '../../shared/actions/manage-quantity-tier.ts';
import type { QuantityTierActionResultLookupOutcome } from '../../shared/actions/manage-quantity-tier.ts';

const ownerModuleKey = 'commerce.pricing';
const schema = 'pricing';
const scopeParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;
const QuantityTierRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });

export const defineQuantityTierRoutine = defineScopedRoutine({
  name: 'define_quantity_tier_v2',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: QuantityTierRoutineRowSchema,
  routineKey: 'pricing.define-quantity-tier-v2',
  schema,
});

export const readCurrentQuantityTierRoutine = defineScopedRoutine({
  name: 'read_current_quantity_tier_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: QuantityTierRoutineRowSchema,
  routineKey: 'pricing.read-current-quantity-tier-v1',
  schema,
});

export const readCurrentQuantityTierSetRoutine = defineScopedRoutine({
  name: 'read_current_quantity_tier_set_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: QuantityTierRoutineRowSchema,
  routineKey: 'pricing.read-current-quantity-tier-set-v1',
  schema,
});

export const verifyQuantityTierSetGenerationRoutine = defineScopedRoutine({
  name: 'verify_quantity_tier_set_generation_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: QuantityTierRoutineRowSchema,
  routineKey: 'pricing.verify-quantity-tier-set-generation-v1',
  schema,
});

export const resolveQuantityTierSetProofRoutine = defineScopedRoutine({
  name: 'resolve_quantity_tier_set_proof_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: QuantityTierRoutineRowSchema,
  routineKey: 'pricing.resolve-quantity-tier-set-proof-v1',
  schema,
});

export const readQuantityTierScheduleRoutine = defineScopedRoutine({
  name: 'read_quantity_tier_schedule_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: QuantityTierRoutineRowSchema,
  routineKey: 'pricing.read-quantity-tier-schedule-v1',
  schema,
});

export const reviseQuantityTierRoutine = defineScopedRoutine({
  name: 'revise_quantity_tier_v2',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: QuantityTierRoutineRowSchema,
  routineKey: 'pricing.revise-quantity-tier-v2',
  schema,
});

export const lookupQuantityTierActionResultRoutine = defineScopedRoutine({
  name: 'lookup_quantity_tier_action_result_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: QuantityTierRoutineRowSchema,
  routineKey: 'pricing.lookup-quantity-tier-action-result-v1',
  schema,
});

export const QuantityTierConflictReasonSchema = Schema.Literals([
  'ACKNOWLEDGEMENT_STALE',
  'EFFECTIVE_BOUNDARY_STALE',
  'EXPECTED_CURRENT_STALE',
  'EXPECTED_SCHEDULE_STALE',
  'IDENTITY_MISMATCH',
  'OVERLAPPING_SCHEDULE',
  'PRICE_NOT_FOUND',
  'TARGET_REVISION_NOT_FOUND',
  'TARGET_PERIOD_STALE',
]);

export const DefineQuantityTierPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    definition: QuantityTierDefinitionSchema,
    outcome: Schema.Literals(['QUANTITY_TIER_CREATED', 'QUANTITY_TIER_REUSED']),
  }),
  Schema.Struct({
    identityKey: QuantityTierIdentityKeySchema,
    outcome: Schema.Literal('QUANTITY_TIER_CONFLICT'),
    reason: QuantityTierConflictReasonSchema,
  }),
]);
export type DefineQuantityTierPersistenceOutcome = typeof DefineQuantityTierPersistenceOutcomeSchema.Type;

export const ReadCurrentQuantityTierPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    current: ScheduledQuantityTierRevisionSchema,
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('QUANTITY_TIER_CURRENT'),
    scheduleRevision: QuantityTierScheduleRevisionSchema,
  }),
  Schema.Struct({
    identityKey: QuantityTierIdentityKeySchema,
    outcome: Schema.Literal('QUANTITY_TIER_ABSENT'),
  }),
  Schema.Struct({
    candidateRevisionIds: Schema.Array(
      ScheduledQuantityTierRevisionSchema.fields.definition.fields.revision.fields.revisionId,
    ).check(Schema.isMinLength(2)),
    identityKey: QuantityTierIdentityKeySchema,
    outcome: Schema.Literal('QUANTITY_TIER_CONFLICT'),
    reason: QuantityTierConflictReasonSchema,
  }),
]);
export type ReadCurrentQuantityTierPersistenceOutcome = typeof ReadCurrentQuantityTierPersistenceOutcomeSchema.Type;

const stableOwnerReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

export type QuantityTierSetAuthority = typeof QuantityTierSetAuthoritySchema.Type;

const sameQuantityTierSetAuthority = Schema.toEquivalence(QuantityTierSetAuthoritySchema);
const sameQuantityTierSetFacts = Schema.toEquivalence(Schema.Array(QuantityTierSetFactProofSchema));

const CurrentQuantityTierSetPersistenceOutcomeSchema = Schema.Struct({
  authority: QuantityTierSetAuthoritySchema,
  outcome: Schema.Literal('QUANTITY_TIER_SET_CURRENT'),
  tierSet: OwnerProvenCurrentQuantityTierSetSchema,
}).check(
  Schema.makeFilter(({ authority, tierSet }) =>
    sameQuantityTierSetAuthority(authority, tierSet.authority)
      ? undefined
      : 'Quantity Tier Current-set authority must bind the exact returned Tier set',
  ),
);

export const ReadCurrentQuantityTierSetPersistenceOutcomeSchema = Schema.Union([
  CurrentQuantityTierSetPersistenceOutcomeSchema,
  Schema.Struct({
    outcome: Schema.Literal('QUANTITY_TIER_SET_PRICE_ABSENT'),
    priceRef: PriceRefSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('QUANTITY_TIER_SET_AUTHORITY_UNAVAILABLE'),
    priceRef: PriceRefSchema,
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed()),
    retryable: Schema.Literal(true),
  }),
]);
export type ReadCurrentQuantityTierSetPersistenceOutcome =
  typeof ReadCurrentQuantityTierSetPersistenceOutcomeSchema.Type;

export const VerifyQuantityTierSetGenerationPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    generation: Schema.Int.check(Schema.isGreaterThan(0)),
    outcome: Schema.Literal('QUANTITY_TIER_SET_GENERATION_CURRENT'),
    ownerRevision: stableOwnerReference,
    ownerRootRef: stableOwnerReference,
    verificationRef: stableOwnerReference,
    verifiedAt: PricingInstantSchema,
    verifiedThrough: PricingInstantSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('QUANTITY_TIER_SET_GENERATION_CHANGED'),
    verifiedAt: PricingInstantSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('QUANTITY_TIER_SET_GENERATION_UNVERIFIABLE'),
    reason: Schema.Literals(['THROUGH_NOT_YET_OBSERVABLE', 'VERIFICATION_REFERENCE_MISMATCH']),
    verifiedAt: PricingInstantSchema,
  }),
]);
export type VerifyQuantityTierSetGenerationPersistenceOutcome =
  typeof VerifyQuantityTierSetGenerationPersistenceOutcomeSchema.Type;

export const QuantityTierSetProofFactSchema = QuantityTierSetFactProofSchema;

const ResolvedQuantityTierSetProofPersistenceOutcomeSchema = Schema.Struct({
  authority: QuantityTierSetAuthoritySchema,
  currentFacts: Schema.Array(QuantityTierSetProofFactSchema),
  outcome: Schema.Literal('QUANTITY_TIER_SET_PROOF_RESOLVED'),
  tierSet: OwnerProvenCurrentQuantityTierSetSchema,
}).check(
  Schema.makeFilter(({ authority, currentFacts, tierSet }) => {
    if (!sameQuantityTierSetAuthority(authority, tierSet.authority)) {
      return 'Resolved Quantity Tier proof authority must bind the exact returned Tier set';
    }
    return sameQuantityTierSetFacts(currentFacts, tierSet.factProofs)
      ? undefined
      : 'Resolved Quantity Tier proof facts must bind the exact returned Tier set';
  }),
);

export const ResolveQuantityTierSetProofPersistenceOutcomeSchema = Schema.Union([
  ResolvedQuantityTierSetProofPersistenceOutcomeSchema,
  Schema.Struct({
    outcome: Schema.Literal('QUANTITY_TIER_SET_PROOF_ABSENT'),
    priceRef: PriceRefSchema,
    verificationRef: stableOwnerReference,
  }),
]);
export type ResolveQuantityTierSetProofPersistenceOutcome =
  typeof ResolveQuantityTierSetProofPersistenceOutcomeSchema.Type;

export const ReviseQuantityTierPersistenceOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literals(['QUANTITY_TIER_REVISED', 'QUANTITY_TIER_UNCHANGED']),
    schedule: QuantityTierScheduleSnapshotSchema,
  }),
  Schema.Struct({
    acknowledgement: QuantityTierScheduleAcknowledgementSchema,
    outcome: Schema.Literal('QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED'),
  }),
  Schema.Struct({
    identityKey: QuantityTierIdentityKeySchema,
    outcome: Schema.Literal('QUANTITY_TIER_CONFLICT'),
    reason: QuantityTierConflictReasonSchema,
  }),
]);
export type ReviseQuantityTierPersistenceOutcome = typeof ReviseQuantityTierPersistenceOutcomeSchema.Type;

export interface QuantityTierActionResultLookupQuery {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
}

interface TrustedQuantityTierCommand {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly reason: string;
  readonly requestCorrelationId: string;
  readonly trustedOperationAt: Date;
}

export type RetireCurrentQuantityTierScheduleAcknowledgement = Omit<QuantityTierScheduleAcknowledgement, 'intent'> & {
  readonly intent: 'RETIRE_CURRENT';
};

export interface DefineQuantityTierPersistenceCommand extends TrustedQuantityTierCommand {
  readonly effectivePeriod: QuantityTierEffectivePeriod;
  readonly expectedState: { readonly state: 'ABSENT' };
  readonly identityKey: QuantityTierIdentityKey;
  readonly resultingUnitPrice: QuantityTierResultingUnitPrice;
}

export interface ReadCurrentQuantityTierPersistenceQuery {
  readonly effectiveAt: typeof PricingInstantSchema.Type;
  readonly identityKey: QuantityTierIdentityKey;
}

export interface ReadCurrentQuantityTierSetPersistenceQuery {
  readonly effectiveAt: typeof PricingInstantSchema.Type;
  readonly priceRef: typeof PriceRefSchema.Type;
}

export interface VerifyQuantityTierSetGenerationPersistenceQuery {
  readonly effectiveAt: typeof PricingInstantSchema.Type;
  readonly generation: number;
  readonly observedAt: typeof PricingInstantSchema.Type;
  readonly ownerRevision: string;
  readonly ownerRootRef: string;
  readonly priceRef: typeof PriceRefSchema.Type;
  readonly through: typeof PricingInstantSchema.Type;
  readonly verificationRef: string;
}

export interface ResolveQuantityTierSetProofPersistenceQuery {
  readonly effectiveAt: typeof PricingInstantSchema.Type;
  readonly priceRef: typeof PriceRefSchema.Type;
  readonly verificationRef: string;
}

export interface ReadQuantityTierSchedulePersistenceQuery {
  readonly identityKey: QuantityTierIdentityKey;
  readonly trustedOperationAt: Date;
}

export type ReviseQuantityTierPersistenceCommand =
  | (TrustedQuantityTierCommand & {
      readonly acknowledgement?: QuantityTierScheduleAcknowledgement;
      readonly effectiveFrom: typeof PricingInstantSchema.Type;
      readonly expectedCurrent: ExpectedQuantityTierCurrent;
      readonly identityKey: QuantityTierIdentityKey;
      readonly intent: 'VALUE_ONLY_CURRENT';
      readonly resultingUnitPrice: QuantityTierResultingUnitPrice;
    })
  | (TrustedQuantityTierCommand & {
      readonly effectivePeriod: QuantityTierEffectivePeriod;
      readonly expectedScheduleRevision: number;
      readonly identityKey: QuantityTierIdentityKey;
      readonly intent: 'SCHEDULE_REVISION';
      readonly resultingUnitPrice: QuantityTierResultingUnitPrice;
    })
  | (TrustedQuantityTierCommand & {
      readonly acknowledgement?: RetireCurrentQuantityTierScheduleAcknowledgement;
      readonly effectiveTo: typeof PricingInstantSchema.Type;
      readonly expectedCurrent: ExpectedQuantityTierCurrent;
      readonly identityKey: QuantityTierIdentityKey;
      readonly intent: 'RETIRE_CURRENT';
    })
  | (TrustedQuantityTierCommand & {
      readonly expectedScheduleRevision: number;
      readonly identityKey: QuantityTierIdentityKey;
      readonly intent: 'CORRECT_REVISION';
      readonly resultingUnitPrice: QuantityTierResultingUnitPrice;
      readonly targetEffectivePeriod: QuantityTierEffectivePeriod;
      readonly targetRevisionId: string;
    });

export class QuantityTierPersistenceUnavailable extends Schema.TaggedError<QuantityTierPersistenceUnavailable>()(
  'QuantityTierPersistenceUnavailable',
  { reason: Schema.String },
) {}

export interface QuantityTierPersistence {
  readonly define: (
    command: DefineQuantityTierPersistenceCommand,
  ) => Effect.Effect<DefineQuantityTierPersistenceOutcome, QuantityTierPersistenceUnavailable>;
  readonly readCurrent: (
    query: ReadCurrentQuantityTierPersistenceQuery,
  ) => Effect.Effect<ReadCurrentQuantityTierPersistenceOutcome, QuantityTierPersistenceUnavailable>;
  readonly readCurrentSet: (
    query: ReadCurrentQuantityTierSetPersistenceQuery,
  ) => Effect.Effect<ReadCurrentQuantityTierSetPersistenceOutcome, QuantityTierPersistenceUnavailable>;
  readonly readSchedule: (
    query: ReadQuantityTierSchedulePersistenceQuery,
  ) => Effect.Effect<QuantityTierScheduleReadResult, QuantityTierPersistenceUnavailable>;
  readonly revise: (
    command: ReviseQuantityTierPersistenceCommand,
  ) => Effect.Effect<ReviseQuantityTierPersistenceOutcome, QuantityTierPersistenceUnavailable>;
  readonly verifySetGeneration: (
    query: VerifyQuantityTierSetGenerationPersistenceQuery,
  ) => Effect.Effect<VerifyQuantityTierSetGenerationPersistenceOutcome, QuantityTierPersistenceUnavailable>;
}

export interface QuantityTierActionResultLookupPersistence {
  readonly lookupResult: (
    query: QuantityTierActionResultLookupQuery,
  ) => Effect.Effect<QuantityTierActionResultLookupOutcome, QuantityTierPersistenceUnavailable>;
}

export interface QuantityTierSetProofPersistence {
  readonly resolveQuantityTierSetProof: (
    query: ResolveQuantityTierSetProofPersistenceQuery,
  ) => Effect.Effect<ResolveQuantityTierSetProofPersistenceOutcome, QuantityTierPersistenceUnavailable>;
}

const unavailable = (cause: unknown): QuantityTierPersistenceUnavailable => {
  const failure = new QuantityTierPersistenceUnavailable({
    reason: 'Pricing Quantity Tier storage could not be verified',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const samePriceRef = Schema.toEquivalence(PriceRefSchema);

const verifyResolvedQuantityTierSetProof = (
  query: ResolveQuantityTierSetProofPersistenceQuery,
  outcome: ResolveQuantityTierSetProofPersistenceOutcome,
): Effect.Effect<ResolveQuantityTierSetProofPersistenceOutcome, QuantityTierPersistenceUnavailable> => {
  if (outcome.outcome === 'QUANTITY_TIER_SET_PROOF_ABSENT') {
    return outcome.verificationRef === query.verificationRef && samePriceRef(outcome.priceRef, query.priceRef)
      ? Effect.succeed<ResolveQuantityTierSetProofPersistenceOutcome>(outcome)
      : Effect.fail(unavailable('Quantity Tier proof absence did not bind the requested owner proof'));
  }
  return outcome.authority.verificationRef === query.verificationRef &&
    samePriceRef(outcome.tierSet.priceRef, query.priceRef)
    ? Effect.succeed<ResolveQuantityTierSetProofPersistenceOutcome>(outcome)
    : Effect.fail(unavailable('Resolved Quantity Tier proof did not bind the requested owner evidence'));
};

const decodePayload = <A>(
  payloadSchema: Schema.ConstraintDecoder<A>,
  rows: readonly (typeof QuantityTierRoutineRowSchema.Type)[],
): Effect.Effect<A, QuantityTierPersistenceUnavailable> => {
  const [row] = rows;
  const decoded =
    rows.length === 1 && row !== undefined ? Schema.decodeUnknownOption(payloadSchema)(row.payload) : Option.none();
  return Effect.fromOption(decoded).pipe(Effect.mapError((cause) => unavailable(cause)));
};

type ScopedTransaction = Pick<Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0], 'invoke'>;

export const quantityTierPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<
  QuantityTierPersistence & QuantityTierActionResultLookupPersistence & QuantityTierSetProofPersistence
> =>
  Effect.succeed<QuantityTierPersistence & QuantityTierActionResultLookupPersistence & QuantityTierSetProofPersistence>(
    {
      define: (command) =>
        transaction.invoke(defineQuantityTierRoutine, [command]).pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(DefineQuantityTierPersistenceOutcomeSchema, rows)),
        ),
      lookupResult: ({ actionInvocationId }) =>
        transaction
          .invoke(lookupQuantityTierActionResultRoutine, [{ actingPrincipalId: scope.principalId, actionInvocationId }])
          .pipe(
            Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
            Effect.flatMap((rows) => decodePayload(QuantityTierActionResultLookupOutcomeSchema, rows)),
            Effect.filterOrFail(
              (outcome) => outcome.actionInvocationId === actionInvocationId,
              () => unavailable('Pricing Quantity Tier result lookup did not bind the original Action invocation'),
            ),
          ),
      readCurrent: (query) =>
        transaction.invoke(readCurrentQuantityTierRoutine, [query]).pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(ReadCurrentQuantityTierPersistenceOutcomeSchema, rows)),
        ),
      readCurrentSet: (query) =>
        transaction.invoke(readCurrentQuantityTierSetRoutine, [query]).pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(ReadCurrentQuantityTierSetPersistenceOutcomeSchema, rows)),
        ),
      readSchedule: (query) =>
        transaction.invoke(readQuantityTierScheduleRoutine, [query]).pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(QuantityTierScheduleReadResultSchema, rows)),
        ),
      resolveQuantityTierSetProof: (query) =>
        transaction.invoke(resolveQuantityTierSetProofRoutine, [query]).pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(ResolveQuantityTierSetProofPersistenceOutcomeSchema, rows)),
          Effect.flatMap((outcome) => verifyResolvedQuantityTierSetProof(query, outcome)),
        ),
      revise: (command) =>
        transaction.invoke(reviseQuantityTierRoutine, [command]).pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(ReviseQuantityTierPersistenceOutcomeSchema, rows)),
        ),
      verifySetGeneration: (query) =>
        transaction.invoke(verifyQuantityTierSetGenerationRoutine, [query]).pipe(
          Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
          Effect.flatMap((rows) => decodePayload(VerifyQuantityTierSetGenerationPersistenceOutcomeSchema, rows)),
        ),
    },
  );
