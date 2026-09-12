import { defineScopedRoutine } from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { CounterpartyRef } from '../../shared/domain/access-contract.ts';
import { CustomerPriceGroupAssignmentSchema } from '../../shared/domain/price-group-contracts.ts';
import type {
  CommerceCustomerProfileTarget,
  CustomerPriceGroupAssignment,
  PriceGroupInstant,
} from '../../shared/domain/price-group-contracts.ts';
import {
  CustomerPriceGroupPersistenceUnavailable,
  CustomerPriceGroupProfileUnavailable,
} from '../../shared/domain/price-group-errors.ts';
import type {
  AssignCustomerPriceGroupStoreInput,
  AssignCustomerPriceGroupStoreResult,
  CustomerPriceGroupAssignmentLookup,
  CustomerPriceGroupAssignmentStorePort,
  CustomerPriceGroupMigrationConflictItem,
  CustomerPriceGroupProfileValidation,
  CustomerPriceGroupProfileValidationPort,
  MigrateCustomerPriceGroupStoreInput,
  MigrateCustomerPriceGroupStoreResult,
  RemoveCustomerPriceGroupStoreInput,
  RemoveCustomerPriceGroupStoreResult,
} from '../../shared/domain/price-group-ports.ts';

const CUSTOMER_CONTEXT_MODULE_ID = 'commerce.customer-context' as const;

/** The only Core transaction capability this owner adapter may receive. */
export interface PriceGroupRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

/* eslint-disable effect-native/no-nullable-schema-field -- PostgreSQL routine object rows intentionally preserve SQL NULL as a fail-closed transport sentinel. */
const AssignmentLifecycleSchema = Schema.Literals(['ACTIVE', 'CANCELLED', 'ENDED']);

const NullableAssignmentFields = {
  assignment_id: Schema.NullOr(Schema.String),
  catalog_revision: Schema.NullOr(Schema.Int),
  compatibility_contract_id: Schema.NullOr(Schema.String),
  compatibility_contract_revision: Schema.NullOr(Schema.Int),
  definition_revision: Schema.NullOr(Schema.Int),
  effective_from: Schema.NullOr(Schema.Union([Schema.Date, Schema.String])),
  effective_to: Schema.NullOr(Schema.Union([Schema.Date, Schema.String])),
  lifecycle: Schema.NullOr(AssignmentLifecycleSchema),
  price_group_module_id: Schema.NullOr(Schema.String),
  price_group_resource_id: Schema.NullOr(Schema.String),
  price_group_resource_type: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  recorded_at: Schema.NullOr(Schema.Union([Schema.Date, Schema.String])),
  revision: Schema.NullOr(Schema.Int),
} as const;

const ProfileInspectionRowSchema = Schema.Struct({
  counterparty_resource_id: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(['CURRENT', 'NOT_FOUND']),
  profile_state: Schema.NullOr(Schema.Literals(['ACTIVE', 'ARCHIVED', 'RECONCILIATION_REQUIRED', 'SUSPENDED'])),
  revision: Schema.Int,
});
const AssignmentListRowSchema = Schema.Struct({
  ...NullableAssignmentFields,
  outcome: Schema.Literals(['FOUND', 'PROFILE_NOT_FOUND']),
});
type AssignmentListRow = typeof AssignmentListRowSchema.Type;

