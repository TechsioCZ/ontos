// oxlint-disable sonarjs/function-name -- Effect Match.tags keys are governed SQL outcomes; remove-when: sonarjs accepts discriminant-map properties.
import type {
  OperationContextUnavailable,
  OperationalScope,
  ReadServiceFactory,
  ScopedRoutineInvocationError,
} from '@app/core-runtime';
import { Effect, Match, Option, Schema } from 'effect';

import { PriceGroupContainmentProjectionReconciliationSchema } from '../../shared/actions/create-price-group.ts';
import type { CreatePriceGroupResult } from '../../shared/actions/create-price-group.ts';
import {
  CatalogRevisionSchema,
  PriceGroupCompatibilityDecisionSchema,
  PriceGroupDefinitionRevisionIdSchema,
  PriceGroupDefinitionRevisionSchema,
  PriceGroupIdentitySchema,
  PriceGroupIdSchema,
  PriceGroupInstantSchema,
  PriceGroupMeaningFingerprintSchema,
  PriceGroupRetirementAcceptanceSchema,
  StablePriceGroupRefSchema,
} from '../../shared/domain/price-group.ts';
import type {
  ExpectedPriceGroupCurrentEvidence,
  PriceGroupCompatibilityContract,
  PriceGroupCompatibilityDecision,
  PriceGroupDefinitionRevision,
  PriceGroupIdentity,
  PriceGroupRetirementAcceptance,
  StablePriceGroupRef,
} from '../../shared/domain/price-group.ts';
import {
  PriceGroupCodeConflict,
  PriceGroupCurrentnessFailure,
  PriceGroupEffectivePeriodConflict,
  PriceGroupExpectedCurrentConflict,
  PriceGroupIdempotencyReuseConflict,
  PriceGroupLifecycleConflict,
  PriceGroupMeaningChangeRequired,
  PriceGroupNotFound,
  PriceGroupPersistenceUnavailable,
  PriceGroupRetirementEffectiveTimeConflict,
  PriceGroupSemanticIdentityConflict,
  PriceGroupTenantScopeFailure,
} from '../../shared/domain/price-group-errors.ts';
import type { PriceGroupOwnerFailure } from '../../shared/domain/price-group-errors.ts';
import type { PriceGroupRoutineRow } from './scoped-routine.ts';
import {
  createDefinitionRevisionRoutine,
  createPriceGroupRoutine,
  readCurrentDefinitionRoutine,
  readDefinitionRevisionRoutine,
  retirePriceGroupRoutine,
  validateCompatibilityRoutine,
} from './scoped-routine.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type RoutineTransaction = Pick<ScopedTransaction, 'invoke'>;

interface PriceGroupDefinitionSnapshot {
  readonly definition: PriceGroupDefinitionRevision;
  readonly identity: PriceGroupIdentity;
}

export interface PriceGroupCurrentDefinitionSnapshot extends PriceGroupDefinitionSnapshot {
  readonly catalogRevision: typeof CatalogRevisionSchema.Type;
}

const CurrentnessReasonSchema = Schema.Literals([
  'ZERO_CURRENT_DEFINITIONS',
  'MULTIPLE_CURRENT_DEFINITIONS',
  'UNVERIFIABLE_CURRENTNESS',
]);

const DefinitionMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('accepted', { definition: PriceGroupDefinitionRevisionSchema }),
  Schema.TaggedStruct('replayed', { definition: PriceGroupDefinitionRevisionSchema }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('business_code_conflict', { conflictingCode: Schema.String }),
  Schema.TaggedStruct('catalog_conflict', {}),
  Schema.TaggedStruct('idempotency_conflict', {}),
  Schema.TaggedStruct('lifecycle_conflict', {}),
  Schema.TaggedStruct('material_meaning_change', {}),
  Schema.TaggedStruct('effective_period_conflict', {
    effectiveFrom: PriceGroupInstantSchema,
    reason: Schema.optional(Schema.String),
    trustedEffectiveAt: PriceGroupInstantSchema,
  }),
  Schema.TaggedStruct('semantic_identity_conflict', {
    existingMeaningFingerprint: PriceGroupMeaningFingerprintSchema,
    existingPriceGroupId: PriceGroupIdSchema,
    requestedMeaningFingerprint: PriceGroupMeaningFingerprintSchema,
  }),
  Schema.TaggedStruct('currentness_failure', {
    candidateDefinitionRevisionIds: Schema.Array(PriceGroupDefinitionRevisionIdSchema),
    reason: CurrentnessReasonSchema,
  }),
  Schema.TaggedStruct('expected_current_conflict', {}),
]);
type DefinitionMutationOutcome = typeof DefinitionMutationOutcomeSchema.Type;

const CreatePriceGroupMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('accepted', {
    definition: PriceGroupDefinitionRevisionSchema,
    projection: PriceGroupContainmentProjectionReconciliationSchema,
  }),
  Schema.TaggedStruct('replayed', {
    definition: PriceGroupDefinitionRevisionSchema,
    projection: PriceGroupContainmentProjectionReconciliationSchema,
  }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('business_code_conflict', { conflictingCode: Schema.String }),
  Schema.TaggedStruct('catalog_conflict', {}),
  Schema.TaggedStruct('idempotency_conflict', {}),
  Schema.TaggedStruct('lifecycle_conflict', {}),
  Schema.TaggedStruct('material_meaning_change', {}),
  Schema.TaggedStruct('effective_period_conflict', {
    effectiveFrom: PriceGroupInstantSchema,
    reason: Schema.optional(Schema.String),
    trustedEffectiveAt: PriceGroupInstantSchema,
  }),
  Schema.TaggedStruct('semantic_identity_conflict', {
    existingMeaningFingerprint: PriceGroupMeaningFingerprintSchema,
    existingPriceGroupId: PriceGroupIdSchema,
    requestedMeaningFingerprint: PriceGroupMeaningFingerprintSchema,
  }),
  Schema.TaggedStruct('currentness_failure', {
    candidateDefinitionRevisionIds: Schema.Array(PriceGroupDefinitionRevisionIdSchema),
    reason: CurrentnessReasonSchema,
  }),
  Schema.TaggedStruct('expected_current_conflict', {}),
]);
type CreatePriceGroupMutationOutcome = typeof CreatePriceGroupMutationOutcomeSchema.Type;
const CreatePriceGroupMutationSuccessSchema = Schema.Union([
  Schema.TaggedStruct('accepted', {
    definition: PriceGroupDefinitionRevisionSchema,
    projection: PriceGroupContainmentProjectionReconciliationSchema,
  }),
  Schema.TaggedStruct('replayed', {
    definition: PriceGroupDefinitionRevisionSchema,
    projection: PriceGroupContainmentProjectionReconciliationSchema,
  }),
]);

const RetirementMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('accepted', { retirement: PriceGroupRetirementAcceptanceSchema }),
  Schema.TaggedStruct('replayed', { retirement: PriceGroupRetirementAcceptanceSchema }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('catalog_conflict', {}),
  Schema.TaggedStruct('idempotency_conflict', {}),
  Schema.TaggedStruct('lifecycle_conflict', {}),
  Schema.TaggedStruct('retirement_effective_time_conflict', {
    effectiveAt: PriceGroupInstantSchema,
    trustedEffectiveAt: PriceGroupInstantSchema,
  }),
  Schema.TaggedStruct('currentness_failure', {
    candidateDefinitionRevisionIds: Schema.Array(PriceGroupDefinitionRevisionIdSchema),
    reason: CurrentnessReasonSchema,
  }),
]);
type RetirementMutationOutcome = typeof RetirementMutationOutcomeSchema.Type;

const CurrentDefinitionOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('current', {
    catalogRevision: CatalogRevisionSchema,
    definition: PriceGroupDefinitionRevisionSchema,
    identity: PriceGroupIdentitySchema,
  }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('currentness_failure', {
    candidateDefinitionRevisionIds: Schema.Array(PriceGroupDefinitionRevisionIdSchema),
    reason: CurrentnessReasonSchema,
  }),
]);

const DefinitionRevisionOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('found', {
    definition: PriceGroupDefinitionRevisionSchema,
    identity: PriceGroupIdentitySchema,
  }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('currentness_failure', {
    candidateDefinitionRevisionIds: Schema.Array(PriceGroupDefinitionRevisionIdSchema),
    reason: CurrentnessReasonSchema,
  }),
]);

const CompatibilityOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('decision', { decision: PriceGroupCompatibilityDecisionSchema }),
  Schema.TaggedStruct('expected_current_conflict', {}),
  Schema.TaggedStruct('currentness_failure', {
    candidateDefinitionRevisionIds: Schema.Array(PriceGroupDefinitionRevisionIdSchema),
    reason: CurrentnessReasonSchema,
  }),
]);

export interface CreatePriceGroupInput {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly businessCode: string;
  readonly classificationPurpose: string;
  readonly compatibilityContracts: readonly PriceGroupCompatibilityContract[];
  readonly definitionRevisionId?: string;
  readonly description: string;
  readonly displayName: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly expectedCatalogRevision: number;
  readonly meaningFingerprint: string;
  readonly priceGroupId?: string;
  readonly reason: string;
  readonly trustedEffectiveAt: Date;
}

interface CreatePriceGroupDefinitionRevisionInput {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly classificationPurpose: string;
  readonly compatibilityContracts: readonly PriceGroupCompatibilityContract[];
  readonly definitionRevisionId?: string;
  readonly description: string;
  readonly displayName: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly expectedCurrent: ExpectedPriceGroupCurrentEvidence;
  readonly meaningFingerprint: string;
  readonly reason: string;
  readonly trustedEffectiveAt: Date;
}

export interface RetirePriceGroupInput {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly effectiveAt: Date;
  readonly expectedCurrent: ExpectedPriceGroupCurrentEvidence;
  readonly reason: string;
  readonly trustedEffectiveAt: Date;
}

type PriceGroupPersistenceFailure = PriceGroupOwnerFailure;

export interface PriceGroupCatalogPersistence {
  readonly createDefinitionRevision: (
    input: CreatePriceGroupDefinitionRevisionInput,
  ) => Effect.Effect<PriceGroupDefinitionRevision, PriceGroupPersistenceFailure>;
  readonly createPriceGroup: (
    input: CreatePriceGroupInput,
  ) => Effect.Effect<CreatePriceGroupResult, PriceGroupPersistenceFailure>;
  readonly readCurrentDefinition: (
    priceGroupRef: StablePriceGroupRef,
    at: Date,
  ) => Effect.Effect<PriceGroupCurrentDefinitionSnapshot, PriceGroupPersistenceFailure>;
  readonly readDefinitionRevision: (
    priceGroupRef: StablePriceGroupRef,
    definitionRevisionId: string,
    at: Date,
  ) => Effect.Effect<PriceGroupDefinitionSnapshot, PriceGroupPersistenceFailure>;
  readonly retirePriceGroup: (
    input: RetirePriceGroupInput,
  ) => Effect.Effect<PriceGroupRetirementAcceptance, PriceGroupPersistenceFailure>;
  readonly validateCompatibility: (
    priceGroupRef: StablePriceGroupRef,
    requiredContract: PriceGroupCompatibilityContract,
    trustedOperationAt: Date,
    expectedCurrent: ExpectedPriceGroupCurrentEvidence,
  ) => Effect.Effect<PriceGroupCompatibilityDecision, PriceGroupPersistenceFailure>;
}

