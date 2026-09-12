import { defineScopedRoutine } from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import {
  CommerceCustomerGroupMembershipSchema,
  CommerceCustomerGroupSchema,
} from '../../shared/domain/group-contract.ts';
import type { CommerceCustomerGroup, CommerceCustomerGroupMembership } from '../../shared/domain/group-contract.ts';
import { CustomerGroupPersistenceUnavailable } from '../../shared/domain/group-errors.ts';
import type { CustomerGroupPersistenceUnavailableError } from '../../shared/domain/group-errors.ts';
import type {
  ArchiveCustomerGroupPersistenceOutcome,
  AssignCustomerGroupCommand,
  AssignCustomerGroupPersistenceOutcome,
  CreateCustomerGroupPersistenceOutcome,
  CustomerGroupHistoryResult,
  CustomerGroupMembersResult,
  CustomerGroupPersistence,
  EffectiveCustomerGroupMembershipsResult,
  ReactivateCustomerGroupPersistenceOutcome,
  RemoveCustomerGroupCommand,
  RemoveCustomerGroupPersistenceOutcome,
  UpdateCustomerGroupPersistenceOutcome,
} from '../../shared/domain/group-service.ts';

const MODULE_KEY = 'commerce.customer-context';
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
type JsonObject = typeof JsonObjectSchema.Type;

/** Minimum owner-local capability accepted from Core's already-scoped transaction. */
export interface CustomerGroupScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const GroupRowSchema = Schema.Struct({
  actual_revision: Schema.Int,
  changed: Schema.Boolean,
  group_json: Schema.OptionFromNullOr(JsonObjectSchema),
  outcome: Schema.String,
});
type GroupRow = typeof GroupRowSchema.Type;

const ArchiveRowSchema = Schema.Struct({
  actual_revision: Schema.Int,
  cancelled_count: Schema.Int,
  changed: Schema.Boolean,
  ended_count: Schema.Int,
  group_json: Schema.OptionFromNullOr(JsonObjectSchema),
  outcome: Schema.String,
});

const MembershipRowSchema = Schema.Struct({
  changed: Schema.Boolean,
  membership_json: Schema.OptionFromNullOr(JsonObjectSchema),
  outcome: Schema.String,
  profile_state: Schema.OptionFromNullOr(Schema.String),
});

const MembershipPageRowSchema = Schema.Struct({
  group_json: Schema.OptionFromNullOr(JsonObjectSchema),
  items_json: Schema.Array(JsonObjectSchema),
  next_cursor: Schema.OptionFromNullOr(Schema.String),
  outcome: Schema.String,
});

const detailRoutine = defineScopedRoutine({
  name: 'read_customer_group',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: GroupRowSchema,
  routineKey: 'customer-group.read-detail',
  schema: 'commerce_customer_context',
});

const createRoutine = defineScopedRoutine({
  name: 'create_customer_group',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: GroupRowSchema,
  routineKey: 'customer-group.create',
  schema: 'commerce_customer_context',
});

const updateRoutine = defineScopedRoutine({
  name: 'update_customer_group',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: GroupRowSchema,
  routineKey: 'customer-group.update',
  schema: 'commerce_customer_context',
});

const archiveRoutine = defineScopedRoutine({
  name: 'archive_customer_group',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: ArchiveRowSchema,
  routineKey: 'customer-group.archive',
  schema: 'commerce_customer_context',
});

const reactivateRoutine = defineScopedRoutine({
  name: 'reactivate_customer_group',
  ownerModuleKey: MODULE_KEY,
  parameters: archiveRoutine.parameters,
  resultSchema: GroupRowSchema,
  routineKey: 'customer-group.reactivate',
  schema: 'commerce_customer_context',
});

const assignRoutine = defineScopedRoutine({
  name: 'assign_customer_group_membership',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { nullable: true, source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: MembershipRowSchema,
  routineKey: 'customer-group.assign-membership',
  schema: 'commerce_customer_context',
});

const removeRoutine = defineScopedRoutine({
  name: 'remove_customer_group_membership',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: MembershipRowSchema,
  routineKey: 'customer-group.remove-membership',
  schema: 'commerce_customer_context',
});

const membersRoutine = defineScopedRoutine({
  name: 'read_customer_group_members',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
  ],
  resultSchema: MembershipPageRowSchema,
  routineKey: 'customer-group.read-members',
  schema: 'commerce_customer_context',
});

const historyRoutine = defineScopedRoutine({
  name: 'read_customer_group_history',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'timestamptz' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
  ],
  resultSchema: MembershipPageRowSchema,
  routineKey: 'customer-group.read-history',
  schema: 'commerce_customer_context',
});