const AssignmentMutationRowSchema = Schema.Struct({
  ...NullableAssignmentFields,
  changed: Schema.Boolean,
  outcome: Schema.Literals([
    'ASSIGNED',
    'OVERLAP',
    'PROFILE_INELIGIBLE',
    'PROFILE_NOT_FOUND',
    'PROFILE_REVISION_CONFLICT',
    'RETROACTIVE_SCHEDULE',
    'SCOPE_MISMATCH',
    'UNCHANGED',
  ]),
  profile_state: Schema.NullOr(Schema.Literals(['ARCHIVED', 'RECONCILIATION_REQUIRED', 'SUSPENDED'])),
  replaced_assignment_id: Schema.NullOr(Schema.String),
});
const RemovalMutationRowSchema = Schema.Struct({
  ...NullableAssignmentFields,
  changed: Schema.Boolean,
  current_revision: Schema.Int,
  outcome: Schema.Literals([
    'ASSIGNMENT_NOT_FOUND',
    'PROFILE_MISMATCH',
    'PROFILE_NOT_FOUND',
    'REMOVAL_CONFLICT',
    'REMOVED',
    'RETROACTIVE_SCHEDULE',
    'REVISION_CONFLICT',
    'SCOPE_MISMATCH',
  ]),
});
const MigrationMutationRowSchema = Schema.Struct({
  ...NullableAssignmentFields,
  changed: Schema.Boolean,
  conflict_assignment_id: Schema.NullOr(Schema.String),
  conflict_reason: Schema.NullOr(
    Schema.Literals(['ASSIGNMENT_CHANGED', 'ASSIGNMENT_MISSING', 'OVERLAP', 'PROFILE_INELIGIBLE']),
  ),
  outcome: Schema.Literals(['APPLIED', 'CONFLICTS', 'RETROACTIVE_SCHEDULE']),
  profile_id: Schema.NullOr(Schema.String),
  profile_kind: Schema.NullOr(Schema.Literals(['COUNTERPARTY', 'RETAIL'])),
});
/* eslint-enable effect-native/no-nullable-schema-field */

const inspectPriceGroupProfileRoutine = defineScopedRoutine({
  name: 'inspect_price_group_profile',
  ownerModuleKey: CUSTOMER_CONTEXT_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { nullable: true, source: 'input', type: 'text' },
  ],
  resultSchema: ProfileInspectionRowSchema,
  routineKey: 'price-group.profile.inspect',
  schema: 'commerce_customer_context',
});

const readPriceGroupAssignmentsRoutine = defineScopedRoutine({
  name: 'read_price_group_assignments',
  ownerModuleKey: CUSTOMER_CONTEXT_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: AssignmentListRowSchema,
  routineKey: 'price-group.assignments.read',
  schema: 'commerce_customer_context',
});

const resolvePriceGroupAssignmentsRoutine = defineScopedRoutine({
  name: 'resolve_price_group_assignments',
  ownerModuleKey: CUSTOMER_CONTEXT_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
  ],
  resultSchema: AssignmentListRowSchema,
  routineKey: 'price-group.assignments.resolve',
  schema: 'commerce_customer_context',
});

const assignPriceGroupRoutine = defineScopedRoutine({
  name: 'assign_price_group',
  ownerModuleKey: CUSTOMER_CONTEXT_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'timestamptz' },
    { nullable: true, source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: AssignmentMutationRowSchema,
  routineKey: 'price-group.assignments.assign',
  schema: 'commerce_customer_context',
});

const removePriceGroupAssignmentRoutine = defineScopedRoutine({
  name: 'remove_price_group_assignment',
  ownerModuleKey: CUSTOMER_CONTEXT_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: RemovalMutationRowSchema,
  routineKey: 'price-group.assignments.remove',
  schema: 'commerce_customer_context',
});

const migratePriceGroupAssignmentsRoutine = defineScopedRoutine({
  name: 'migrate_price_group_assignments',
  ownerModuleKey: CUSTOMER_CONTEXT_MODULE_ID,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: MigrationMutationRowSchema,
  routineKey: 'price-group.assignments.migrate',
  schema: 'commerce_customer_context',
});

const persistenceUnavailable = (reason: string) =>
  new CustomerPriceGroupPersistenceUnavailable({
    code: 'customer_price_group_persistence_unavailable',
    reason,
  });

const routinePersistenceUnavailable = (failure: ScopedRoutineInvocationError) =>
  persistenceUnavailable(`The scoped Price Group Assignment routine failed (${failure.routineKey})`);

const profileUnavailable = (reason: string) =>
  new CustomerPriceGroupProfileUnavailable({
    code: 'customer_price_group_profile_unavailable',
    reason,
  });

