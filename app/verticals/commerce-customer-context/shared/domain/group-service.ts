import { Schema } from 'effect';
import type { Effect, Option } from 'effect';
import type {
  CommerceCustomerGroup,
  CommerceCustomerGroupMembership,
  CommerceCustomerProfileSubject,
  CustomerGroupDefinitionRevision,
  CustomerGroupIsoTimestamp,
  CustomerGroupMeaningKey,
  CustomerGroupProfileLifecycle,
} from './group-contract.ts';
import {
  CommerceCustomerGroupMembershipSchema,
  CommerceCustomerGroupSchema,
  CustomerGroupProfileLifecycleSchema,
  CustomerGroupRevisionSchema,
} from './group-contract.ts';
import type { CustomerGroupPersistenceUnavailableError } from './group-errors.ts';
import type { CustomerGroupMembershipRef } from '../resources/customer-group-membership.ts';
import type { CustomerGroupRef } from '../resources/customer-group.ts';

const RevisionConflictSchema = Schema.TaggedStruct('revision_conflict', {
  actualRevision: CustomerGroupRevisionSchema,
});
const NotFoundSchema = Schema.TaggedStruct('not_found', {});
type NotFound = typeof NotFoundSchema.Type;

export interface MakeCustomerGroupInput {
  readonly businessCode: string;
  readonly description: string;
  readonly groupRef: CustomerGroupRef;
  readonly meaningKey: CustomerGroupMeaningKey;
  readonly membershipCriteria: string;
  readonly name: string;
  readonly purpose: string;
  readonly reason: string;
  readonly recordedAt: CustomerGroupIsoTimestamp;
}

export const makeCustomerGroup = (input: MakeCustomerGroupInput): CommerceCustomerGroup => {
  const definition: CustomerGroupDefinitionRevision = {
    changeKind: 'CREATED',
    description: input.description,
    membershipCriteria: input.membershipCriteria,
    name: input.name,
    purpose: input.purpose,
    reason: input.reason,
    recordedAt: input.recordedAt,
    revision: 1,
  };
  return {
    businessCode: input.businessCode,
    currentDefinition: definition,
    currentState: 'ACTIVE',
    definitionHistory: [definition],
    groupRef: input.groupRef,
    lifecycleHistory: [
      {
        activeFrom: input.recordedAt,
        archivedAt: null,
        reason: input.reason,
        recordedAt: input.recordedAt,
      },
    ],
    meaningKey: input.meaningKey,
    revision: 1,
  };
};

export interface ReviseCustomerGroupInput {
  readonly description: string;
  readonly expectedRevision: number;
  readonly membershipCriteria: string;
  readonly name: string;
  readonly purpose: string;
  readonly reason: string;
  readonly recordedAt: CustomerGroupIsoTimestamp;
}

const ReviseCustomerGroupOutcomeSchema = Schema.Union([
  RevisionConflictSchema,
  Schema.TaggedStruct('new_group_required', {}),
  Schema.TaggedStruct('archived_correction_forbidden', {}),
  Schema.TaggedStruct('updated', {
    changed: Schema.Boolean,
    group: CommerceCustomerGroupSchema,
  }),
]);
export type ReviseCustomerGroupOutcome = typeof ReviseCustomerGroupOutcomeSchema.Type;