const effectiveMembershipsRoutine = defineScopedRoutine({
  name: 'read_effective_customer_group_memberships',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
  ],
  resultSchema: MembershipPageRowSchema,
  routineKey: 'customer-group.read-effective-memberships',
  schema: 'commerce_customer_context',
});

const unavailable = (failure: ScopedRoutineInvocationError | string): CustomerGroupPersistenceUnavailableError =>
  new CustomerGroupPersistenceUnavailable({
    code: 'customer_group_persistence_unavailable',
    reason: Schema.is(Schema.String)(failure)
      ? failure
      : `The scoped Customer Group routine failed (${failure.routineKey})`,
  });

const decodeGroup = (
  value: JsonObject,
): Effect.Effect<CommerceCustomerGroup, CustomerGroupPersistenceUnavailableError> =>
  Schema.decodeUnknownEffect(CommerceCustomerGroupSchema)(value).pipe(
    Effect.mapError((cause) => {
      const error = unavailable('The Customer Group routine returned an invalid group');
      Object.defineProperty(error, 'cause', { configurable: true, value: cause });
      return error;
    }),
  );

const decodeMembership = (
  value: JsonObject,
): Effect.Effect<CommerceCustomerGroupMembership, CustomerGroupPersistenceUnavailableError> =>
  Schema.decodeUnknownEffect(CommerceCustomerGroupMembershipSchema)(value).pipe(
    Effect.mapError((cause) => {
      const error = unavailable('The Customer Group routine returned an invalid membership');
      Object.defineProperty(error, 'cause', { configurable: true, value: cause });
      return error;
    }),
  );

const decodeMemberships = (
  values: readonly JsonObject[],
): Effect.Effect<readonly CommerceCustomerGroupMembership[], CustomerGroupPersistenceUnavailableError> =>
  Effect.forEach(values, (value) => decodeMembership(value), { concurrency: 1 });

const requireRow = <Row>(
  rows: readonly Row[],
  routineKey: string,
): Effect.Effect<Row, CustomerGroupPersistenceUnavailableError> => {
  const [row] = rows;
  return row === undefined
    ? Effect.fail(unavailable(`The ${routineKey} routine returned no outcome`))
    : Effect.succeed(row);
};

const requireGroup = (row: GroupRow) =>
  Option.isNone(row.group_json)
    ? Effect.fail(unavailable('The Customer Group routine omitted its group result'))
    : decodeGroup(row.group_json.value);

const profileKind = (command: AssignCustomerGroupCommand | RemoveCustomerGroupCommand) => command.profile.profileKind;

const scopeMatches = (
  scope: OperationalScope & { readonly legalEntityId: string },
  input: Readonly<{ readonly legalEntityId: string; readonly tenantId: string }>,
): boolean => scope.tenantId === input.tenantId && scope.legalEntityId === input.legalEntityId;

const commandScopeMatches = (
  scope: OperationalScope & { readonly legalEntityId: string },
  input: Readonly<{
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }>,
): boolean => scopeMatches(scope, input) && scope.principalId === input.principalId;

const mapArchiveRow = (
  row: typeof ArchiveRowSchema.Type,
): Effect.Effect<ArchiveCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
  if (row.outcome === 'NOT_FOUND') {
    return Effect.succeed({ _tag: 'not_found' });
  }
  if (row.outcome === 'REVISION_CONFLICT') {
    return Effect.succeed({ _tag: 'revision_conflict', actualRevision: row.actual_revision });
  }
  if (row.outcome === 'LIFECYCLE_CONFLICT') {
    return Effect.succeed({ _tag: 'lifecycle_conflict' });
  }
  if (row.outcome !== 'ARCHIVED' || Option.isNone(row.group_json)) {
    return Effect.fail(unavailable('The Customer Group archive outcome is invalid'));
  }
  return decodeGroup(row.group_json.value).pipe(
    Effect.map((group) => ({
      _tag: 'archived' as const,
      cancelledCount: row.cancelled_count,
      changed: row.changed,
      endedCount: row.ended_count,
      group,
      memberships: [],
    })),
  );
};