const routineProfileUnavailable = (failure: ScopedRoutineInvocationError) =>
  profileUnavailable(`The scoped Customer Profile inspection failed (${failure.routineKey})`);

const profileKind = (profile: CommerceCustomerProfileTarget): 'COUNTERPARTY' | 'RETAIL' => profile.kind;

const counterpartyId = (counterpartyRef?: CounterpartyRef): string | null => counterpartyRef?.resourceId ?? null;

const timestamp = (value: Date | string): string | null =>
  Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });

type NullableAssignmentRow = Pick<AssignmentListRow, keyof typeof NullableAssignmentFields>;

const CompleteAssignmentRowSchema = Schema.Struct({
  assignment_id: Schema.String,
  catalog_revision: Schema.Int,
  compatibility_contract_id: Schema.String,
  compatibility_contract_revision: Schema.Int,
  definition_revision: Schema.Int,
  effective_from: Schema.Union([Schema.Date, Schema.String]),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- PostgreSQL routine rows intentionally preserve SQL NULL for an absent open-ended assignment boundary.
  effective_to: Schema.NullOr(Schema.Union([Schema.Date, Schema.String])),
  lifecycle: AssignmentLifecycleSchema,
  price_group_module_id: Schema.String,
  price_group_resource_id: Schema.String,
  price_group_resource_type: Schema.String,
  reason: Schema.String,
  recorded_at: Schema.Union([Schema.Date, Schema.String]),
  revision: Schema.Int,
});
type CompleteAssignmentRow = typeof CompleteAssignmentRowSchema.Type;

const decodeCompleteAssignmentRow = (row: NullableAssignmentRow): Option.Option<CompleteAssignmentRow> =>
  Schema.decodeUnknownOption(CompleteAssignmentRowSchema)(row);

const assignmentFromRow = (
  row: NullableAssignmentRow,
  profile: CommerceCustomerProfileTarget,
): Effect.Effect<CustomerPriceGroupAssignment, CustomerPriceGroupPersistenceUnavailable> => {
  const completeRow = Option.getOrUndefined(decodeCompleteAssignmentRow(row));
  if (completeRow === undefined) {
    return Effect.fail(persistenceUnavailable('The Price Group Assignment routine returned an incomplete row'));
  }
  const effectiveFrom = timestamp(completeRow.effective_from);
  const effectiveTo = completeRow.effective_to === null ? null : timestamp(completeRow.effective_to);
  const recordedAt = timestamp(completeRow.recorded_at);
  if (effectiveFrom === null || recordedAt === null) {
    return Effect.fail(persistenceUnavailable('The Price Group Assignment routine returned an incomplete row'));
  }
  const assignment = {
    assignmentRef: {
      moduleId: CUSTOMER_CONTEXT_MODULE_ID,
      resourceId: completeRow.assignment_id,
      resourceType: 'commerce.customer-context.customer-price-group-assignment',
      tenantId: profile.tenantId,
    },
    compatibility: {
      catalogRevision: completeRow.catalog_revision,
      contractId: completeRow.compatibility_contract_id,
      contractRevision: completeRow.compatibility_contract_revision,
      definitionRevision: completeRow.definition_revision,
    },
    effectiveFrom,
    effectiveTo,
    priceGroupRef: {
      moduleId: completeRow.price_group_module_id,
      resourceId: completeRow.price_group_resource_id,
      resourceType: completeRow.price_group_resource_type,
      tenantId: profile.tenantId,
    },
    profile,
    reason: completeRow.reason,
    recordedAt,
    revision: completeRow.revision,
    state: completeRow.lifecycle === 'CANCELLED' ? ('CANCELLED' as const) : ('ACTIVE' as const),
  };
  return Schema.is(CustomerPriceGroupAssignmentSchema)(assignment)
    ? Effect.succeed(assignment)
    : Effect.fail(persistenceUnavailable('The Price Group Assignment routine returned an invalid row'));
};