export const reviseCustomerGroup = (
  group: CommerceCustomerGroup,
  input: ReviseCustomerGroupInput,
): ReviseCustomerGroupOutcome => {
  if (group.revision !== input.expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: group.revision };
  }
  if (
    input.membershipCriteria !== group.currentDefinition.membershipCriteria ||
    input.purpose !== group.currentDefinition.purpose
  ) {
    return { _tag: 'new_group_required' };
  }
  if (group.currentState === 'ARCHIVED') {
    return { _tag: 'archived_correction_forbidden' };
  }
  if (input.name === group.currentDefinition.name && input.description === group.currentDefinition.description) {
    return { _tag: 'updated', changed: false, group };
  }
  const changeKind =
    input.description === group.currentDefinition.description ? 'COSMETIC_RENAME' : 'DESCRIPTION_CLARIFICATION';
  const definition: CustomerGroupDefinitionRevision = {
    changeKind,
    description: input.description,
    membershipCriteria: input.membershipCriteria,
    name: input.name,
    purpose: input.purpose,
    reason: input.reason,
    recordedAt: input.recordedAt,
    revision: group.currentDefinition.revision + 1,
  };
  return {
    _tag: 'updated',
    changed: true,
    group: {
      ...group,
      currentDefinition: definition,
      definitionHistory: [...group.definitionHistory, definition],
      revision: group.revision + 1,
    },
  };
};

const sameRef = (
  left: Readonly<{ resourceId: string; tenantId: string }>,
  right: Readonly<{ resourceId: string; tenantId: string }>,
): boolean => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameProfile = (left: CommerceCustomerProfileSubject, right: CommerceCustomerProfileSubject): boolean =>
  left.profileKind === right.profileKind && sameRef(left.profileRef, right.profileRef);

const customerGroupIsActiveAt = (group: CommerceCustomerGroup, instant: string): boolean =>
  group.lifecycleHistory.some(
    ({ activeFrom, archivedAt }) => activeFrom <= instant && (archivedAt === null || instant < archivedAt),
  );

const customerGroupMembershipIsEffectiveAt = (membership: CommerceCustomerGroupMembership, instant: string): boolean =>
  membership.state === 'VALID' &&
  membership.effectiveFrom <= instant &&
  (membership.effectiveTo === null || instant < membership.effectiveTo);

const customerGroupMembershipPeriodsOverlap = (
  left: Pick<CommerceCustomerGroupMembership, 'effectiveFrom' | 'effectiveTo'>,
  right: Pick<CommerceCustomerGroupMembership, 'effectiveFrom' | 'effectiveTo'>,
): boolean =>
  (left.effectiveTo === null || right.effectiveFrom < left.effectiveTo) &&
  (right.effectiveTo === null || left.effectiveFrom < right.effectiveTo);

const AssignCustomerGroupMembershipOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('assigned', { membership: CommerceCustomerGroupMembershipSchema }),
  Schema.TaggedStruct('already_assigned', {
    membership: CommerceCustomerGroupMembershipSchema,
  }),
  Schema.TaggedStruct('group_inactive', {}),
  Schema.TaggedStruct('profile_ineligible', {
    profileState: CustomerGroupProfileLifecycleSchema,
  }),
  Schema.TaggedStruct('overlap', { membership: CommerceCustomerGroupMembershipSchema }),
]);
export type AssignCustomerGroupMembershipOutcome = typeof AssignCustomerGroupMembershipOutcomeSchema.Type;

export const assignCustomerGroupMembership = (
  group: CommerceCustomerGroup,
  profileState: CustomerGroupProfileLifecycle,
  existing: readonly CommerceCustomerGroupMembership[],
  proposed: CommerceCustomerGroupMembership,
): AssignCustomerGroupMembershipOutcome => {
  if (!sameRef(group.groupRef, proposed.groupRef)) {
    return { _tag: 'group_inactive' };
  }
  const samePair = existing.filter(
    (candidate) => sameRef(candidate.groupRef, proposed.groupRef) && sameProfile(candidate.profile, proposed.profile),
  );
  const exact = samePair.find(
    (candidate) => candidate.effectiveFrom === proposed.effectiveFrom && candidate.effectiveTo === proposed.effectiveTo,
  );
  if (exact !== undefined) {
    return { _tag: 'already_assigned', membership: exact };
  }
  if (!customerGroupIsActiveAt(group, proposed.effectiveFrom)) {
    return { _tag: 'group_inactive' };
  }
  if (profileState !== 'ACTIVE') {
    return { _tag: 'profile_ineligible', profileState };
  }
  const overlap = samePair.find(
    (candidate) => candidate.state === 'VALID' && customerGroupMembershipPeriodsOverlap(candidate, proposed),
  );
  return overlap === undefined ? { _tag: 'assigned', membership: proposed } : { _tag: 'overlap', membership: overlap };
};

