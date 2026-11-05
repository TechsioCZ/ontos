import { Clock, DateTime, Effect, Match, Option, Schema } from 'effect';

import type { AssignmentIncarnationId, CapabilityKey, PrincipalId, RoleId } from '../ids.ts';
import type {
  AccessScope,
  Assignment,
  CatalogSnapshotEntry,
  Cell,
  DelegatedLimits,
  Delegation,
  Holder,
  Role,
  RoleRevision,
} from '../model.ts';
import type { AccessLifecycleError } from './errors.ts';
import { lifecycleRefusal } from './errors.ts';

/** How the delegate holds management authority. A delegated manager can never delegate further. */
export const ManagerAuthoritySchema = Schema.Literals(['delegated', 'permanent']);
export type ManagerAuthority = typeof ManagerAuthoritySchema.Type;

const moduleOf = (capabilityKey: string): string => capabilityKey.split('.')[0] ?? '';

/**
 * P8: the envelope is an exact snapshot of capability keys, so a capability that later appears in the
 * same module is not covered. A delegation never grows with the module it happens to manage.
 */
const missingCapabilityRefusal = (delegation: Delegation, capabilityKey: CapabilityKey): AccessLifecycleError =>
  delegation.capabilityKeys.some((delegatedKey) => moduleOf(delegatedKey) === moduleOf(capabilityKey))
    ? lifecycleRefusal(
        'delegation_envelope_growth',
        `${capabilityKey} arrived in a module the delegation names, but a delegation never grows with its module`,
      )
    : lifecycleRefusal('delegation_cell_outside_envelope', `${capabilityKey} is not inside the delegation envelope`);

export interface DelegationEnvelopeRequest {
  /** The catalog snapshot the delegation was granted against. */
  readonly catalog: readonly CatalogSnapshotEntry[];
  readonly delegation: Delegation;
  /** The capability keys the grantor may hand out. A delegation never exceeds its grantor. */
  readonly grantorCapabilityKeys: readonly CapabilityKey[];
  readonly managerAuthority: ManagerAuthority;
  /** The roles the delegation names, with the legal entity each one belongs to. */
  readonly roles: readonly Role[];
  /** The delegation scope, resolved from `delegation.scopeId`; never another legal entity. */
  readonly scope: AccessScope;
}

/**
 * A delegation manages authority inside its own scope only. A company-local delegation names only the
 * roles of that company, and a tenant-context delegation only the tenant-wide ones; anything else
 * would let a delegate edit authority in a legal entity they were not given.
 */
const roleScopeIssue = (role: Role, delegation: Delegation, scope: AccessScope): AccessLifecycleError | undefined => {
  if (role.tenantId !== delegation.tenantId) {
    return lifecycleRefusal(
      'delegation_role_scope_mismatch',
      `Role ${role.id} belongs to another tenant than the delegation`,
    );
  }
  const inScope = Match.value(scope).pipe(
    Match.tag('LegalEntity', ({ legalEntityId }) => role.legalEntityId === legalEntityId),
    Match.tag('TenantContext', () => role.legalEntityId === undefined),
    Match.exhaustive,
  );
  return inScope
    ? undefined
    : lifecycleRefusal(
        'delegation_role_scope_mismatch',
        `Role ${role.id} is not a role of the delegation scope ${delegation.scopeId}`,
      );
};

/**
 * D10/P8: a delegation is bounded, exact, never self-granted, never re-delegated, and never wider than
 * the person granting it. It names only capability keys that exist in the catalog snapshot it was
 * granted against and only roles of its own scope, so an envelope can never be written for a
 * permission nobody can configure yet or for another company's authority.
 */