const checkScopedReference = (
  scope: OperationalScope & { readonly legalEntityId: string },
  profile: CommerceCustomerProfileTarget,
  counterpartyRef?: CounterpartyRef,
): Effect.Effect<void, CustomerPriceGroupPersistenceUnavailable> =>
  profile.tenantId === scope.tenantId && (counterpartyRef === undefined || counterpartyRef.tenantId === scope.tenantId)
    ? Effect.void
    : Effect.fail(persistenceUnavailable('The Price Group Assignment scope is inconsistent'));

const inspectCustomerPriceGroupProfile = (
  transaction: PriceGroupRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
  profile: CommerceCustomerProfileTarget,
  effectiveAt: PriceGroupInstant,
  expectedCounterpartyRef?: CounterpartyRef,
): Effect.Effect<CustomerPriceGroupProfileValidation, CustomerPriceGroupProfileUnavailable> => {
  if (
    profile.tenantId !== scope.tenantId ||
    (expectedCounterpartyRef !== undefined && expectedCounterpartyRef.tenantId !== scope.tenantId)
  ) {
    return Effect.fail(profileUnavailable('The Customer Profile scope is inconsistent'));
  }
  return transaction
    .invoke(inspectPriceGroupProfileRoutine, [
      profile.resourceId,
      profileKind(profile),
      effectiveAt,
      counterpartyId(expectedCounterpartyRef),
    ])
    .pipe(
      Effect.mapError(routineProfileUnavailable),
      Effect.flatMap(
        ([row]): Effect.Effect<CustomerPriceGroupProfileValidation, CustomerPriceGroupProfileUnavailable> => {
          if (row === undefined) {
            return Effect.fail(profileUnavailable('The profile inspection returned no outcome'));
          }
          if (row.outcome === 'NOT_FOUND' || row.profile_state === null) {
            return Effect.succeed({ _tag: 'NOT_FOUND' } as const);
          }
          const counterpartyRef =
            row.counterparty_resource_id === null
              ? null
              : ({
                  moduleId: 'party.registry',
                  resourceId: row.counterparty_resource_id,
                  resourceType: 'party.registry.counterparty',
                  tenantId: scope.tenantId,
                } as const);
          return Effect.succeed({
            _tag: 'CURRENT',
            counterpartyRef,
            revision: row.revision,
            state: row.profile_state,
          } as const);
        },
      ),
    );
};

const assign = (
  transaction: PriceGroupRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
  input: AssignCustomerPriceGroupStoreInput,
): Effect.Effect<AssignCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable> =>
  checkScopedReference(scope, input.profile, input.counterpartyRef).pipe(
    Effect.flatMap(() =>
      input.tenantId === scope.tenantId && input.priceGroupRef.tenantId === scope.tenantId
        ? Effect.void
        : Effect.fail(persistenceUnavailable('The Price Group reference scope is inconsistent')),
    ),
    Effect.flatMap(() =>
      transaction.invoke(assignPriceGroupRoutine, [
        input.profile.resourceId,
        profileKind(input.profile),
        counterpartyId(input.counterpartyRef),
        input.priceGroupRef.moduleId,
        input.priceGroupRef.resourceType,
        input.priceGroupRef.resourceId,
        input.compatibility.catalogRevision,
        input.compatibility.contractId,
        input.compatibility.contractRevision,
        input.compatibility.definitionRevision,
        input.effectiveFrom,
        input.effectiveTo,
        input.expectedProfileRevision,
        input.reason,
        input.recordedAt,
        input.principalId,
        input.actionInvocationId,
      ]),
    ),
    Effect.mapError((failure) =>
      Schema.is(CustomerPriceGroupPersistenceUnavailable)(failure) ? failure : routinePersistenceUnavailable(failure),
    ),
    Effect.flatMap(
      ([row]): Effect.Effect<AssignCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable> => {
        if (row === undefined) {
          return Effect.fail(persistenceUnavailable('The assignment routine returned no outcome'));
        }
        if (row.outcome === 'OVERLAP') {
          return Effect.succeed({ _tag: 'overlap' });
        }
        if (row.outcome === 'PROFILE_NOT_FOUND') {
          return Effect.succeed({ _tag: 'profile_not_found' });
        }
        if (row.outcome === 'PROFILE_REVISION_CONFLICT') {
          return Effect.succeed({ _tag: 'profile_revision_conflict' });
        }
        if (row.outcome === 'RETROACTIVE_SCHEDULE') {
          return Effect.succeed({ _tag: 'retroactive_schedule' });
        }
        if (row.outcome === 'PROFILE_INELIGIBLE' && row.profile_state !== null) {
          return Effect.succeed({
            _tag: 'profile_ineligible',
            profileState: row.profile_state,
          });
        }
        if (row.outcome !== 'ASSIGNED' && row.outcome !== 'UNCHANGED') {
          return Effect.fail(persistenceUnavailable('The assignment failed its atomic profile revision check'));
        }
        return assignmentFromRow(row, input.profile).pipe(
          Effect.map((assignment) => ({
            _tag: 'assigned' as const,
            assignment,
            changed: row.changed,
            replacedAssignmentRef:
              row.replaced_assignment_id === null
                ? null
                : {
                    moduleId: CUSTOMER_CONTEXT_MODULE_ID,
                    resourceId: row.replaced_assignment_id,
                    resourceType: 'commerce.customer-context.customer-price-group-assignment' as const,
                    tenantId: scope.tenantId,
                  },
          })),
        );
      },
    ),
  );