export interface ArchiveCustomerGroupInput {
  readonly effectiveAt: CustomerGroupIsoTimestamp;
  readonly expectedRevision: number;
  readonly reason: string;
  readonly recordedAt: CustomerGroupIsoTimestamp;
}

const ArchiveCustomerGroupOutcomeSchema = Schema.Union([
  RevisionConflictSchema,
  Schema.TaggedStruct('lifecycle_conflict', {}),
  Schema.TaggedStruct('archived', {
    cancelledCount: Schema.Int,
    changed: Schema.Boolean,
    endedCount: Schema.Int,
    group: CommerceCustomerGroupSchema,
    memberships: Schema.Array(CommerceCustomerGroupMembershipSchema),
  }),
]);
export type ArchiveCustomerGroupOutcome = typeof ArchiveCustomerGroupOutcomeSchema.Type;

export const archiveCustomerGroup = (
  group: CommerceCustomerGroup,
  memberships: readonly CommerceCustomerGroupMembership[],
  input: ArchiveCustomerGroupInput,
): ArchiveCustomerGroupOutcome => {
  const openIndex = group.lifecycleHistory.findLastIndex(({ archivedAt }) => archivedAt === null);
  if (openIndex === -1) {
    const last = group.lifecycleHistory.at(-1);
    if (last?.archivedAt === input.effectiveAt) {
      return {
        _tag: 'archived',
        cancelledCount: 0,
        changed: false,
        endedCount: 0,
        group,
        memberships,
      };
    }
    return group.revision === input.expectedRevision
      ? { _tag: 'lifecycle_conflict' }
      : { _tag: 'revision_conflict', actualRevision: group.revision };
  }
  if (group.revision !== input.expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: group.revision };
  }
  const open = group.lifecycleHistory[openIndex];
  if (open === undefined || input.effectiveAt < open.activeFrom || input.effectiveAt > input.recordedAt) {
    return { _tag: 'lifecycle_conflict' };
  }
  let endedCount = 0;
  let cancelledCount = 0;
  const nextMemberships = memberships.map((membership) => {
    if (
      membership.state !== 'VALID' ||
      !sameRef(membership.groupRef, group.groupRef) ||
      (membership.effectiveTo !== null && membership.effectiveTo <= input.effectiveAt)
    ) {
      return membership;
    }
    if (membership.effectiveFrom >= input.effectiveAt) {
      cancelledCount += 1;
      return {
        ...membership,
        removal: {
          effectiveAt: input.effectiveAt,
          kind: 'GROUP_ARCHIVED' as const,
          reason: input.reason,
          recordedAt: input.recordedAt,
        },
        revision: membership.revision + 1,
        state: 'CANCELLED' as const,
      };
    }
    endedCount += 1;
    return {
      ...membership,
      effectiveTo: input.effectiveAt,
      removal: {
        effectiveAt: input.effectiveAt,
        kind: 'GROUP_ARCHIVED' as const,
        reason: input.reason,
        recordedAt: input.recordedAt,
      },
      revision: membership.revision + 1,
    };
  });
  const lifecycleHistory = [...group.lifecycleHistory];
  lifecycleHistory[openIndex] = {
    ...open,
    archivedAt: input.effectiveAt,
    reason: input.reason,
    recordedAt: input.recordedAt,
  };
  return {
    _tag: 'archived',
    cancelledCount,
    changed: true,
    endedCount,
    group: {
      ...group,
      currentState: 'ARCHIVED',
      lifecycleHistory,
      revision: group.revision + 1,
    },
    memberships: nextMemberships,
  };
};