export const assertDelegationEnvelope = (
  request: DelegationEnvelopeRequest,
): Effect.Effect<void, AccessLifecycleError> => {
  const { catalog, delegation, grantorCapabilityKeys, managerAuthority, roles, scope } = request;
  if (delegation.grantedBy === delegation.managerId || new Set(delegation.people).has(delegation.managerId)) {
    return Effect.fail(
      lifecycleRefusal('delegation_self_grant', 'A delegation is never granted to or by its own manager'),
    );
  }
  const redelegation = Match.value(managerAuthority).pipe(
    Match.when('delegated', () =>
      Option.some(
        lifecycleRefusal('delegation_redelegation', 'Only permanent authority delegates; a delegate never delegates'),
      ),
    ),
    Match.when('permanent', () => Option.none<AccessLifecycleError>()),
    Match.exhaustive,
  );
  if (Option.isSome(redelegation)) {
    return Effect.fail(redelegation.value);
  }
  const catalogKeys = new Set(catalog.map((entry) => entry.key));
  const unknown = delegation.capabilityKeys.filter((capabilityKey) => !catalogKeys.has(capabilityKey));
  if (unknown.length > 0) {
    return Effect.fail(
      lifecycleRefusal(
        'delegation_unknown_capability',
        `A delegation names catalog capabilities only: ${unknown.join(', ')}`,
      ),
    );
  }
  const grantor = new Set(grantorCapabilityKeys);
  const beyondGrantor = delegation.capabilityKeys.filter((capabilityKey) => !grantor.has(capabilityKey));
  if (beyondGrantor.length > 0) {
    return Effect.fail(
      lifecycleRefusal(
        'delegation_outside_grantor_authority',
        `Nobody delegates authority they do not hold: ${beyondGrantor.join(', ')}`,
      ),
    );
  }
  const rolesById = new Map(roles.map((role) => [role.id, role] as const));
  for (const roleId of delegation.roleIds) {
    const role = rolesById.get(roleId);
    if (role === undefined) {
      return Effect.fail(
        lifecycleRefusal('delegation_role_unknown', `The delegation names an unknown role: ${roleId}`),
      );
    }
    const issue = roleScopeIssue(role, delegation, scope);
    if (issue !== undefined) {
      return Effect.fail(issue);
    }
  }
  return Effect.void;
};

export interface DelegatedCellRequest {
  readonly cell: Cell;
  readonly delegation: Delegation;
  /** The catalog entry of the cell's capability, from the snapshot the role revision pins. */
  readonly entry: CatalogSnapshotEntry;
  readonly roleId: RoleId;
}

/**
 * D10b: only a capability that moves money is limited by an amount ceiling, and a missing envelope
 * ceiling is never "unlimited". A money cell without a ceiling of its own is unlimited authority, so
 * it never fits a capped envelope.
 */
const ceilingIssue = (
  cell: Cell,
  delegation: Delegation,
  entry: CatalogSnapshotEntry,
): AccessLifecycleError | undefined => {
  if (entry.amountInput === undefined || delegation.amountCeiling === undefined) {
    return undefined;
  }
  if (cell.amountCeiling === undefined) {
    return lifecycleRefusal(
      'delegation_amount_outside_envelope',
      'A money capability without an amount limit is unlimited, so it is outside a capped envelope',
    );
  }
  return delegation.amountCeiling.currency === cell.amountCeiling.currency &&
    cell.amountCeiling.limitMinor <= delegation.amountCeiling.limitMinor
    ? undefined
    : lifecycleRefusal(
        'delegation_amount_outside_envelope',
        'The amount limit of the cell is not inside the delegation amount ceiling',
      );
};

/**
 * D10/P8: one cell is inside the envelope when its exact capability key, its role and — for a money
 * capability only — its amount ceiling are covered. The rule is pure, so a planner that cannot run
 * Effects still checks every cell it adopts through the one implementation.
 */
export const delegationCellIssue = (request: DelegatedCellRequest): AccessLifecycleError | undefined => {
  const { cell, delegation, entry, roleId } = request;
  if (entry.key !== cell.capabilityKey) {
    return lifecycleRefusal(
      'delegation_cell_outside_envelope',
      `Catalog entry ${entry.key} is not the capability of the cell ${cell.capabilityKey}`,
    );
  }
  if (!new Set(delegation.capabilityKeys).has(cell.capabilityKey)) {
    return missingCapabilityRefusal(delegation, cell.capabilityKey);
  }
  if (!new Set(delegation.roleIds).has(roleId)) {
    return lifecycleRefusal('delegation_role_outside_envelope', `Role ${roleId} is outside the delegation envelope`);
  }
  return ceilingIssue(cell, delegation, entry);
};