const assignmentLookupFromRows = (
  rows: readonly AssignmentListRow[],
  profile: CommerceCustomerProfileTarget,
): Effect.Effect<CustomerPriceGroupAssignmentLookup, CustomerPriceGroupPersistenceUnavailable> => {
  if (rows[0]?.outcome === 'PROFILE_NOT_FOUND') {
    return Effect.succeed({ _tag: 'profile_not_found' } as const);
  }
  const assignmentRows = rows.filter(
    (row): row is AssignmentListRow & { readonly assignment_id: string } =>
      row.outcome === 'FOUND' && row.assignment_id !== null,
  );
  return Effect.forEach(assignmentRows, (row) => assignmentFromRow(row, profile), { concurrency: 1 }).pipe(
    Effect.map((assignments) => ({ _tag: 'found' as const, assignments })),
  );
};

const list = (
  transaction: PriceGroupRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
  profile: CommerceCustomerProfileTarget,
): Effect.Effect<CustomerPriceGroupAssignmentLookup, CustomerPriceGroupPersistenceUnavailable> =>
  checkScopedReference(scope, profile).pipe(
    Effect.flatMap(() =>
      transaction.invoke(readPriceGroupAssignmentsRoutine, [profile.resourceId, profileKind(profile)]),
    ),
    Effect.mapError((failure) =>
      Schema.is(CustomerPriceGroupPersistenceUnavailable)(failure) ? failure : routinePersistenceUnavailable(failure),
    ),
    Effect.flatMap((rows) => assignmentLookupFromRows(rows, profile)),
  );

const resolve = (
  transaction: PriceGroupRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
  profile: CommerceCustomerProfileTarget,
  effectiveAt: PriceGroupInstant,
): Effect.Effect<CustomerPriceGroupAssignmentLookup, CustomerPriceGroupPersistenceUnavailable> =>
  checkScopedReference(scope, profile).pipe(
    Effect.flatMap(() =>
      transaction.invoke(resolvePriceGroupAssignmentsRoutine, [profile.resourceId, profileKind(profile), effectiveAt]),
    ),
    Effect.mapError((failure) =>
      Schema.is(CustomerPriceGroupPersistenceUnavailable)(failure) ? failure : routinePersistenceUnavailable(failure),
    ),
    Effect.flatMap((rows) => assignmentLookupFromRows(rows, profile)),
  );