const ReactivateCustomerGroupOutcomeSchema = Schema.Union([
  RevisionConflictSchema,
  Schema.TaggedStruct('lifecycle_conflict', {}),
  Schema.TaggedStruct('reactivated', {
    changed: Schema.Boolean,
    group: CommerceCustomerGroupSchema,
  }),
]);
export type ReactivateCustomerGroupOutcome = typeof ReactivateCustomerGroupOutcomeSchema.Type;

const isIdempotentReactivation = (
  group: CommerceCustomerGroup,
  input: ArchiveCustomerGroupInput,
  last: CommerceCustomerGroup['lifecycleHistory'][number] | undefined,
): boolean => group.currentState === 'ACTIVE' && last?.activeFrom === input.effectiveAt;

const hasReactivationLifecycleConflict = (
  group: CommerceCustomerGroup,
  input: ArchiveCustomerGroupInput,
  last: CommerceCustomerGroup['lifecycleHistory'][number] | undefined,
): boolean =>
  group.currentState === 'ACTIVE' ||
  last?.archivedAt === null ||
  last?.archivedAt === undefined ||
  input.effectiveAt <= last.archivedAt ||
  input.effectiveAt > input.recordedAt;

const reactivatedGroup = (group: CommerceCustomerGroup, input: ArchiveCustomerGroupInput): CommerceCustomerGroup => ({
  ...group,
  currentState: 'ACTIVE',
  lifecycleHistory: [
    ...group.lifecycleHistory,
    {
      activeFrom: input.effectiveAt,
      archivedAt: null,
      reason: input.reason,
      recordedAt: input.recordedAt,
    },
  ],
  revision: group.revision + 1,
});

export const reactivateCustomerGroup = (
  group: CommerceCustomerGroup,
  input: ArchiveCustomerGroupInput,
): ReactivateCustomerGroupOutcome => {
  const last = group.lifecycleHistory.at(-1);
  if (isIdempotentReactivation(group, input, last)) {
    return { _tag: 'reactivated', changed: false, group };
  }
  if (group.revision !== input.expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: group.revision };
  }
  if (hasReactivationLifecycleConflict(group, input, last)) {
    return { _tag: 'lifecycle_conflict' };
  }
  return {
    _tag: 'reactivated',
    changed: true,
    group: reactivatedGroup(group, input),
  };
};

export interface RemoveCustomerGroupMembershipInput {
  readonly effectiveAt: CustomerGroupIsoTimestamp;
  readonly reason: string;
  readonly recordedAt: CustomerGroupIsoTimestamp;
}

const RemoveCustomerGroupMembershipOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('removed', {
    changed: Schema.Boolean,
    membership: CommerceCustomerGroupMembershipSchema,
  }),
  Schema.TaggedStruct('already_ended', {
    membership: CommerceCustomerGroupMembershipSchema,
  }),
  Schema.TaggedStruct('removal_conflict', {
    membership: CommerceCustomerGroupMembershipSchema,
  }),
]);
export type RemoveCustomerGroupMembershipOutcome = typeof RemoveCustomerGroupMembershipOutcomeSchema.Type;

export const removeCustomerGroupMembership = (
  membership: CommerceCustomerGroupMembership,
  input: RemoveCustomerGroupMembershipInput,
): RemoveCustomerGroupMembershipOutcome => {
  if (membership.removal !== null || membership.state === 'CANCELLED') {
    return membership.removal?.effectiveAt === input.effectiveAt
      ? { _tag: 'removed', changed: false, membership }
      : { _tag: 'removal_conflict', membership };
  }
  if (membership.effectiveTo !== null && membership.effectiveTo <= input.effectiveAt) {
    return { _tag: 'already_ended', membership };
  }
  const cancel = input.effectiveAt <= membership.effectiveFrom;
  return {
    _tag: 'removed',
    changed: true,
    membership: {
      ...membership,
      effectiveTo: cancel ? membership.effectiveTo : input.effectiveAt,
      removal: {
        effectiveAt: input.effectiveAt,
        kind: cancel ? 'EXPLICIT_CANCEL' : 'EXPLICIT_END',
        reason: input.reason,
        recordedAt: input.recordedAt,
      },
      revision: membership.revision + 1,
      state: cancel ? 'CANCELLED' : 'VALID',
    },
  };
};