const mapAssignRow = (
  row: typeof MembershipRowSchema.Type,
): Effect.Effect<AssignCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
  if (row.outcome === 'NOT_FOUND') {
    return Effect.succeed({ _tag: 'not_found' });
  }
  if (row.outcome === 'PROFILE_NOT_FOUND') {
    return Effect.succeed({ _tag: 'profile_not_found' });
  }
  if (row.outcome === 'GROUP_INACTIVE') {
    return Effect.succeed({ _tag: 'group_inactive' });
  }
  if (row.outcome === 'PROFILE_INELIGIBLE') {
    const encodedProfileState = Option.getOrNull(row.profile_state);
    const profileState =
      encodedProfileState === 'SUSPENDED' ||
      encodedProfileState === 'ARCHIVED' ||
      encodedProfileState === 'RECONCILIATION_REQUIRED'
        ? encodedProfileState
        : 'ARCHIVED';
    return Effect.succeed({ _tag: 'profile_ineligible', profileState });
  }
  if (Option.isNone(row.membership_json)) {
    return Effect.fail(unavailable('The Customer Group assignment omitted its membership'));
  }
  return decodeMembership(row.membership_json.value).pipe(
    Effect.flatMap((membership) => {
      if (row.outcome === 'ASSIGNED') {
        return Effect.succeed<AssignCustomerGroupPersistenceOutcome>({
          _tag: 'assigned',
          membership,
        });
      }
      if (row.outcome === 'ALREADY_ASSIGNED') {
        return Effect.succeed<AssignCustomerGroupPersistenceOutcome>({
          _tag: 'already_assigned',
          membership,
        });
      }
      if (row.outcome === 'OVERLAP') {
        return Effect.succeed<AssignCustomerGroupPersistenceOutcome>({
          _tag: 'overlap',
          membership,
        });
      }
      return Effect.fail(unavailable('The Customer Group assignment outcome is invalid'));
    }),
  );
};

const mapCreateRow = (
  row: GroupRow,
): Effect.Effect<CreateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
  if (row.outcome === 'BUSINESS_CODE_CONFLICT') {
    return Effect.succeed({ _tag: 'business_code_conflict' });
  }
  if (row.outcome === 'SEMANTIC_DUPLICATE') {
    return Effect.succeed({ _tag: 'semantic_duplicate' });
  }
  if (row.outcome !== 'CREATED' && row.outcome !== 'REUSED') {
    return Effect.fail(unavailable('The Customer Group creation outcome is invalid'));
  }
  return requireGroup(row).pipe(
    Effect.map((group): CreateCustomerGroupPersistenceOutcome =>
      row.outcome === 'CREATED' ? { _tag: 'created', group } : { _tag: 'reused', group },
    ),
  );
};

const mapReactivateRow = (
  row: GroupRow,
): Effect.Effect<ReactivateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
  if (row.outcome === 'NOT_FOUND') {
    return Effect.succeed({ _tag: 'not_found' });
  }
  if (row.outcome === 'REVISION_CONFLICT') {
    return Effect.succeed({ _tag: 'revision_conflict', actualRevision: row.actual_revision });
  }
  if (row.outcome === 'LIFECYCLE_CONFLICT') {
    return Effect.succeed({ _tag: 'lifecycle_conflict' });
  }
  if (row.outcome !== 'REACTIVATED') {
    return Effect.fail(unavailable('The Customer Group reactivation outcome is invalid'));
  }
  return requireGroup(row).pipe(Effect.map((group) => ({ _tag: 'reactivated' as const, changed: row.changed, group })));
};

const mapRemoveRow = (
  row: typeof MembershipRowSchema.Type,
): Effect.Effect<RemoveCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
  if (row.outcome === 'NOT_FOUND') {
    return Effect.succeed({ _tag: 'not_found' });
  }
  if (Option.isNone(row.membership_json)) {
    return Effect.fail(unavailable('The Customer Group removal omitted its membership'));
  }
  return decodeMembership(row.membership_json.value).pipe(
    Effect.flatMap((membership) => {
      if (row.outcome === 'REMOVAL_CONFLICT') {
        return Effect.succeed<RemoveCustomerGroupPersistenceOutcome>({
          _tag: 'removal_conflict',
          membership,
        });
      }
      if (row.outcome === 'ALREADY_ENDED') {
        return Effect.succeed<RemoveCustomerGroupPersistenceOutcome>({
          _tag: 'already_ended',
          membership,
        });
      }
      if (row.outcome === 'REMOVED') {
        return Effect.succeed<RemoveCustomerGroupPersistenceOutcome>({
          _tag: 'removed',
          changed: row.changed,
          membership,
        });
      }
      return Effect.fail(unavailable('The Customer Group removal outcome is invalid'));
    }),
  );
};