const unavailable = (cause?: unknown) => {
  const failure = new PriceGroupPersistenceUnavailable({
    code: 'price_group_persistence_unavailable',
    reason: 'Price Group Catalog persistence is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const invocationFailure = (failure: ScopedRoutineInvocationError) => unavailable(failure);

const idempotencyConflict = (actionInvocationId: string) =>
  new PriceGroupIdempotencyReuseConflict({
    actionInvocationId,
    code: 'price_group_idempotency_reuse_conflict',
    reason: 'The Action invocation identity was already used for a different Price Group operation',
  });

const expectedConflict = (priceGroupRef: StablePriceGroupRef) =>
  new PriceGroupExpectedCurrentConflict({
    code: 'price_group_expected_current_conflict',
    priceGroupRef,
    reason: 'Expected Current evidence or catalog revision does not match durable owner state',
  });

const placeholderRef = (tenantId: string, priceGroupId: string): StablePriceGroupRef =>
  StablePriceGroupRefSchema.make({
    moduleId: 'pricing.price-group-catalog',
    resourceId: priceGroupId,
    resourceType: 'pricing.price-group-catalog.price-group',
    tenantId,
  });

const invocationConstraint = (failure: ScopedRoutineInvocationError): string | undefined =>
  Option.getOrUndefined(failure.constraint);

const idempotencyConstraints = new Set([
  'price_group_catalog_ledger_scope_invocation_uk',
  'price_group_catalog_definitions_invocation_uk',
  'price_group_catalog_retirements_invocation_uk',
]);
const expectedCurrentConstraints = new Set([
  'price_group_catalog_ledger_fence_ck',
  'price_group_catalog_ledger_scope_revision_uk',
  'price_group_catalog_definitions_number_uk',
  'price_group_catalog_intervals_effective_start_uk',
  'price_group_catalog_intervals_no_overlap_excl',
  'price_group_catalog_intervals_revision_uk',
]);

const mutationInvocationFailure = (
  failure: ScopedRoutineInvocationError,
  priceGroupRef: StablePriceGroupRef,
  actionInvocationId: string,
  businessCode?: string,
): PriceGroupOwnerFailure => {
  const constraint = invocationConstraint(failure);
  if (constraint !== undefined && idempotencyConstraints.has(constraint)) {
    return idempotencyConflict(actionInvocationId);
  }
  if (constraint === 'price_group_catalog_groups_scope_code_uk' && businessCode !== undefined) {
    return new PriceGroupCodeConflict({
      code: 'price_group_code_conflict',
      conflictingCode: businessCode,
      reason: 'The Price Group business code is already owned in this tenant',
    });
  }
  if (constraint !== undefined && expectedCurrentConstraints.has(constraint)) {
    return expectedConflict(priceGroupRef);
  }
  return unavailable(failure);
};

const decodePayload = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  rows: readonly PriceGroupRoutineRow[],
): Effect.Effect<Value, PriceGroupPersistenceUnavailable> => {
  const [row] = rows;
  return row === undefined || rows.length !== 1
    ? Effect.fail(unavailable())
    : Schema.decodeUnknownEffect(schema)(row.payload).pipe(Effect.mapError(unavailable));
};

const notFound = () =>
  new PriceGroupNotFound({ code: 'price_group_not_found', reason: 'The Price Group does not exist in this tenant' });

const assertTenant = (
  scope: OperationalScope,
  priceGroupRef: StablePriceGroupRef,
): Effect.Effect<void, PriceGroupTenantScopeFailure> =>
  priceGroupRef.tenantId === scope.tenantId
    ? Effect.void
    : Effect.fail(
        new PriceGroupTenantScopeFailure({
          code: 'price_group_tenant_scope_failure',
          expectedTenantId: scope.tenantId,
          reason: 'The Price Group reference belongs to a different tenant',
          receivedTenantId: priceGroupRef.tenantId,
        }),
      );

const mapDefinitionOutcome = (
  outcome: DefinitionMutationOutcome,
  priceGroupRef: StablePriceGroupRef,
  actionInvocationId: string,
): Effect.Effect<PriceGroupDefinitionRevision, PriceGroupOwnerFailure> =>
  Match.value(outcome).pipe(
    Match.tags({
      accepted: ({ definition }) => Effect.succeed(definition),
      business_code_conflict: ({ conflictingCode }) =>
        Effect.fail(
          new PriceGroupCodeConflict({
            code: 'price_group_code_conflict',
            conflictingCode,
            reason: 'The Price Group business code is already owned in this tenant',
          }),
        ),
      catalog_conflict: () => Effect.fail(expectedConflict(priceGroupRef)),
      currentness_failure: ({ candidateDefinitionRevisionIds, reason }) =>
        Effect.fail(
          new PriceGroupCurrentnessFailure({
            candidateDefinitionRevisionIds,
            code: 'price_group_currentness_failure',
            priceGroupRef,
            reason,
          }),
        ),
      effective_period_conflict: ({ effectiveFrom, reason, trustedEffectiveAt }) =>
        Effect.fail(
          new PriceGroupEffectivePeriodConflict({
            code: 'price_group_effective_period_conflict',
            effectiveFrom,
            priceGroupRef,
            reason: reason ?? 'A new Price Group definition cannot become effective before its trusted operation time',
            trustedEffectiveAt,
          }),
        ),
      expected_current_conflict: () => Effect.fail(expectedConflict(priceGroupRef)),
      idempotency_conflict: () => Effect.fail(idempotencyConflict(actionInvocationId)),
      lifecycle_conflict: () =>
        Effect.fail(
          new PriceGroupLifecycleConflict({
            code: 'price_group_lifecycle_conflict',
            priceGroupRef,
            reason: 'A retired Price Group is terminal',
          }),
        ),
      material_meaning_change: () =>
        Effect.fail(
          new PriceGroupMeaningChangeRequired({
            code: 'price_group_meaning_change_requires_new_identity',
            priceGroupRef,
            reason: 'A material classification meaning change requires a new Price Group identity',
          }),
        ),
      not_found: () => Effect.fail(notFound()),
      replayed: ({ definition }) => Effect.succeed(definition),
      semantic_identity_conflict: ({ existingMeaningFingerprint, existingPriceGroupId, requestedMeaningFingerprint }) =>
        Effect.fail(
          new PriceGroupSemanticIdentityConflict({
            code: 'price_group_semantic_identity_conflict',
            existingMeaningFingerprint,
            priceGroupRef: placeholderRef(priceGroupRef.tenantId, existingPriceGroupId),
            reason: 'The requested stable classification meaning already belongs to another Price Group identity',
            requestedMeaningFingerprint,
          }),
        ),
    }),
    Match.exhaustive,
  );

const mapCreatePriceGroupOutcome = (
  outcome: CreatePriceGroupMutationOutcome,
  priceGroupRef: StablePriceGroupRef,
  actionInvocationId: string,
): Effect.Effect<CreatePriceGroupResult, PriceGroupOwnerFailure> => {
  if (Schema.is(CreatePriceGroupMutationSuccessSchema)(outcome)) {
    return Effect.succeed({
      definition: outcome.definition,
      outcome: 'RECONCILIATION_REQUIRED',
      reconciliation: outcome.projection,
    });
  }
  return mapDefinitionOutcome(outcome, priceGroupRef, actionInvocationId).pipe(
    Effect.flatMap(() => Effect.die('A failed Price Group mutation unexpectedly produced a definition')),
  );
};

const mapRetirementOutcome = (
  outcome: RetirementMutationOutcome,
  priceGroupRef: StablePriceGroupRef,
  actionInvocationId: string,
): Effect.Effect<PriceGroupRetirementAcceptance, PriceGroupOwnerFailure> =>
  Match.value(outcome).pipe(
    Match.tags({
      accepted: ({ retirement }) => Effect.succeed(retirement),
      catalog_conflict: () => Effect.fail(expectedConflict(priceGroupRef)),
      currentness_failure: ({ candidateDefinitionRevisionIds, reason }) =>
        Effect.fail(
          new PriceGroupCurrentnessFailure({
            candidateDefinitionRevisionIds,
            code: 'price_group_currentness_failure',
            priceGroupRef,
            reason,
          }),
        ),
      idempotency_conflict: () => Effect.fail(idempotencyConflict(actionInvocationId)),
      lifecycle_conflict: () =>
        Effect.fail(
          new PriceGroupLifecycleConflict({
            code: 'price_group_lifecycle_conflict',
            priceGroupRef,
            reason: 'A retired Price Group is terminal',
          }),
        ),
      not_found: () => Effect.fail(notFound()),
      replayed: ({ retirement }) => Effect.succeed(retirement),
      retirement_effective_time_conflict: ({ effectiveAt, trustedEffectiveAt }) =>
        Effect.fail(
          new PriceGroupRetirementEffectiveTimeConflict({
            code: 'price_group_retirement_effective_time_conflict',
            effectiveAt,
            priceGroupRef,
            reason: 'A Price Group retirement cannot become effective before its trusted operation time',
            trustedEffectiveAt,
          }),
        ),
    }),
    Match.exhaustive,
  );

export const priceGroupCatalogPersistenceFromRoutineInvoker = (
  transaction: RoutineTransaction,
  scope: OperationalScope,
): PriceGroupCatalogPersistence => {
  const createPriceGroup: PriceGroupCatalogPersistence['createPriceGroup'] = Effect.fn(
    'PriceGroupCatalogPersistence.createPriceGroup',
  )(function* create(input) {
    const rows = yield* transaction
      .invoke(createPriceGroupRoutine, [
        {
          ...input,
          definitionRevisionId: input.definitionRevisionId ?? null,
          effectiveFrom: input.effectiveFrom.toISOString(),
          effectiveTo: input.effectiveTo?.toISOString() ?? null,
          priceGroupId: input.priceGroupId ?? null,
          trustedEffectiveAt: input.trustedEffectiveAt.toISOString(),
        },
      ])
      .pipe(
        Effect.mapError((failure) =>
          mutationInvocationFailure(
            failure,
            placeholderRef(scope.tenantId, input.priceGroupId ?? '00000000-0000-4000-8000-000000000000'),
            input.actionInvocationId,
            input.businessCode,
          ),
        ),
      );
    const outcome = yield* decodePayload(CreatePriceGroupMutationOutcomeSchema, rows);
    return yield* mapCreatePriceGroupOutcome(
      outcome,
      placeholderRef(scope.tenantId, input.priceGroupId ?? '00000000-0000-4000-8000-000000000000'),
      input.actionInvocationId,
    );
  });

  const createDefinitionRevision: PriceGroupCatalogPersistence['createDefinitionRevision'] = Effect.fn(
    'PriceGroupCatalogPersistence.createDefinitionRevision',
  )(function* createRevision(input) {
    yield* assertTenant(scope, input.expectedCurrent.priceGroupRef);
    const rows = yield* transaction
      .invoke(createDefinitionRevisionRoutine, [
        {
          ...input,
          definitionRevisionId: input.definitionRevisionId ?? null,
          effectiveFrom: input.effectiveFrom.toISOString(),
          effectiveTo: input.effectiveTo?.toISOString() ?? null,
          trustedEffectiveAt: input.trustedEffectiveAt.toISOString(),
        },
      ])
      .pipe(
        Effect.mapError((failure) =>
          mutationInvocationFailure(failure, input.expectedCurrent.priceGroupRef, input.actionInvocationId),
        ),
      );
    const outcome = yield* decodePayload(DefinitionMutationOutcomeSchema, rows);
    return yield* mapDefinitionOutcome(outcome, input.expectedCurrent.priceGroupRef, input.actionInvocationId);
  });

  const retirePriceGroup: PriceGroupCatalogPersistence['retirePriceGroup'] = Effect.fn(
    'PriceGroupCatalogPersistence.retirePriceGroup',
  )(function* retire(input) {
    yield* assertTenant(scope, input.expectedCurrent.priceGroupRef);
    const rows = yield* transaction
      .invoke(retirePriceGroupRoutine, [
        {
          ...input,
          effectiveAt: input.effectiveAt.toISOString(),
          trustedEffectiveAt: input.trustedEffectiveAt.toISOString(),
        },
      ])
      .pipe(
        Effect.mapError((failure) =>
          mutationInvocationFailure(failure, input.expectedCurrent.priceGroupRef, input.actionInvocationId),
        ),
      );
    const outcome = yield* decodePayload(RetirementMutationOutcomeSchema, rows);
    return yield* mapRetirementOutcome(outcome, input.expectedCurrent.priceGroupRef, input.actionInvocationId);
  });

  const readCurrentDefinition: PriceGroupCatalogPersistence['readCurrentDefinition'] = Effect.fn(
    'PriceGroupCatalogPersistence.readCurrentDefinition',
  )(function* readCurrent(priceGroupRef, at) {
    yield* assertTenant(scope, priceGroupRef);
    const rows = yield* transaction
      .invoke(readCurrentDefinitionRoutine, [priceGroupRef.resourceId, at])
      .pipe(Effect.mapError(invocationFailure));
    const outcome = yield* decodePayload(CurrentDefinitionOutcomeSchema, rows);
    return yield* Match.value(outcome).pipe(
      Match.tags({
        current: ({ catalogRevision, definition, identity }) =>
          Effect.succeed({ catalogRevision, definition, identity }),
        currentness_failure: ({ candidateDefinitionRevisionIds, reason }) =>
          Effect.fail(
            new PriceGroupCurrentnessFailure({
              candidateDefinitionRevisionIds,
              code: 'price_group_currentness_failure',
              priceGroupRef,
              reason,
            }),
          ),
        not_found: () => Effect.fail(notFound()),
      }),
      Match.exhaustive,
    );
  });

  const readDefinitionRevision: PriceGroupCatalogPersistence['readDefinitionRevision'] = Effect.fn(
    'PriceGroupCatalogPersistence.readDefinitionRevision',
  )(function* readRevision(priceGroupRef, definitionRevisionId, at) {
    yield* assertTenant(scope, priceGroupRef);
    const rows = yield* transaction
      .invoke(readDefinitionRevisionRoutine, [priceGroupRef.resourceId, definitionRevisionId, at])
      .pipe(Effect.mapError(invocationFailure));
    const outcome = yield* decodePayload(DefinitionRevisionOutcomeSchema, rows);
    return yield* Match.value(outcome).pipe(
      Match.tags({
        currentness_failure: ({ candidateDefinitionRevisionIds, reason }) =>
          Effect.fail(
            new PriceGroupCurrentnessFailure({
              candidateDefinitionRevisionIds,
              code: 'price_group_currentness_failure',
              priceGroupRef,
              reason,
            }),
          ),
        found: ({ definition, identity }) => Effect.succeed({ definition, identity }),
        not_found: () => Effect.fail(notFound()),
      }),
      Match.exhaustive,
    );
  });

  const validateCompatibility: PriceGroupCatalogPersistence['validateCompatibility'] = Effect.fn(
    'PriceGroupCatalogPersistence.validateCompatibility',
  )(function* validate(priceGroupRef, requiredContract, trustedOperationAt, expectedCurrent) {
    yield* assertTenant(scope, priceGroupRef);
    yield* assertTenant(scope, expectedCurrent.priceGroupRef);
    const rows = yield* transaction
      .invoke(validateCompatibilityRoutine, [
        priceGroupRef.resourceId,
        requiredContract.contractId,
        String(requiredContract.version),
        trustedOperationAt,
        expectedCurrent,
      ])
      .pipe(Effect.mapError(invocationFailure));
    const outcome = yield* decodePayload(CompatibilityOutcomeSchema, rows);
    return yield* Match.value(outcome).pipe(
      Match.tags({
        currentness_failure: ({ candidateDefinitionRevisionIds, reason }) =>
          Effect.fail(
            new PriceGroupCurrentnessFailure({
              candidateDefinitionRevisionIds,
              code: 'price_group_currentness_failure',
              priceGroupRef,
              reason,
            }),
          ),
        decision: ({ decision }) => Effect.succeed(decision),
        expected_current_conflict: () => Effect.fail(expectedConflict(priceGroupRef)),
      }),
      Match.exhaustive,
    );
  });

  return Object.freeze({
    createDefinitionRevision,
    createPriceGroup,
    readCurrentDefinition,
    readDefinitionRevision,
    retirePriceGroup,
    validateCompatibility,
  });
};

export const priceGroupCatalogPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<PriceGroupCatalogPersistence, OperationContextUnavailable> =>
  Effect.succeed(priceGroupCatalogPersistenceFromRoutineInvoker(transaction, scope));