export const effectiveCustomerGroupMemberships = (
  groups: readonly CommerceCustomerGroup[],
  memberships: readonly CommerceCustomerGroupMembership[],
  profile: CommerceCustomerProfileSubject,
  profileState: CustomerGroupProfileLifecycle,
  effectiveAt: string,
): readonly CommerceCustomerGroupMembership[] => {
  if (profileState !== 'ACTIVE') {
    return [];
  }
  const groupById = new Map(groups.map((group) => [group.groupRef.resourceId, group]));
  return memberships
    .filter((membership) => {
      const group = groupById.get(membership.groupRef.resourceId);
      return (
        sameProfile(membership.profile, profile) &&
        customerGroupMembershipIsEffectiveAt(membership, effectiveAt) &&
        group !== undefined &&
        customerGroupIsActiveAt(group, effectiveAt)
      );
    })
    .toSorted((left, right) => left.membershipRef.resourceId.localeCompare(right.membershipRef.resourceId));
};

export type CustomerGroupLookupOutcome<Value> = Option.Option<Value>;

interface CustomerGroupCommandContext {
  readonly actionInvocationId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly recordedAt: CustomerGroupIsoTimestamp;
  readonly tenantId: string;
}

interface CreateCustomerGroupCommand extends CustomerGroupCommandContext {
  readonly businessCode: string;
  readonly description: string;
  readonly meaningKey: CustomerGroupMeaningKey;
  readonly membershipCriteria: string;
  readonly name: string;
  readonly purpose: string;
  readonly reason: string;
}

const CreateCustomerGroupPersistenceOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('created', { group: CommerceCustomerGroupSchema }),
  Schema.TaggedStruct('reused', { group: CommerceCustomerGroupSchema }),
  Schema.TaggedStruct('business_code_conflict', {}),
  Schema.TaggedStruct('semantic_duplicate', {}),
]);
export type CreateCustomerGroupPersistenceOutcome = typeof CreateCustomerGroupPersistenceOutcomeSchema.Type;

interface UpdateCustomerGroupCommand extends CustomerGroupCommandContext, Omit<ReviseCustomerGroupInput, 'recordedAt'> {
  readonly groupRef: CustomerGroupRef;
}

export type UpdateCustomerGroupPersistenceOutcome = NotFound | ReviseCustomerGroupOutcome;

interface ArchiveCustomerGroupCommand
  extends CustomerGroupCommandContext, Omit<ArchiveCustomerGroupInput, 'recordedAt'> {
  readonly groupRef: CustomerGroupRef;
}

export type ArchiveCustomerGroupPersistenceOutcome = NotFound | ArchiveCustomerGroupOutcome;
export type ReactivateCustomerGroupPersistenceOutcome = NotFound | ReactivateCustomerGroupOutcome;

export interface AssignCustomerGroupCommand extends CustomerGroupCommandContext {
  readonly effectiveFrom: string;
  readonly effectiveTo: null | string;
  readonly groupRef: CustomerGroupRef;
  readonly profile: CommerceCustomerProfileSubject;
  readonly reason: string;
}

const AssignCustomerGroupPersistenceOutcomeSchema = Schema.Union([
  AssignCustomerGroupMembershipOutcomeSchema,
  NotFoundSchema,
  Schema.TaggedStruct('profile_not_found', {}),
]);
export type AssignCustomerGroupPersistenceOutcome = typeof AssignCustomerGroupPersistenceOutcomeSchema.Type;