const remove = (
  transaction: PriceGroupRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
  input: RemoveCustomerPriceGroupStoreInput,
): Effect.Effect<RemoveCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable> =>
  checkScopedReference(scope, input.profile, input.counterpartyRef).pipe(
    Effect.flatMap(() =>
      input.tenantId === scope.tenantId && input.assignmentRef.tenantId === scope.tenantId
        ? Effect.void
        : Effect.fail(persistenceUnavailable('The assignment reference scope is inconsistent')),
    ),
    Effect.flatMap(() =>
      transaction.invoke(removePriceGroupAssignmentRoutine, [
        input.profile.resourceId,
        profileKind(input.profile),
        counterpartyId(input.counterpartyRef),
        input.assignmentRef.resourceId,
        input.effectiveAt,
        input.expectedRevision,
        input.reason,
        input.recordedAt,
        input.principalId,
        input.actionInvocationId,
      ]),
    ),
    Effect.mapError((failure) =>
      Schema.is(CustomerPriceGroupPersistenceUnavailable)(failure) ? failure : routinePersistenceUnavailable(failure),
    ),
    Effect.flatMap(
      ([row]): Effect.Effect<RemoveCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable> => {
        if (row === undefined) {
          return Effect.fail(persistenceUnavailable('The removal routine returned no outcome'));
        }
        if (row.outcome === 'ASSIGNMENT_NOT_FOUND') {
          return Effect.succeed({ _tag: 'assignment_not_found' });
        }
        if (row.outcome === 'PROFILE_NOT_FOUND') {
          return Effect.succeed({ _tag: 'profile_not_found' });
        }
        if (row.outcome === 'PROFILE_MISMATCH') {
          return Effect.succeed({ _tag: 'profile_mismatch' });
        }
        if (row.outcome === 'REMOVAL_CONFLICT') {
          return Effect.succeed({ _tag: 'removal_conflict' });
        }
        if (row.outcome === 'RETROACTIVE_SCHEDULE') {
          return Effect.succeed({ _tag: 'retroactive_schedule' });
        }
        if (row.outcome === 'REVISION_CONFLICT') {
          return Effect.succeed({
            _tag: 'revision_conflict',
            currentRevision: row.current_revision,
          });
        }
        if (row.outcome !== 'REMOVED') {
          return Effect.fail(persistenceUnavailable('The removal scope could not be verified'));
        }
        return assignmentFromRow(row, input.profile).pipe(
          Effect.map((assignment) => ({
            _tag: 'removed' as const,
            assignment,
            changed: row.changed,
          })),
        );
      },
    ),
  );

const migrationTargets = (input: MigrateCustomerPriceGroupStoreInput) =>
  input.targets.map((target) => ({
    assignment_id: target.assignmentRef.resourceId,
    expected_profile_revision: target.expectedProfileRevision,
    expected_revision: target.expectedRevision,
    profile_id: target.profile.resourceId,
    profile_kind: target.profile.kind,
  }));