/** Effect-shaped form of the same rule, for the writers that run in an Effect generator. */
export const cellWithinDelegationEnvelope = (
  request: DelegatedCellRequest,
): Effect.Effect<void, AccessLifecycleError> =>
  Effect.suspend(() => {
    const issue = delegationCellIssue(request);
    return issue === undefined ? Effect.void : Effect.fail(issue);
  });

export interface DelegationLivenessRequest {
  readonly delegation: Delegation;
  readonly managerIsMember: boolean;
}

/** A delegation manages only while it is live, inside its period and its manager is still a member. */
export const assertDelegationLive = Effect.fn('accessLifecycle.assertDelegationLive')(
  function* assertDelegationLiveEffect(
    request: DelegationLivenessRequest,
  ): Effect.fn.Return<Delegation, AccessLifecycleError> {
    const now = DateTime.toDateUtc(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const { delegation, managerIsMember } = request;
    const live =
      delegation.status === 'active' && delegation.validFrom <= now && now < delegation.validUntil && managerIsMember;
    if (!live) {
      return yield* lifecycleRefusal(
        'delegation_not_live',
        managerIsMember
          ? `The delegation is ${delegation.status} or outside its period`
          : 'The delegation manager is no longer a member of the scope',
      );
    }
    return delegation;
  },
);

/**
 * The envelope a delegated assignment freezes: every capability key of the role revision it assigns,
 * not one caller-chosen cell, so the bound covers exactly the authority the assignment grants (D10).
 */
export const frozenDelegatedLimits = (delegation: Delegation, cells: readonly [Cell, ...Cell[]]): DelegatedLimits => {
  const [lead, ...rest] = cells;
  const seen = new Set<CapabilityKey>([lead.capabilityKey]);
  const remaining: CapabilityKey[] = [];
  for (const cell of rest) {
    if (!seen.has(cell.capabilityKey)) {
      seen.add(cell.capabilityKey);
      remaining.push(cell.capabilityKey);
    }
  }
  const capabilityKeys: readonly [CapabilityKey, ...CapabilityKey[]] = [lead.capabilityKey, ...remaining];
  const base: DelegatedLimits = {
    capabilityKeys,
    delegationId: delegation.id,
    until: delegation.validUntil,
  };
  return delegation.amountCeiling === undefined ? base : { ...base, amountCeiling: delegation.amountCeiling };
};

const holderPrincipalId = (holder: Holder): Option.Option<PrincipalId> =>
  Match.value(holder).pipe(
    Match.tags({ Agent: () => Option.none<PrincipalId>(), Principal: ({ principalId }) => Option.some(principalId) }),
    Match.exhaustive,
  );

export interface DelegatedAssignmentRequest {
  readonly assignedBy: PrincipalId;
  /** The catalog snapshot the role revision was saved against. */
  readonly catalog: readonly CatalogSnapshotEntry[];
  readonly delegation: Delegation;
  readonly holder: Holder;
  readonly incarnationId: AssignmentIncarnationId;
  /** Whether the delegation manager is still a member of the delegation scope right now. */
  readonly managerIsMember: boolean;
  readonly roleId: RoleId;
  /** The exact revision the assignment grants; every one of its cells must fit the envelope. */
  readonly roleRevision: RoleRevision;
  readonly scopeId: Delegation['scopeId'];
  readonly validUntil?: Date;
}

/**
 * D10/D21: a delegated assignment freezes the envelope (capability keys, amount ceiling and end date)
 * so it stays bounded after the delegation ends. A delegate never assigns themselves, never reaches
 * past the envelope, and never writes into another scope.
 */
export const planDelegatedAssignment = Effect.fn('accessLifecycle.planDelegatedAssignment')(
  function* planDelegatedAssignmentEffect(
    request: DelegatedAssignmentRequest,
  ): Effect.fn.Return<Assignment, AccessLifecycleError> {
    const { catalog, delegation, holder, roleId, roleRevision, scopeId } = request;
    const holderPrincipal = Option.getOrUndefined(holderPrincipalId(holder));
    if (holderPrincipal === delegation.managerId) {
      return yield* lifecycleRefusal('delegation_self_assignment', 'A delegate never assigns themselves a role');
    }
    if (holderPrincipal === undefined || !new Set(delegation.people).has(holderPrincipal)) {
      return yield* lifecycleRefusal(
        'delegation_holder_outside_envelope',
        'The holder is outside the delegation people set',
      );
    }
    if (scopeId !== delegation.scopeId) {
      return yield* lifecycleRefusal(
        'delegation_scope_mismatch',
        'A delegated assignment lives in the delegation scope',
      );
    }
    if (roleRevision.roleId !== roleId) {
      return yield* lifecycleRefusal(
        'delegation_role_outside_envelope',
        `Revision ${roleRevision.id} belongs to role ${roleRevision.roleId}, not ${roleId}`,
      );
    }
    yield* assertDelegationLive({ delegation, managerIsMember: request.managerIsMember });
    const [firstCell, ...restCells] = roleRevision.cells;
    if (firstCell === undefined) {
      return yield* lifecycleRefusal(
        'delegation_role_empty',
        'A delegated assignment grants at least one cell, so it can be bounded by one',
      );
    }
    // The assignment grants the whole revision, so every cell of it has to be inside the envelope.
    const catalogByKey = new Map(catalog.map((entry) => [entry.key, entry] as const));
    for (const cell of roleRevision.cells) {
      const entry = catalogByKey.get(cell.capabilityKey);
      if (entry === undefined) {
        return yield* lifecycleRefusal(
          'delegation_unknown_capability',
          `The role revision grants ${cell.capabilityKey}, which the catalog snapshot does not declare`,
        );
      }
      const issue = delegationCellIssue({ cell, delegation, entry, roleId });
      if (issue !== undefined) {
        return yield* issue;
      }
    }
    if (request.validUntil !== undefined && request.validUntil > delegation.validUntil) {
      return yield* lifecycleRefusal(
        'delegation_end_outside_envelope',
        'A delegated assignment never outlives the delegation that created it',
      );
    }
    const assignedAt = DateTime.toDateUtc(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const assignment: Assignment = {
      assignedAt,
      assignedBy: request.assignedBy,
      delegated: frozenDelegatedLimits(delegation, [firstCell, ...restCells]),
      holder,
      incarnationId: request.incarnationId,
      roleId,
      roleRevisionId: roleRevision.id,
      scopeId,
      status: 'active',
      tenantId: delegation.tenantId,
      validFrom: assignedAt,
      validUntil: request.validUntil ?? delegation.validUntil,
    };
    return assignment;
  },
);

export interface DelegatedAssignmentBoundRequest {
  readonly assignment: Assignment;
  readonly delegation: Delegation;
}

/**
 * D10/D21: after a delegation ends, the assignments it created keep their exact limits forever.
 * Dropping the frozen limits, or stretching the end date, would silently widen granted authority.
 */
export const assertDelegatedAssignmentStaysBounded = (
  request: DelegatedAssignmentBoundRequest,
): Effect.Effect<void, AccessLifecycleError> => {
  const { assignment, delegation } = request;
  const violation = Option.match(Option.fromUndefinedOr(assignment.delegated), {
    onNone: () =>
      lifecycleRefusal(
        'delegation_limits_lost',
        `Assignment ${assignment.incarnationId} must keep the limits of the delegation that created it`,
      ),
    onSome: (limits) =>
      limits.delegationId === delegation.id &&
      assignment.validUntil !== undefined &&
      assignment.validUntil <= limits.until &&
      limits.until.getTime() === delegation.validUntil.getTime() &&
      // The frozen keys are the ones the delegation had; a row that lists more was widened in place.
      limits.capabilityKeys.every((frozenKey) => new Set(delegation.capabilityKeys).has(frozenKey))
        ? undefined
        : lifecycleRefusal(
            'delegation_limits_lost',
            `Assignment ${assignment.incarnationId} no longer matches its frozen delegated limits`,
          ),
  });
  return violation === undefined ? Effect.void : Effect.fail(violation);
};