export interface RemoveCustomerGroupCommand extends CustomerGroupCommandContext {
  readonly effectiveAt: CustomerGroupIsoTimestamp;
  readonly groupRef: CustomerGroupRef;
  readonly membershipRef: CustomerGroupMembershipRef;
  readonly profile: CommerceCustomerProfileSubject;
  readonly reason: string;
}

export type RemoveCustomerGroupPersistenceOutcome = RemoveCustomerGroupMembershipOutcome | NotFound;

interface CustomerGroupDetailQuery {
  readonly groupRef: CustomerGroupRef;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

interface CustomerGroupMembersQuery extends CustomerGroupDetailQuery {
  readonly cursor: null | string;
  readonly effectiveAt: CustomerGroupIsoTimestamp;
  readonly limit: number;
  readonly profileKind: null | CommerceCustomerProfileSubject['profileKind'];
}

export interface CustomerGroupMembersResult {
  readonly effectiveAt: CustomerGroupIsoTimestamp;
  readonly groupRef: CustomerGroupRef;
  readonly items: readonly CommerceCustomerGroupMembership[];
  readonly nextCursor: null | string;
}

interface CustomerGroupHistoryQuery extends CustomerGroupDetailQuery {
  readonly asOf: null | CustomerGroupIsoTimestamp;
  readonly cursor: null | string;
  readonly limit: number;
}

export interface CustomerGroupHistoryResult {
  readonly asOf: null | CustomerGroupIsoTimestamp;
  readonly group: CommerceCustomerGroup;
  readonly memberships: readonly CommerceCustomerGroupMembership[];
  readonly nextCursor: null | string;
}

interface EffectiveCustomerGroupMembershipsQuery {
  readonly effectiveAt: CustomerGroupIsoTimestamp;
  readonly legalEntityId: string;
  readonly profile: CommerceCustomerProfileSubject;
  readonly tenantId: string;
}

export interface EffectiveCustomerGroupMembershipsResult {
  readonly effectiveAt: CustomerGroupIsoTimestamp;
  readonly items: readonly CommerceCustomerGroupMembership[];
  readonly profile: CommerceCustomerProfileSubject;
}

export interface CustomerGroupPersistence {
  readonly archive: (
    command: ArchiveCustomerGroupCommand,
  ) => Effect.Effect<ArchiveCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError>;
  readonly assign: (
    command: AssignCustomerGroupCommand,
  ) => Effect.Effect<AssignCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError>;
  readonly create: (
    command: CreateCustomerGroupCommand,
  ) => Effect.Effect<CreateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError>;
  readonly detail: (
    query: CustomerGroupDetailQuery,
  ) => Effect.Effect<CustomerGroupLookupOutcome<CommerceCustomerGroup>, CustomerGroupPersistenceUnavailableError>;
  readonly effectiveMemberships: (
    query: EffectiveCustomerGroupMembershipsQuery,
  ) => Effect.Effect<
    CustomerGroupLookupOutcome<EffectiveCustomerGroupMembershipsResult>,
    CustomerGroupPersistenceUnavailableError
  >;
  readonly history: (
    query: CustomerGroupHistoryQuery,
  ) => Effect.Effect<CustomerGroupLookupOutcome<CustomerGroupHistoryResult>, CustomerGroupPersistenceUnavailableError>;
  readonly members: (
    query: CustomerGroupMembersQuery,
  ) => Effect.Effect<CustomerGroupLookupOutcome<CustomerGroupMembersResult>, CustomerGroupPersistenceUnavailableError>;
  readonly reactivate: (
    command: ArchiveCustomerGroupCommand,
  ) => Effect.Effect<ReactivateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError>;
  readonly remove: (
    command: RemoveCustomerGroupCommand,
  ) => Effect.Effect<RemoveCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError>;
  readonly update: (
    command: UpdateCustomerGroupCommand,
  ) => Effect.Effect<UpdateCustomerGroupPersistenceOutcome, CustomerGroupPersistenceUnavailableError>;
}