const mapUpdateRow = (
  row: GroupRow,
): Effect.Effect<UpdateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
  if (row.outcome === 'NOT_FOUND') {
    return Effect.succeed({ _tag: 'not_found' });
  }
  if (row.outcome === 'REVISION_CONFLICT') {
    return Effect.succeed({ _tag: 'revision_conflict', actualRevision: row.actual_revision });
  }
  if (row.outcome === 'NEW_GROUP_REQUIRED') {
    return Effect.succeed({ _tag: 'new_group_required' });
  }
  if (row.outcome === 'ARCHIVED_CORRECTION_FORBIDDEN') {
    return Effect.succeed({ _tag: 'archived_correction_forbidden' });
  }
  if (row.outcome !== 'UPDATED') {
    return Effect.fail(unavailable('The Customer Group update outcome is invalid'));
  }
  return requireGroup(row).pipe(Effect.map((group) => ({ _tag: 'updated' as const, changed: row.changed, group })));
};

export const customerGroupPersistenceForTransaction = (
  transaction: CustomerGroupScopedRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
): CustomerGroupPersistence => ({
  archive: (
    command,
  ): Effect.Effect<ArchiveCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
    if (!commandScopeMatches(scope, command) || command.groupRef.tenantId !== scope.tenantId) {
      return Effect.fail(unavailable('The Customer Group archive scope is inconsistent'));
    }
    return transaction
      .invoke(archiveRoutine, [
        command.groupRef.resourceId,
        command.expectedRevision,
        command.effectiveAt,
        command.reason,
        command.recordedAt,
        scope.principalId,
        command.actionInvocationId,
      ])
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((rows) => requireRow(rows, archiveRoutine.routineKey)),
        Effect.flatMap(mapArchiveRow),
      );
  },
  assign: (command): Effect.Effect<AssignCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
    if (
      !commandScopeMatches(scope, command) ||
      command.groupRef.tenantId !== scope.tenantId ||
      command.profile.profileRef.tenantId !== scope.tenantId
    ) {
      return Effect.fail(unavailable('The Customer Group assignment scope is inconsistent'));
    }
    return transaction
      .invoke(assignRoutine, [
        command.groupRef.resourceId,
        command.profile.profileRef.resourceId,
        profileKind(command),
        command.effectiveFrom,
        command.effectiveTo,
        command.reason,
        command.recordedAt,
        scope.principalId,
        command.actionInvocationId,
      ])
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((rows) => requireRow(rows, assignRoutine.routineKey)),
        Effect.flatMap(mapAssignRow),
      );
  },
  create: (command): Effect.Effect<CreateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
    if (!commandScopeMatches(scope, command)) {
      return Effect.fail(unavailable('The Customer Group creation scope is inconsistent'));
    }
    return transaction
      .invoke(createRoutine, [
        command.businessCode,
        command.meaningKey,
        command.description,
        command.membershipCriteria,
        command.name,
        command.purpose,
        command.reason,
        command.recordedAt,
        scope.principalId,
        command.actionInvocationId,
      ])
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((rows) => requireRow(rows, createRoutine.routineKey)),
        Effect.flatMap(mapCreateRow),
      );
  },
  detail: (query) => {
    if (!scopeMatches(scope, query) || query.groupRef.tenantId !== scope.tenantId) {
      return Effect.fail(unavailable('The Customer Group read scope is inconsistent'));
    }
    return transaction.invoke(detailRoutine, [query.groupRef.resourceId]).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((rows) => requireRow(rows, detailRoutine.routineKey)),
      Effect.flatMap((row) =>
        row.outcome === 'NOT_FOUND'
          ? Effect.succeed(Option.none<CommerceCustomerGroup>())
          : requireGroup(row).pipe(Effect.asSome),
      ),
    );
  },
  effectiveMemberships: (query) => {
    if (!scopeMatches(scope, query) || query.profile.profileRef.tenantId !== scope.tenantId) {
      return Effect.fail(unavailable('The effective Customer Group Membership scope is inconsistent'));
    }
    return transaction
      .invoke(effectiveMembershipsRoutine, [
        query.profile.profileRef.resourceId,
        query.profile.profileKind,
        query.effectiveAt,
      ])
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((rows) => requireRow(rows, effectiveMembershipsRoutine.routineKey)),
        Effect.flatMap((row) =>
          row.outcome === 'PROFILE_NOT_FOUND'
            ? Effect.succeed(Option.none<EffectiveCustomerGroupMembershipsResult>())
            : decodeMemberships(row.items_json).pipe(
                Effect.map((items) => Option.some({ effectiveAt: query.effectiveAt, items, profile: query.profile })),
              ),
        ),
      );
  },
  history: (query) => {
    if (!scopeMatches(scope, query) || query.groupRef.tenantId !== scope.tenantId) {
      return Effect.fail(unavailable('The Customer Group history scope is inconsistent'));
    }
    return transaction.invoke(historyRoutine, [query.groupRef.resourceId, query.asOf, query.cursor, query.limit]).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((rows) => requireRow(rows, historyRoutine.routineKey)),
      Effect.flatMap((row) => {
        if (row.outcome === 'NOT_FOUND' || Option.isNone(row.group_json)) {
          return Effect.succeed(Option.none<CustomerGroupHistoryResult>());
        }
        return Effect.all(
          {
            group: decodeGroup(row.group_json.value),
            memberships: decodeMemberships(row.items_json),
          },
          { concurrency: 2 },
        ).pipe(
          Effect.map(({ group, memberships }) =>
            Option.some({
              asOf: query.asOf,
              group,
              memberships,
              nextCursor: Option.getOrNull(row.next_cursor),
            }),
          ),
        );
      }),
    );
  },
  members: (query) => {
    if (!scopeMatches(scope, query) || query.groupRef.tenantId !== scope.tenantId) {
      return Effect.fail(unavailable('The Customer Group members scope is inconsistent'));
    }
    return transaction
      .invoke(membersRoutine, [
        query.groupRef.resourceId,
        query.effectiveAt,
        query.profileKind,
        query.cursor,
        query.limit,
      ])
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((rows) => requireRow(rows, membersRoutine.routineKey)),
        Effect.flatMap((row) =>
          row.outcome === 'NOT_FOUND'
            ? Effect.succeed(Option.none<CustomerGroupMembersResult>())
            : decodeMemberships(row.items_json).pipe(
                Effect.map((items) =>
                  Option.some({
                    effectiveAt: query.effectiveAt,
                    groupRef: query.groupRef,
                    items,
                    nextCursor: Option.getOrNull(row.next_cursor),
                  }),
                ),
              ),
        ),
      );
  },
  reactivate: (
    command,
  ): Effect.Effect<ReactivateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
    if (!commandScopeMatches(scope, command) || command.groupRef.tenantId !== scope.tenantId) {
      return Effect.fail(unavailable('The Customer Group reactivation scope is inconsistent'));
    }
    return transaction
      .invoke(reactivateRoutine, [
        command.groupRef.resourceId,
        command.expectedRevision,
        command.effectiveAt,
        command.reason,
        command.recordedAt,
        scope.principalId,
        command.actionInvocationId,
      ])
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((rows) => requireRow(rows, reactivateRoutine.routineKey)),
        Effect.flatMap(mapReactivateRow),
      );
  },
  remove: (command): Effect.Effect<RemoveCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
    if (
      !commandScopeMatches(scope, command) ||
      command.groupRef.tenantId !== scope.tenantId ||
      command.membershipRef.tenantId !== scope.tenantId ||
      command.profile.profileRef.tenantId !== scope.tenantId
    ) {
      return Effect.fail(unavailable('The Customer Group removal scope is inconsistent'));
    }
    return transaction
      .invoke(removeRoutine, [
        command.membershipRef.resourceId,
        command.groupRef.resourceId,
        command.profile.profileRef.resourceId,
        profileKind(command),
        command.effectiveAt,
        command.reason,
        command.recordedAt,
        scope.principalId,
        command.actionInvocationId,
      ])
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((rows) => requireRow(rows, removeRoutine.routineKey)),
        Effect.flatMap(mapRemoveRow),
      );
  },
  update: (command): Effect.Effect<UpdateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError> => {
    if (!commandScopeMatches(scope, command) || command.groupRef.tenantId !== scope.tenantId) {
      return Effect.fail(unavailable('The Customer Group update scope is inconsistent'));
    }
    return transaction
      .invoke(updateRoutine, [
        command.groupRef.resourceId,
        command.expectedRevision,
        command.description,
        command.membershipCriteria,
        command.name,
        command.purpose,
        command.reason,
        command.recordedAt,
        scope.principalId,
        command.actionInvocationId,
      ])
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((rows) => requireRow(rows, updateRoutine.routineKey)),
        Effect.flatMap(mapUpdateRow),
      );
  },
});

export const customerGroupRoutineAllowlist = Object.freeze([
  detailRoutine,
  createRoutine,
  updateRoutine,
  archiveRoutine,
  reactivateRoutine,
  assignRoutine,
  removeRoutine,
  membersRoutine,
  historyRoutine,
  effectiveMembershipsRoutine,
]);