const migrate = (
  transaction: PriceGroupRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
  input: MigrateCustomerPriceGroupStoreInput,
): Effect.Effect<MigrateCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable> => {
  const targetByAssignmentId = new Map(
    input.targets.map((target) => [target.assignmentRef.resourceId, target] as const),
  );
  return Effect.forEach(
    input.targets,
    (target) =>
      checkScopedReference(scope, target.profile, input.counterpartyRef).pipe(
        Effect.flatMap(() =>
          target.assignmentRef.tenantId === scope.tenantId
            ? Effect.void
            : Effect.fail(persistenceUnavailable('A migration target scope is inconsistent')),
        ),
      ),
    { concurrency: 1, discard: true },
  ).pipe(
    Effect.flatMap(() =>
      input.tenantId === scope.tenantId &&
      input.sourcePriceGroupRef.tenantId === scope.tenantId &&
      input.targetPriceGroupRef.tenantId === scope.tenantId
        ? Effect.void
        : Effect.fail(persistenceUnavailable('The migration Price Group scope is inconsistent')),
    ),
    Effect.flatMap(() =>
      transaction.invoke(migratePriceGroupAssignmentsRoutine, [
        counterpartyId(input.counterpartyRef),
        input.sourcePriceGroupRef.moduleId,
        input.sourcePriceGroupRef.resourceType,
        input.sourcePriceGroupRef.resourceId,
        input.targetPriceGroupRef.moduleId,
        input.targetPriceGroupRef.resourceType,
        input.targetPriceGroupRef.resourceId,
        input.compatibility.catalogRevision,
        input.compatibility.contractId,
        input.compatibility.contractRevision,
        input.compatibility.definitionRevision,
        input.effectiveFrom,
        input.reason,
        input.recordedAt,
        input.principalId,
        input.actionInvocationId,
        migrationTargets(input),
      ]),
    ),
    Effect.mapError((failure) =>
      Schema.is(CustomerPriceGroupPersistenceUnavailable)(failure) ? failure : routinePersistenceUnavailable(failure),
    ),
    Effect.flatMap(
      (rows): Effect.Effect<MigrateCustomerPriceGroupStoreResult, CustomerPriceGroupPersistenceUnavailable> => {
        if (rows.length === 0) {
          return Effect.fail(persistenceUnavailable('The migration routine returned no outcome'));
        }
        if (rows[0]?.outcome === 'RETROACTIVE_SCHEDULE') {
          return Effect.succeed({ _tag: 'retroactive_schedule' });
        }
        if (rows.some(({ outcome }) => outcome === 'CONFLICTS')) {
          const conflicts: CustomerPriceGroupMigrationConflictItem[] = [];
          for (const row of rows) {
            if (row.outcome !== 'CONFLICTS' || row.conflict_assignment_id === null || row.conflict_reason === null) {
              return Effect.fail(persistenceUnavailable('The migration routine returned an invalid conflict row'));
            }
            const target = targetByAssignmentId.get(row.conflict_assignment_id);
            if (target === undefined) {
              return Effect.fail(persistenceUnavailable('The migration routine returned an unknown conflict target'));
            }
            conflicts.push({ assignmentRef: target.assignmentRef, reason: row.conflict_reason });
          }
          return Effect.succeed({ _tag: 'conflicts', conflicts });
        }
        return Effect.forEach(
          rows,
          (row) => {
            if (row.assignment_id === null) {
              return Effect.fail(persistenceUnavailable('The migration routine returned an incomplete assignment'));
            }
            const source = input.targets.find(
              ({ profile }) => profile.resourceId === row.profile_id && profile.kind === row.profile_kind,
            );
            return source === undefined
              ? Effect.fail(persistenceUnavailable('The migration routine returned an unknown profile'))
              : assignmentFromRow(row, source.profile);
          },
          { concurrency: 1 },
        ).pipe(
          Effect.map((assignments) => ({
            _tag: 'applied' as const,
            assignments,
            changed: rows.some(({ changed }) => changed),
          })),
        );
      },
    ),
  );
};

export const customerPriceGroupAssignmentStoreForTransaction = (
  transaction: PriceGroupRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
): CustomerPriceGroupAssignmentStorePort => ({
  assign: (input) => assign(transaction, scope, input),
  list: (profile) => list(transaction, scope, profile),
  migrate: (input) => migrate(transaction, scope, input),
  remove: (input) => remove(transaction, scope, input),
  resolve: (profile, effectiveAt) => resolve(transaction, scope, profile, effectiveAt),
});

export const customerPriceGroupProfileValidationForTransaction = (
  transaction: PriceGroupRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
): CustomerPriceGroupProfileValidationPort => ({
  inspect: (profile, effectiveAt, expectedCounterpartyRef) =>
    inspectCustomerPriceGroupProfile(transaction, scope, profile, effectiveAt, expectedCounterpartyRef),
});

export const priceGroupRoutineAllowlist = Object.freeze([
  inspectPriceGroupProfileRoutine,
  readPriceGroupAssignmentsRoutine,
  resolvePriceGroupAssignmentsRoutine,
  assignPriceGroupRoutine,
  removePriceGroupAssignmentRoutine,
  migratePriceGroupAssignmentsRoutine,
]);
