import { Effect, Match, Option, Schema } from 'effect';

import { AccessScopeIdSchema, AssignmentIncarnationIdSchema, DelegationIdSchema } from '../ids.ts';
import type { AccessScopeId, AssignmentIncarnationId, PrincipalId, TenantId } from '../ids.ts';
import type { AccessMembership, AccessMembershipId, MembershipKind, MembershipStatus } from '../intent/memberships.ts';
import {
  AccessMembershipIdSchema,
  AccessMembershipSchema,
  canTransitionMembershipStatus,
} from '../intent/memberships.ts';
import type { AccessTeam, AccessTeamMember, AccessTeamMemberId } from '../intent/teams.ts';
import { AccessTeamMemberIdSchema, AccessTeamMemberSchema } from '../intent/teams.ts';
import type {
  AccessMode,
  AccessScope,
  AmountCeiling,
  Assignment,
  CatalogSnapshotEntry,
  Cell,
  CellSelector,
  Delegation,
  Holder,
  Role,
  RoleRevision,
} from '../model.ts';
import { AssignmentSchema, DelegationSchema } from '../model.ts';
import type { AccessLifecycleError, AccessLifecycleFailureCode } from './errors.ts';
import type { ManagerAuthority } from './delegation.ts';
import {
  assertDelegatedAssignmentStaysBounded,
  assertDelegationEnvelope,
  assertDelegationLive,
  ceilingCovers,
  planDelegatedAssignment,
  selectorCovers,
} from './delegation.ts';
import { isSoleAdministrator } from './owners.ts';
import type { ScopeAdministration } from './owners.ts';

/*
 * The atomic people commands: membership, role assignment, team membership and delegation.
 *
 * A BFF may not write these facts one store call at a time. A membership that ends while its
 * assignments stay live, or a delegation that is revoked while its assignments keep an unverified
 * ceiling, is authority nobody decided on. So every command here is a planner: it reads the intent
 * the caller already loaded, proves the invariants of the whole change, and answers with ONE
 * `PeopleChangePlan` naming every row the caller persists in a single transaction before the scope
 * fence is taken (D9, D15). Nothing in this module writes, grants or projects anything.
 *
 * The division of labour is deliberate:
 * - the planner owns the authority invariants: who is a live member, which role lives in which
 *   scope, which envelope a delegate may not leave, when the last administrator needs a successor;
 * - the one gate owns who may call the command at all (O28: administration runs in tenant context
 *   and is never a business-data grant);
 * - the caller owns the fence, the journal and the reconcile, through `runAccessWrite` and
 *   `AccessProjectionWriter.reconcileTenant`, exactly like every other Core intent writer.
 *
 * Two things are deliberately absent. Nothing here creates a role revision: an assignment pins the
 * revision the caller read, and moving every holder of a role onto a new revision is the one role
 * revision writer in `access/changes/role-revision.ts` (P2b). Nothing here borrows a delegation: a
 * delegated manager assigns inside their own envelope, and granting a new envelope is delegation.
 *
 * A delegation or ownership refusal keeps the code Core already publishes for it, so one rule never
 * acquires two names; the `people_*` codes are the ones this module adds.
 */

export const PEOPLE_COMMAND_FAILURE_CODES = [
  'delegation_amount_outside_envelope',
  'delegation_cell_outside_envelope',
  'delegation_end_outside_envelope',
  'delegation_envelope_growth',
  'delegation_holder_outside_envelope',
  'delegation_limits_lost',
  'delegation_not_live',
  'delegation_outside_grantor_authority',
  'delegation_redelegation',
  'delegation_role_empty',
  'delegation_role_outside_envelope',
  'delegation_role_scope_mismatch',
  'delegation_role_unknown',
  'delegation_scope_mismatch',
  'delegation_self_assignment',
  'delegation_self_grant',
  'delegation_unknown_capability',
  'ownership_transfer_not_required',
  'ownership_transfer_required',
  'ownership_transfer_self',
  /** Only a person administers access; no agent appears on this surface (O46, O67-Q5). */
  'people_actor_not_a_person',
  /** v2 assignments and memberships reach people only in this wave (O67-Q5). */
  'people_agent_holder_forbidden',
  'people_assignment_already_ended',
  'people_assignment_scope_mismatch',
  /** The acting person holds no management basis in the scope that reaches this change (O81, P8). */
  'people_authority_missing',
  'people_capability_unknown',
  'people_deadline_outside_membership',
  'people_delegation_end_missing',
  'people_holder_not_a_member',
  'people_holder_unknown',
  /** A lifecycle refusal without a people-specific code of its own; the reason text names the rule. */
  'people_lifecycle_refused',
  'people_membership_already_active',
  'people_membership_ended',
  'people_membership_period_invalid',
  'people_membership_scope_mismatch',
  'people_membership_unknown',
  'people_role_outside_scope',
  'people_role_revision_mismatch',
  'people_successor_not_a_member',
  'people_team_membership_exists',
  'people_team_membership_unknown',
  'people_team_scope_mismatch',
  'people_transfer_scope_missing',
] as const;
export const PeopleCommandFailureCodeSchema = Schema.Literals(PEOPLE_COMMAND_FAILURE_CODES);
export type PeopleCommandFailureCode = typeof PeopleCommandFailureCodeSchema.Type;

/**
 * A refused people command. It does not mean "denied": a denial is the gate's answer, and this error
 * only says that a change the caller already reached cannot be written as stated. `scopeIds` names
 * the ownership domains a transfer has to cover, so a surface can offer exactly the successors the
 * rule demands instead of guessing.
 */
export class PeopleCommandError extends Schema.TaggedError<PeopleCommandError>()('PeopleCommandError', {
  code: PeopleCommandFailureCodeSchema,
  reason: Schema.String,
  scopeIds: Schema.optionalKey(Schema.Array(AccessScopeIdSchema)),
}) {}

export const peopleRefusal = (
  code: PeopleCommandFailureCode,
  reason: string,
  scopeIds?: readonly AccessScopeId[],
): PeopleCommandError =>
  scopeIds === undefined
    ? new PeopleCommandError({ code, reason })
    : new PeopleCommandError({ code, reason, scopeIds: [...scopeIds] });

/**
 * A lifecycle refusal keeps its own published code when this module publishes one for it; otherwise
 * the reason text is carried unchanged under `people_lifecycle_refused`, so a rule is never renamed
 * just to fit this surface.
 */
const lifecycleRefusalOf = (code: AccessLifecycleFailureCode, reason: string): PeopleCommandError => {
  const published = PEOPLE_COMMAND_FAILURE_CODES.find((known) => known === code);
  return peopleRefusal(published ?? 'people_lifecycle_refused', reason);
};

/** The same mapping as an `Effect.mapError` step, for the writers that compose lifecycle effects. */
const toPeopleRefusal = (error: AccessLifecycleError): PeopleCommandError =>
  lifecycleRefusalOf(error.code, error.reason);

/** The rows one command writes. Every arm names a concrete intent row, never a command service. */
export const PeopleIntentWriteSchema = Schema.Union([
  Schema.TaggedStruct('RecordMembership', { membership: AccessMembershipSchema }),
  Schema.TaggedStruct('EndMembership', {
    membershipId: AccessMembershipIdSchema,
    status: Schema.Literals(['revoked', 'suspended']),
  }),
  Schema.TaggedStruct('RecordAssignment', { assignment: AssignmentSchema }),
  /** An assignment only ends; the row keeps every frozen delegated limit it was written with. */
  Schema.TaggedStruct('EndAssignment', { incarnationId: AssignmentIncarnationIdSchema }),
  Schema.TaggedStruct('RecordDelegation', { delegation: DelegationSchema }),
  Schema.TaggedStruct('EndDelegation', { delegationId: DelegationIdSchema }),
  Schema.TaggedStruct('RecordTeamMember', { member: AccessTeamMemberSchema }),
  Schema.TaggedStruct('RemoveTeamMember', { teamMemberId: AccessTeamMemberIdSchema }),
]);
export type PeopleIntentWrite = typeof PeopleIntentWriteSchema.Type;

/**
 * One atomic people change: the rows to persist together, the rules already proved (`checks`, for
 * the operation receipt) and the scope whose fence serializes it against every other access writer.
 */
export interface PeopleChangePlan {
  readonly checks: readonly string[];
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
  readonly writes: readonly PeopleIntentWrite[];
}

const planOf = (
  facts: { readonly scopeId: AccessScopeId; readonly tenantId: TenantId },
  checks: readonly string[],
  writes: readonly PeopleIntentWrite[],
): PeopleChangePlan => ({
  checks,
  scopeId: facts.scopeId,
  tenantId: facts.tenantId,
  writes,
});

/** The trusted facts every command of this module is planned against. */
export interface PeopleCommandFacts {
  /** The scoped person (`OperationalScope.principalId`), never a person named by a request body. */
  readonly actor: PrincipalId;
  /** Model time, minted by Core; no planner reads the clock for a rule about a period. */
  readonly at: Date;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

const principalOf = (holder: Holder): Option.Option<PrincipalId> =>
  Match.value(holder).pipe(
    Match.tags({
      Agent: () => Option.none<PrincipalId>(),
      Principal: ({ principalId }) => Option.some(principalId),
    }),
    Match.exhaustive,
  );

const personOf = (holder: Holder): PrincipalId | undefined => Option.getOrUndefined(principalOf(holder));

/**
 * A live membership is the first half of every decision (guarantee 3). Suspension subtracts the
 * graph, so a suspended member is not live: assigning authority to them would write dead authority.
 */
export const membershipIsLive = (membership: AccessMembership, at: Date): boolean =>
  membership.status === 'active' &&
  membership.validFrom <= at &&
  (membership.validUntil === undefined || at < membership.validUntil);

/** A live assignment is what the projection carries; an ended one is history, never authority. */
export const assignmentIsLive = (assignment: Assignment, at: Date): boolean =>
  assignment.status === 'active' &&
  assignment.validFrom <= at &&
  (assignment.validUntil === undefined || at < assignment.validUntil);

const liveMembershipOf = (request: {
  readonly at: Date;
  readonly holder: PrincipalId;
  readonly kind: MembershipKind;
  readonly memberships: readonly AccessMembership[];
  readonly scopeId: AccessScopeId;
}): AccessMembership | undefined =>
  request.memberships.find(
    (membership) =>
      membership.scopeId === request.scopeId &&
      membership.kind === request.kind &&
      personOf(membership.holder) === request.holder &&
      membershipIsLive(membership, request.at),
  );

const liveAssignmentsOf = (request: {
  readonly assignments: readonly Assignment[];
  readonly at: Date;
  readonly holder: PrincipalId;
  readonly scopeId: AccessScopeId;
}): readonly Assignment[] =>
  request.assignments.filter(
    (assignment) =>
      assignment.scopeId === request.scopeId &&
      personOf(assignment.holder) === request.holder &&
      assignmentIsLive(assignment, request.at),
  );

const teamPlacesOf = (request: {
  readonly holder: PrincipalId;
  readonly members: readonly AccessTeamMember[];
  readonly scopeId: AccessScopeId;
  readonly teams: readonly AccessTeam[];
}): readonly AccessTeamMember[] => {
  const teamIds = new Set<AccessTeam['id']>();
  for (const team of request.teams) {
    if (team.scopeId === request.scopeId) {
      teamIds.add(team.id);
    }
  }
  return request.members.filter((member) => teamIds.has(member.teamId) && personOf(member.holder) === request.holder);
};

/**
 * A person holds authority in a scope only while their operational membership there is live. Every
 * command that names a person re-checks this: an assignment, a delegation target and a team place
 * are all authority, and authority without membership is a row nobody can use (guarantee 3).
 */
const requireLiveMember = (request: {
  readonly at: Date;
  readonly holder: PrincipalId;
  readonly memberships: readonly AccessMembership[];
  readonly scopeId: AccessScopeId;
}): Effect.Effect<void, PeopleCommandError> =>
  liveMembershipOf({ ...request, kind: 'member' }) === undefined
    ? Effect.fail(
        peopleRefusal(
          'people_holder_not_a_member',
          `Person ${request.holder} has no live membership in scope ${request.scopeId}`,
        ),
      )
    : Effect.void;

/* ------------------------------------------------------------------------------------------------
 * Membership: the operational relation everything stands on, plus the management kinds
 * ---------------------------------------------------------------------------------------------- */

/**
 * `member` is participation, `owner` is the tenant's own management authority and `access_admin` is
 * one company's (O28). Each lives in exactly one kind of scope, so a command cannot park tenant
 * ownership in a company or company administration in the tenant context.
 */
const managementScopeIssue = (request: {
  readonly administration: ScopeAdministration;
  readonly kind: MembershipKind;
  readonly scopeId: AccessScopeId;
}): Effect.Effect<void, PeopleCommandError> => {
  const { administration, kind, scopeId } = request;
  const inTenantScope = scopeId === administration.tenantScopeId;
  if (kind === 'owner' && !inTenantScope) {
    return Effect.fail(
      peopleRefusal('people_membership_scope_mismatch', 'Tenant ownership is held in the tenant scope only'),
    );
  }
  if (kind === 'access_admin' && inTenantScope) {
    return Effect.fail(
      peopleRefusal(
        'people_membership_scope_mismatch',
        'Company administration is held in one company scope, not in the tenant context',
      ),
    );
  }
  return Effect.void;
};

export interface MembershipGrantRequest extends PeopleCommandFacts {
  readonly administration: ScopeAdministration;
  /** The tenant's own owners, so the first owner of a tenant is not mistaken for a later one. */
  readonly holder: Holder;
  readonly kind: MembershipKind;
  /** A rejoin is a fresh row, so the caller mints the id; nothing here reuses a revoked one (D27). */
  readonly membershipId: AccessMembershipId;
  readonly memberships: readonly AccessMembership[];
  readonly validUntil?: Date;
}

/**
 * Admits one holder to one scope. A live row of the same kind is never widened in place: extending
 * access is a fresh membership, so a deadline something already relied on never moves silently.
 */
export const planMembershipGrant = (
  request: MembershipGrantRequest,
): Effect.Effect<PeopleChangePlan, PeopleCommandError> => {
  const principal = principalOf(request.holder);
  if (Option.isNone(principal)) {
    return Effect.fail(
      peopleRefusal('people_agent_holder_forbidden', 'An agent holds no membership in this wave (O67-Q5)'),
    );
  }
  const holder = Option.getOrThrow(principal);
  if (request.validUntil !== undefined && request.validUntil <= request.at) {
    return Effect.fail(
      peopleRefusal('people_membership_period_invalid', 'A membership ends after the instant it begins'),
    );
  }
  const live = liveMembershipOf({
    at: request.at,
    holder,
    kind: request.kind,
    memberships: request.memberships,
    scopeId: request.scopeId,
  });
  if (live !== undefined) {
    return Effect.fail(
      peopleRefusal(
        'people_membership_already_active',
        `Person ${holder} already holds a live ${request.kind} membership in scope ${request.scopeId}`,
      ),
    );
  }
  const membership: AccessMembership = {
    createdAt: request.at,
    holder: request.holder,
    id: request.membershipId,
    kind: request.kind,
    recordedBy: request.actor,
    scopeId: request.scopeId,
    status: 'active',
    tenantId: request.tenantId,
    validFrom: request.at,
  };
  const dated = request.validUntil === undefined ? membership : { ...membership, validUntil: request.validUntil };
  return managementScopeIssue({
    administration: request.administration,
    kind: request.kind,
    scopeId: request.scopeId,
  }).pipe(
    Effect.as(
      planOf(
        { scopeId: request.scopeId, tenantId: request.tenantId },
        ['people_membership_admitted'],
        [{ _tag: 'RecordMembership', membership: dated }],
      ),
    ),
  );
};

export interface MembershipEndRequest extends PeopleCommandFacts {
  readonly administration: ScopeAdministration;
  readonly assignments: readonly Assignment[];
  readonly membershipId: AccessMembershipId;
  readonly memberships: readonly AccessMembership[];
  readonly nextStatus: Extract<MembershipStatus, 'revoked' | 'suspended'>;
  /**
   * The successor named in the SAME command, required exactly where the leaver is the last
   * administrator. Its management membership is minted inside this plan, so the scope is never
   * unadministered between two commands a caller could separate (O53).
   */
  readonly successor?: { readonly membershipId: AccessMembershipId; readonly principalId: PrincipalId };
  readonly teamMembers: readonly AccessTeamMember[];
  readonly teams: readonly AccessTeam[];
}

export interface MembershipEndPlan extends PeopleChangePlan {
  /** The scopes a transfer has to cover; the caller offers their live members as successors. */
  readonly ownershipTransferScopeIds: readonly AccessScopeId[];
}

/**
 * The last administrator of a scope leaves only by transferring it (O53, O65). The fact is derived
 * from the administration rows Core read, never from a caller flag (O64), and the refusal names the
 * exact scopes the transfer must cover so the surface can offer successors instead of a dead end.
 */
const successorIssue = (request: {
  readonly administration: ScopeAdministration;
  readonly at: Date;
  readonly leaver: PrincipalId;
  readonly memberships: readonly AccessMembership[];
  readonly scopeIds: readonly AccessScopeId[];
  readonly successor?: { readonly principalId: PrincipalId };
}): Effect.Effect<readonly AccessScopeId[], PeopleCommandError> => {
  const unadministered = request.scopeIds.filter((scopeId) =>
    isSoleAdministrator({
      administration: request.administration,
      at: request.at,
      principalId: request.leaver,
      scopeId,
    }),
  );
  if (unadministered.length === 0) {
    return Effect.succeed([]);
  }
  const { successor } = request;
  if (successor === undefined) {
    return Effect.fail(
      peopleRefusal(
        'ownership_transfer_required',
        'The last administrator of a scope leaves only by transferring that administration in the same command',
        unadministered,
      ),
    );
  }
  if (successor.principalId === request.leaver) {
    return Effect.fail(
      peopleRefusal('ownership_transfer_self', 'The successor of a transfer is somebody else', unadministered),
    );
  }
  const notAMember = unadministered.find(
    (scopeId) =>
      liveMembershipOf({
        at: request.at,
        holder: successor.principalId,
        kind: 'member',
        memberships: request.memberships,
        scopeId,
      }) === undefined,
  );
  return notAMember === undefined
    ? Effect.succeed(unadministered)
    : Effect.fail(
        peopleRefusal(
          'people_successor_not_a_member',
          `Person ${successor.principalId} is not a live member of scope ${notAMember}`,
          unadministered,
        ),
      );
};

/** The scopes whose administration a membership carries; a plain member carries none. */
/**
 * Whether ending this row ends the person's operational membership of its scope: it is a `member`
 * row and they hold no other live one there. Only that path carries their business assignments and
 * team places, and every administration a decision rests on (O28).
 */
const endsOperationalPath = (ending: AccessMembership, memberships: readonly AccessMembership[], at: Date) =>
  ending.kind === 'member' &&
  !memberships.some(
    (other) =>
      other.id !== ending.id &&
      other.scopeId === ending.scopeId &&
      other.kind === 'member' &&
      personOf(other.holder) === personOf(ending.holder) &&
      membershipIsLive(other, at),
  );

/**
 * The scopes whose administration ending this row removes from the leaver. An owner or access-admin
 * row ends its own administration. A member row that ends the operational path ends every
 * administration standing on it: the tenant's ownership and every company administration for the
 * tenant's path, and that company's administration for a company's path.
 */
const managementScopesOf = (request: {
  readonly administration: ScopeAdministration;
  readonly endsPath: boolean;
  readonly kind: MembershipKind;
  readonly leaver: PrincipalId;
  readonly scopeId: AccessScopeId;
}): readonly AccessScopeId[] => {
  const { administration, leaver } = request;
  if (request.kind === 'owner') {
    return [administration.tenantScopeId];
  }
  if (request.kind === 'access_admin') {
    return [request.scopeId];
  }
  if (!request.endsPath) {
    return [];
  }
  const tenantPath = request.scopeId === administration.tenantScopeId;
  const owns = tenantPath && administration.tenantOwners.some((owner) => owner.principalId === leaver);
  const administers = administration.scopeAdministrators.flatMap((row) =>
    (tenantPath || row.scopeId === request.scopeId) && row.administrators.some((admin) => admin.principalId === leaver)
      ? [row.scopeId]
      : [],
  );
  return [...(owns ? [administration.tenantScopeId] : []), ...administers];
};

/**
 * Ends or suspends one membership. Ending a membership ends the authority that stood on it in the
 * SAME plan — its role assignments and its team places — because a membership without them would
 * leave live rows nobody can reach, and a departure that keeps them is not a departure (O65).
 *
 * Two rules deliberately do not appear here: reducing authority is never gated (O35), and the last
 * administrator leaves only by transferring the scope (O53, O65), which is why the plan can refuse
 * with the exact scopes a transfer has to cover.
 */
export const planMembershipEnd = (
  request: MembershipEndRequest,
): Effect.Effect<MembershipEndPlan, PeopleCommandError> => {
  const ending = request.memberships.find(
    (membership) => membership.id === request.membershipId && membership.scopeId === request.scopeId,
  );
  if (ending === undefined) {
    return Effect.fail(
      peopleRefusal(
        'people_membership_unknown',
        `Scope ${request.scopeId} carries no membership ${request.membershipId}`,
      ),
    );
  }
  const leaver = personOf(ending.holder);
  if (leaver === undefined) {
    return Effect.fail(peopleRefusal('people_holder_unknown', 'A membership row names no person'));
  }
  if (!membershipIsLive(ending, request.at)) {
    return Effect.fail(
      peopleRefusal('people_membership_ended', `Membership ${ending.id} is ${ending.status} and never reopens`),
    );
  }
  if (!canTransitionMembershipStatus(ending.status, request.nextStatus)) {
    return Effect.fail(
      peopleRefusal(
        'people_membership_ended',
        `Membership ${ending.id} is ${ending.status} and never becomes ${request.nextStatus}`,
      ),
    );
  }
  const endsPath = endsOperationalPath(ending, request.memberships, request.at);
  const managementScopeIds = managementScopesOf({
    administration: request.administration,
    endsPath,
    kind: ending.kind,
    leaver,
    scopeId: ending.scopeId,
  });
  // A member row can stand under several administrations, and one command mints one successor
  // membership, so the leaver transfers that administration first and then leaves (O53).
  if (ending.kind === 'member' && request.successor !== undefined) {
    return Effect.fail(
      peopleRefusal(
        'ownership_transfer_not_required',
        `Membership ${ending.id} is a member row; transfer the administration it carries before ending it`,
        [ending.scopeId],
      ),
    );
  }
  const issue = {
    administration: request.administration,
    at: request.at,
    leaver,
    memberships: request.memberships,
    scopeIds: managementScopeIds,
  };
  const successorRequest = request.successor === undefined ? issue : { ...issue, successor: request.successor };
  return successorIssue(successorRequest).pipe(
    Effect.flatMap((ownershipTransferScopeIds) =>
      // A successor named for a membership that is not the last administration of its scope is a
      // stale form: granting it would add authority nobody asked to transfer.
      request.successor !== undefined && ownershipTransferScopeIds.length === 0
        ? Effect.fail(
            peopleRefusal(
              'ownership_transfer_not_required',
              `Membership ${ending.id} is not the last administration of scope ${ending.scopeId}, so it needs no successor`,
              [ending.scopeId],
            ),
          )
        : Effect.succeed(ownershipTransferScopeIds),
    ),
    Effect.map((ownershipTransferScopeIds) => {
      // Only the end of the operational path ends the business authority standing on it; giving up
      // an owner or access-admin row keeps the person's assignments and team places.
      const assignments = endsPath
        ? liveAssignmentsOf({
            assignments: request.assignments,
            at: request.at,
            holder: leaver,
            scopeId: ending.scopeId,
          })
        : [];
      const places = endsPath
        ? teamPlacesOf({ holder: leaver, members: request.teamMembers, scopeId: ending.scopeId, teams: request.teams })
        : [];
      // Revoking the path also revokes the management rows that stood on it, so a later rejoin starts
      // clean instead of silently restoring an administration nobody granted again. A suspension is
      // temporary and leaves them, because the suspended path already blocks them.
      const tenantPath = ending.scopeId === request.administration.tenantScopeId;
      const dependentManagement =
        endsPath && request.nextStatus === 'revoked'
          ? request.memberships.filter(
              (membership) =>
                membership.id !== ending.id &&
                (membership.kind === 'owner' || membership.kind === 'access_admin') &&
                personOf(membership.holder) === leaver &&
                (tenantPath || membership.scopeId === ending.scopeId) &&
                membershipIsLive(membership, request.at),
            )
          : [];
      // The successor gains the management membership of the scope this row ends, in this plan, so
      // one committed transaction always leaves the scope administered (O53).
      const transfer: readonly PeopleIntentWrite[] =
        request.successor === undefined
          ? []
          : [
              {
                _tag: 'RecordMembership',
                membership: {
                  createdAt: request.at,
                  holder: { _tag: 'Principal', principalId: request.successor.principalId },
                  id: request.successor.membershipId,
                  kind: ending.kind === 'owner' ? 'owner' : 'access_admin',
                  recordedBy: request.actor,
                  scopeId: ending.scopeId,
                  status: 'active',
                  tenantId: request.tenantId,
                  validFrom: request.at,
                },
              },
            ];
      const writes: readonly PeopleIntentWrite[] = [
        ...transfer,
        { _tag: 'EndMembership', membershipId: ending.id, status: request.nextStatus },
        ...dependentManagement.map((membership): PeopleIntentWrite => ({
          _tag: 'EndMembership',
          membershipId: membership.id,
          status: 'revoked',
        })),
        ...assignments.map((assignment): PeopleIntentWrite => ({
          _tag: 'EndAssignment',
          incarnationId: assignment.incarnationId,
        })),
        ...places.map((place): PeopleIntentWrite => ({ _tag: 'RemoveTeamMember', teamMemberId: place.id })),
      ];
      return {
        checks: [
          'people_membership_transition_allowed',
          'people_membership_assignment_closure',
          'people_ownership_transfer_complete',
        ],
        ownershipTransferScopeIds,
        scopeId: request.scopeId,
        tenantId: request.tenantId,
        writes,
      };
    }),
  );
};

/* ------------------------------------------------------------------------------------------------
 * Role assignment: one immutable incarnation, a deadline inside its membership, a frozen envelope
 * ---------------------------------------------------------------------------------------------- */

const catalogIssue = (request: {
  readonly catalog: readonly CatalogSnapshotEntry[];
  readonly roleRevision: RoleRevision;
}): Effect.Effect<void, PeopleCommandError> => {
  const known = new Set(request.catalog.map((entry) => entry.key));
  const unknown = request.roleRevision.cells.find((cell) => !known.has(cell.capabilityKey));
  return unknown === undefined
    ? Effect.void
    : Effect.fail(
        peopleRefusal(
          'people_capability_unknown',
          `The role revision grants ${unknown.capabilityKey}, which the catalog snapshot does not declare`,
        ),
      );
};

const roleLivesInScope = (scope: AccessScope, role: Role): boolean =>
  Match.value(scope).pipe(
    Match.tag('LegalEntity', ({ legalEntityId }) => role.legalEntityId === legalEntityId),
    Match.tag('TenantContext', () => role.legalEntityId === undefined),
    Match.exhaustive,
  );

export interface RoleAssignmentRequest extends PeopleCommandFacts {
  /** The catalog snapshot the role revision pins; a cell the snapshot lacks is not authority. */
  readonly catalog: readonly CatalogSnapshotEntry[];
  /**
   * The delegation the assigner leans on, with the manager's membership fact the caller read. A
   * delegated manager assigns inside their own envelope — that is what the envelope is for — so the
   * only authority question here is whether it is still live and the manager is still a member.
   */
  readonly delegation?: {
    readonly delegation: Delegation;
    readonly managerIsMember: boolean;
  };
  readonly holder: Holder;
  readonly incarnationId: AssignmentIncarnationId;
  readonly memberships: readonly AccessMembership[];
  readonly role: Role;
  readonly roleRevision: RoleRevision;
  readonly scope: AccessScope;
  readonly validUntil?: Date;
}

const delegatedAssignment = (
  request: RoleAssignmentRequest & { readonly delegation: NonNullable<RoleAssignmentRequest['delegation']> },
  holder: PrincipalId,
): Effect.Effect<Assignment, PeopleCommandError> => {
  const input = {
    assignedBy: request.actor,
    catalog: request.catalog,
    delegation: request.delegation.delegation,
    holder: { _tag: 'Principal' as const, principalId: holder },
    incarnationId: request.incarnationId,
    managerIsMember: request.delegation.managerIsMember,
    roleId: request.role.id,
    roleRevision: request.roleRevision,
    scopeId: request.scopeId,
  };
  const delegated = request.validUntil === undefined ? input : { ...input, validUntil: request.validUntil };
  return Effect.mapError(planDelegatedAssignment(delegated), toPeopleRefusal);
};

const directAssignment = (request: RoleAssignmentRequest, holder: PrincipalId): Assignment => {
  const assignment: Assignment = {
    assignedAt: request.at,
    assignedBy: request.actor,
    holder: { _tag: 'Principal', principalId: holder },
    incarnationId: request.incarnationId,
    roleId: request.role.id,
    roleRevisionId: request.roleRevision.id,
    scopeId: request.scopeId,
    status: 'active',
    tenantId: request.tenantId,
    validFrom: request.at,
  };
  return request.validUntil === undefined ? assignment : { ...assignment, validUntil: request.validUntil };
};

/**
 * Assigns one role revision to one person. The incarnation is minted by the caller and never
 * reused; the deadline never outlives the membership the assignment stands on; and a delegated
 * assignment is built by the lifecycle's own `planDelegatedAssignment`, so the frozen envelope
 * (capability keys, amount ceiling, end date) is written by the one implementation of D10 and D10b
 * and never re-derived here.
 */
export const planRoleAssignment = (
  request: RoleAssignmentRequest,
): Effect.Effect<PeopleChangePlan, PeopleCommandError> => {
  const principal = principalOf(request.holder);
  if (Option.isNone(principal)) {
    return Effect.fail(
      peopleRefusal('people_agent_holder_forbidden', 'An agent holds no role assignment in this wave (O67-Q5)'),
    );
  }
  const holder = Option.getOrThrow(principal);
  if (request.roleRevision.roleId !== request.role.id) {
    return Effect.fail(
      peopleRefusal(
        'people_role_revision_mismatch',
        `Revision ${request.roleRevision.id} belongs to role ${request.roleRevision.roleId}, not ${request.role.id}`,
      ),
    );
  }
  if (!roleLivesInScope(request.scope, request.role)) {
    return Effect.fail(
      peopleRefusal('people_role_outside_scope', `Role ${request.role.name} does not live in scope ${request.scopeId}`),
    );
  }
  return Effect.gen(function* planRoleAssignmentEffect() {
    yield* requireLiveMember({
      at: request.at,
      holder,
      memberships: request.memberships,
      scopeId: request.scopeId,
    });
    yield* catalogIssue({ catalog: request.catalog, roleRevision: request.roleRevision });
    const membership = liveMembershipOf({
      at: request.at,
      holder,
      kind: 'member',
      memberships: request.memberships,
      scopeId: request.scopeId,
    });
    const membershipEnd = membership?.validUntil;
    if (membershipEnd !== undefined && request.validUntil !== undefined && request.validUntil > membershipEnd) {
      return yield* peopleRefusal(
        'people_deadline_outside_membership',
        'An assignment never outlives the membership it stands on',
      );
    }
    const deadline = request.validUntil ?? membershipEnd;
    const bounded = deadline === undefined ? request : { ...request, validUntil: deadline };
    const assignment =
      request.delegation === undefined
        ? directAssignment(bounded, holder)
        : yield* delegatedAssignment({ ...bounded, delegation: request.delegation }, holder);
    return planOf(
      { scopeId: request.scopeId, tenantId: request.tenantId },
      ['people_assignment_incarnation'],
      [{ _tag: 'RecordAssignment', assignment }],
    );
  });
};

export interface RoleUnassignmentRequest extends PeopleCommandFacts {
  readonly assignment: Assignment;
  /** The delegation that created the assignment, when one did; its frozen limits are re-verified. */
  readonly delegation?: Delegation;
  /**
   * The delegation the acting manager leans on, with their membership fact, when they manage this
   * scope through one: they end only assignments of the roles and people their envelope names.
   */
  readonly manager?: {
    readonly delegation: Delegation;
    readonly managerIsMember: boolean;
  };
}

/** A delegated manager ends only what their live envelope could have assigned (P8, D10). */
const managerReachIssue = (
  assignment: Assignment,
  manager: NonNullable<RoleUnassignmentRequest['manager']>,
): Effect.Effect<void, PeopleCommandError> => {
  const { delegation } = manager;
  if (assignment.scopeId !== delegation.scopeId) {
    return Effect.fail(
      peopleRefusal('delegation_scope_mismatch', 'A delegated manager ends assignments of the delegation scope only'),
    );
  }
  const holder = personOf(assignment.holder);
  if (holder === delegation.managerId) {
    return Effect.fail(peopleRefusal('delegation_self_assignment', 'A delegate never manages their own roles'));
  }
  if (holder === undefined || !new Set(delegation.people).has(holder)) {
    return Effect.fail(
      peopleRefusal('delegation_holder_outside_envelope', 'The holder is outside the delegation people set'),
    );
  }
  if (!new Set(delegation.roleIds).has(assignment.roleId)) {
    return Effect.fail(
      peopleRefusal('delegation_role_outside_envelope', `Role ${assignment.roleId} is outside the delegation envelope`),
    );
  }
  return Effect.asVoid(Effect.mapError(assertDelegationLive(manager), toPeopleRefusal));
};

/**
 * Ends one assignment. The incarnation is never reused and the row never reopens; a delegated
 * assignment keeps the limits frozen at assignment time (D10b), so ending the delegation that
 * created it can never widen what this person holds.
 */
export const planRoleUnassignment = (
  request: RoleUnassignmentRequest,
): Effect.Effect<PeopleChangePlan, PeopleCommandError> => {
  const { assignment } = request;
  if (assignment.scopeId !== request.scopeId) {
    return Effect.fail(
      peopleRefusal(
        'people_assignment_scope_mismatch',
        `Assignment ${assignment.incarnationId} lives in scope ${assignment.scopeId}`,
      ),
    );
  }
  if (!assignmentIsLive(assignment, request.at)) {
    return Effect.fail(
      peopleRefusal(
        'people_assignment_already_ended',
        `Assignment ${assignment.incarnationId} is ${assignment.status} and never reopens`,
      ),
    );
  }
  const reach = request.manager === undefined ? Effect.void : managerReachIssue(assignment, request.manager);
  const bounded: Effect.Effect<void, PeopleCommandError> =
    request.delegation === undefined || assignment.delegated === undefined
      ? Effect.void
      : Effect.asVoid(
          Effect.mapError(
            assertDelegatedAssignmentStaysBounded({ assignment, delegation: request.delegation }),
            toPeopleRefusal,
          ),
        );
  return Effect.as(
    Effect.andThen(reach, bounded),
    planOf(
      { scopeId: request.scopeId, tenantId: request.tenantId },
      ['people_assignment_ends_only'],
      [{ _tag: 'EndAssignment', incarnationId: assignment.incarnationId }],
    ),
  );
};

/* ------------------------------------------------------------------------------------------------
 * Delegation: an exact, bounded, never-self, never-widening management envelope
 * ---------------------------------------------------------------------------------------------- */

/**
 * One grant the grantor holds for a capability: the mode and records it reaches and, for a capability that moves
 * money, its ceiling (none means uncapped). Each grant is its own alternative, as the decision engine
 * reads it: a narrow grant never hides a wider one, and one mode's limit never bounds another's.
 */
export interface GrantorAlternative {
  readonly amountCeiling?: AmountCeiling;
  readonly mode: AccessMode;
  readonly selector: CellSelector;
}

export interface DelegationGrantRequest extends PeopleCommandFacts {
  readonly catalog: readonly CatalogSnapshotEntry[];
  /** The cells of the roles the delegation lets its manager assign, as those roles stand now. */
  readonly delegatedCells?: readonly Cell[];
  readonly delegation: Delegation;
  /** Every grant the grantor holds, per capability key; checked against `delegatedCells` mode by mode. */
  readonly grantorAuthority?: ReadonlyMap<CatalogSnapshotEntry['key'], readonly GrantorAlternative[]>;
  /** The grantor's own capability keys, read from their live authority; a delegate never exceeds them. */
  readonly grantorCapabilityKeys: readonly CatalogSnapshotEntry['key'][];
  readonly managerAuthority: ManagerAuthority;
  readonly memberships: readonly AccessMembership[];
  readonly roles: readonly Role[];
  readonly scope: AccessScope;
}

/**
 * Creates one bounded delegation. Everything about it is exact: the people it reaches, the roles it
 * may assign, the capability keys it covers, the amount ceiling and the end date. A delegation is
 * granted by a person who holds what they hand out, never to itself, and never re-delegated (P8).
 */
/**
 * Why a delegation would let its manager hand out more than the grantor holds (D10b), if it would.
 * Every cell the delegated roles carry for a covered capability needs one of the grantor's grants for
 * that capability in the same mode, reaching every record the cell reaches. For a capability that
 * moves money, one such grant must also cover the delegation's ceiling: uncapped, or in the same
 * currency and at least as high. A delegation that names no ceiling is unlimited, so only an uncapped
 * grant covers it. The delegation's own ceiling is checked, never a cell's, because it bounds every
 * cell the delegate later assigns. A grant to propose therefore never lifts a ceiling on running, and
 * never stands in for running; a grant for one record never stands in for all of them.
 */
const beyondGrantorAuthority = (
  request: DelegationGrantRequest,
): 'delegation_amount_outside_envelope' | 'delegation_outside_grantor_authority' | undefined => {
  const { delegation, grantorAuthority } = request;
  if (grantorAuthority === undefined) {
    return undefined;
  }
  const moneyKeys = new Set(
    request.catalog.filter((entry) => entry.amountInput !== undefined).map((entry) => entry.key),
  );
  const envelope = new Set<string>(delegation.capabilityKeys);
  const { amountCeiling } = delegation;
  const issues = (request.delegatedCells ?? []).flatMap((cell) => {
    if (!envelope.has(cell.capabilityKey)) {
      return [];
    }
    const reaching = (grantorAuthority.get(cell.capabilityKey) ?? []).filter(
      (grant) => grant.mode === cell.mode && selectorCovers(grant.selector, cell.selector),
    );
    if (reaching.length === 0) {
      return ['delegation_outside_grantor_authority' as const];
    }
    const covered =
      !moneyKeys.has(cell.capabilityKey) || reaching.some((grant) => ceilingCovers(grant.amountCeiling, amountCeiling));
    return covered ? [] : ['delegation_amount_outside_envelope' as const];
  });
  return issues.find((issue) => issue === 'delegation_outside_grantor_authority') ?? issues[0];
};

export const planDelegationGrant = (
  request: DelegationGrantRequest,
): Effect.Effect<PeopleChangePlan, PeopleCommandError> => {
  const { delegation } = request;
  if (delegation.scopeId !== request.scopeId) {
    return Effect.fail(
      peopleRefusal('delegation_scope_mismatch', 'A delegation lives in the scope its envelope manages'),
    );
  }
  if (delegation.validUntil <= request.at) {
    return Effect.fail(
      peopleRefusal('people_delegation_end_missing', 'A delegation ends in the future, not at or before now'),
    );
  }
  // The grantor is the acting person, and the envelope is checked against what they hold; the manager
  // is the person receiving it, and `assertDelegationEnvelope` refuses the two being the same person.
  if (delegation.grantedBy !== request.actor) {
    return Effect.fail(
      peopleRefusal(
        'delegation_outside_grantor_authority',
        'A delegation is granted by the acting person; it is never attributed to somebody else',
      ),
    );
  }
  return Effect.gen(function* planDelegationGrantEffect() {
    yield* Effect.mapError(
      assertDelegationEnvelope({
        catalog: request.catalog,
        delegation,
        grantorCapabilityKeys: request.grantorCapabilityKeys,
        managerAuthority: request.managerAuthority,
        roles: request.roles,
        scope: request.scope,
      }),
      toPeopleRefusal,
    );
    // Checked after the envelope rule, so a delegate asking to re-delegate hears that rule first.
    const grantorIssue = beyondGrantorAuthority(request);
    if (grantorIssue !== undefined) {
      return yield* peopleRefusal(
        grantorIssue,
        grantorIssue === 'delegation_amount_outside_envelope'
          ? 'The delegation amount ceiling is outside the ceiling its grantor holds in that mode'
          : 'The delegation reaches a mode its grantor holds no grant in',
      );
    }
    yield* Effect.mapError(assertDelegationLive({ delegation, managerIsMember: true }), toPeopleRefusal);
    yield* requireLiveMember({
      at: request.at,
      holder: delegation.managerId,
      memberships: request.memberships,
      scopeId: request.scopeId,
    });
    yield* Effect.forEach(
      delegation.people,
      (person) =>
        requireLiveMember({
          at: request.at,
          holder: person,
          memberships: request.memberships,
          scopeId: request.scopeId,
        }),
      { concurrency: 1, discard: true },
    );
    return planOf(
      { scopeId: request.scopeId, tenantId: request.tenantId },
      ['people_delegation_envelope_exact', 'people_delegation_people_are_members'],
      [{ _tag: 'RecordDelegation', delegation }],
    );
  });
};

export interface DelegationRevocationRequest extends PeopleCommandFacts {
  readonly assignments: readonly Assignment[];
  readonly delegation: Delegation;
  /** How the acting person manages the scope; only permanent authority manages delegations (P8). */
  readonly managerAuthority: ManagerAuthority;
}

/**
 * Ends one delegation. The assignments it created stay exactly as bound: each keeps the frozen
 * envelope it was written with, so revoking management authority never silently widens or narrows
 * the authority somebody already holds (D10, D10b).
 */
export const planDelegationRevocation = (
  request: DelegationRevocationRequest,
): Effect.Effect<PeopleChangePlan, PeopleCommandError> => {
  const { delegation } = request;
  if (delegation.scopeId !== request.scopeId) {
    return Effect.fail(
      peopleRefusal('delegation_scope_mismatch', 'A delegation lives in the scope its envelope manages'),
    );
  }
  if (request.managerAuthority === 'delegated') {
    return Effect.fail(
      peopleRefusal('delegation_redelegation', 'Only permanent authority manages delegations; a delegate never does'),
    );
  }
  if (delegation.status !== 'active') {
    return Effect.fail(
      peopleRefusal('delegation_not_live', `Delegation ${delegation.id} is ${delegation.status} and never reopens`),
    );
  }
  const created = request.assignments.filter((assignment) => assignment.delegated?.delegationId === delegation.id);
  const unbounded = created.find(
    (assignment) =>
      assignment.delegated === undefined ||
      assignment.validUntil === undefined ||
      assignment.validUntil > assignment.delegated.until ||
      // Persisted dates are decoded apart, so the same instant is two objects: compare the instants.
      assignment.delegated.until.getTime() !== delegation.validUntil.getTime(),
  );
  return unbounded === undefined
    ? Effect.succeed(
        planOf(
          { scopeId: request.scopeId, tenantId: request.tenantId },
          ['people_delegation_limits_frozen'],
          [{ _tag: 'EndDelegation', delegationId: delegation.id }],
        ),
      )
    : Effect.fail(
        peopleRefusal(
          'delegation_limits_lost',
          `Assignment ${unbounded.incarnationId} no longer matches the envelope of delegation ${delegation.id}`,
        ),
      );
};

/* ------------------------------------------------------------------------------------------------
 * Team membership: the record scope of the `team` selector (O24)
 * ---------------------------------------------------------------------------------------------- */

export interface TeamMembershipRequest extends PeopleCommandFacts {
  readonly action: 'join' | 'leave';
  readonly holder: Holder;
  /**
   * How the acting person manages the scope. A team place widens the record reach of every role its
   * holder has, which no delegation envelope bounds, so only permanent authority changes one.
   */
  readonly managerAuthority: ManagerAuthority;
  readonly memberId: AccessTeamMemberId;
  readonly memberships: readonly AccessMembership[];
  readonly team: AccessTeam;
  readonly teamMembers: readonly AccessTeamMember[];
}

/**
 * Adds or removes one person's place in one team. A team is the record scope of the `team` selector,
 * so its membership reaches only its own scope's records, and only a live member of that scope may
 * hold it (O24).
 */
export const planTeamMembership = (
  request: TeamMembershipRequest,
): Effect.Effect<PeopleChangePlan, PeopleCommandError> => {
  const principal = principalOf(request.holder);
  if (Option.isNone(principal)) {
    return Effect.fail(
      peopleRefusal('people_agent_holder_forbidden', 'An agent holds no team place in this wave (O67-Q5)'),
    );
  }
  if (request.team.scopeId !== request.scopeId) {
    return Effect.fail(
      peopleRefusal(
        'people_team_scope_mismatch',
        `Team ${request.team.name} lives in scope ${request.team.scopeId}, not ${request.scopeId}`,
      ),
    );
  }
  if (request.managerAuthority === 'delegated') {
    return Effect.fail(
      peopleRefusal('people_authority_missing', 'A delegation manages role assignments, never team places'),
    );
  }
  const holder = Option.getOrThrow(principal);
  return requireLiveMember({
    at: request.at,
    holder,
    memberships: request.memberships,
    scopeId: request.scopeId,
  }).pipe(
    Effect.flatMap(() => {
      const held = request.teamMembers.filter(
        (member) => member.teamId === request.team.id && personOf(member.holder) === holder,
      );
      if (request.action === 'join') {
        return held.length > 0
          ? Effect.fail(
              peopleRefusal(
                'people_team_membership_exists',
                `Person ${holder} is already a member of team ${request.team.name}`,
              ),
            )
          : Effect.succeed(
              planOf(
                { scopeId: request.scopeId, tenantId: request.tenantId },
                ['people_team_place_added'],
                [
                  {
                    _tag: 'RecordTeamMember',
                    member: {
                      addedAt: request.at,
                      addedBy: request.actor,
                      holder: { _tag: 'Principal', principalId: holder },
                      id: request.memberId,
                      teamId: request.team.id,
                      tenantId: request.tenantId,
                    },
                  },
                ],
              ),
            );
      }
      const [first, ...rest] = held;
      return first === undefined || rest.length > 0
        ? Effect.fail(
            peopleRefusal(
              'people_team_membership_unknown',
              `Person ${holder} holds no single live place in team ${request.team.name}`,
            ),
          )
        : Effect.succeed(
            planOf(
              { scopeId: request.scopeId, tenantId: request.tenantId },
              ['people_team_place_removed'],
              [{ _tag: 'RemoveTeamMember', teamMemberId: first.id }],
            ),
          );
    }),
  );
};

/* ------------------------------------------------------------------------------------------------
 * Ownership transfer: the one way past the last-administrator refusal (O53, O65)
 * ---------------------------------------------------------------------------------------------- */

/** Every scope the leaver alone administers right now: the tenant's own, and each such company. */
export const soleAdministrationScopeIds = (request: {
  readonly administration: ScopeAdministration;
  readonly at: Date;
  readonly principalId: PrincipalId;
}): readonly AccessScopeId[] => {
  const scopeIds = [
    request.administration.tenantScopeId,
    ...request.administration.scopeAdministrators.map((row) => row.scopeId),
  ];
  const sole: AccessScopeId[] = [];
  for (const scopeId of scopeIds) {
    if (
      isSoleAdministrator({
        administration: request.administration,
        at: request.at,
        principalId: request.principalId,
        scopeId,
      })
    ) {
      sole.push(scopeId);
    }
  }
  return sole;
};

/** The live members who could take over every named scope, so a surface names a successor, never invents one. */
export const ownershipTransferCandidates = (request: {
  readonly at: Date;
  readonly leaver: PrincipalId;
  readonly memberships: readonly AccessMembership[];
  readonly scopeIds: readonly AccessScopeId[];
}): readonly PrincipalId[] => {
  const people = new Set<PrincipalId>();
  for (const membership of request.memberships) {
    const person = personOf(membership.holder);
    if (person === undefined || person === request.leaver) {
      continue;
    }
    const memberOfEveryScope = request.scopeIds.every(
      (scopeId) =>
        liveMembershipOf({
          at: request.at,
          holder: person,
          kind: 'member',
          memberships: request.memberships,
          scopeId,
        }) !== undefined,
    );
    if (memberOfEveryScope) {
      people.add(person);
    }
  }
  return [...people];
};

export interface OwnershipTransferRequest extends PeopleCommandFacts {
  readonly administration: ScopeAdministration;
  readonly assignments: readonly Assignment[];
  readonly from: PrincipalId;
  /** One id per transferred scope: the successor's management membership rows are minted, never reused. */
  readonly membershipIds: readonly AccessMembershipId[];
  readonly memberships: readonly AccessMembership[];
  /** Every scope whose administration transfers; the caller cannot name a subset (O65). */
  readonly scopeIds: readonly AccessScopeId[];
  readonly successor: PrincipalId;
}

/**
 * Transfers every administration the leaver alone holds, in one command. O65 is why the scope list is
 * not optional: leaving a tenant ends every company membership there, so the leaver's sole
 * administration of each of those companies transfers too — all of it, or none of it. The successor
 * gains the management membership of each scope in the same plan, so the scope is never left
 * unadministered, not even for one committed instant.
 */
export const planOwnershipTransfer = (
  request: OwnershipTransferRequest,
): Effect.Effect<PeopleChangePlan, PeopleCommandError> => {
  const [firstScopeId] = request.scopeIds;
  if (firstScopeId === undefined) {
    return Effect.fail(
      peopleRefusal('people_transfer_scope_missing', 'A transfer names at least one administration to transfer'),
    );
  }
  if (request.from === request.successor) {
    return Effect.fail(peopleRefusal('ownership_transfer_self', 'The successor of a transfer is somebody else'));
  }
  const sole = soleAdministrationScopeIds({
    administration: request.administration,
    at: request.at,
    principalId: request.from,
  });
  const missing = sole.filter((scopeId) => !request.scopeIds.some((named) => named === scopeId));
  if (missing.length > 0) {
    return Effect.fail(
      peopleRefusal(
        'ownership_transfer_required',
        'A transfer covers every scope the leaver alone administers, in the same command',
        missing,
      ),
    );
  }
  const extra = request.scopeIds.filter((scopeId) => !sole.some((owned) => owned === scopeId));
  if (extra.length > 0) {
    return Effect.fail(
      peopleRefusal(
        'ownership_transfer_not_required',
        'The leaver does not alone administer every scope this transfer names',
        extra,
      ),
    );
  }
  const notAMember = request.scopeIds.find(
    (scopeId) =>
      liveMembershipOf({
        at: request.at,
        holder: request.successor,
        kind: 'member',
        memberships: request.memberships,
        scopeId,
      }) === undefined,
  );
  if (notAMember !== undefined) {
    return Effect.fail(
      peopleRefusal(
        'people_successor_not_a_member',
        `Person ${request.successor} is not a live member of scope ${notAMember}`,
        [notAMember],
      ),
    );
  }
  const [firstId] = request.membershipIds;
  if (firstId === undefined) {
    return Effect.fail(
      peopleRefusal('people_transfer_scope_missing', 'A transfer mints one membership id per scope it transfers'),
    );
  }
  const successorKind = (scopeId: AccessScopeId): MembershipKind =>
    scopeId === request.administration.tenantScopeId ? 'owner' : 'access_admin';
  const granted: readonly PeopleIntentWrite[] = request.scopeIds.map((scopeId, index) => ({
    _tag: 'RecordMembership' as const,
    membership: {
      createdAt: request.at,
      holder: { _tag: 'Principal' as const, principalId: request.successor },
      id: request.membershipIds[index] ?? firstId,
      kind: successorKind(scopeId),
      recordedBy: request.actor,
      scopeId,
      status: 'active' as const,
      tenantId: request.tenantId,
      validFrom: request.at,
    },
  }));
  const ended: PeopleIntentWrite[] = [];
  for (const membership of request.memberships) {
    const carried =
      membership.status === 'active' &&
      personOf(membership.holder) === request.from &&
      membership.kind !== 'member' &&
      request.scopeIds.some((scopeId) => scopeId === membership.scopeId);
    if (carried) {
      ended.push({ _tag: 'EndMembership', membershipId: membership.id, status: 'revoked' });
    }
  }
  const assignmentEnds: PeopleIntentWrite[] = [];
  for (const assignment of request.assignments) {
    const carried =
      assignmentIsLive(assignment, request.at) &&
      personOf(assignment.holder) === request.from &&
      request.scopeIds.some((scopeId) => scopeId === assignment.scopeId);
    if (carried) {
      assignmentEnds.push({ _tag: 'EndAssignment', incarnationId: assignment.incarnationId });
    }
  }
  return Effect.succeed(
    planOf(
      { scopeId: firstScopeId, tenantId: request.tenantId },
      [
        'people_ownership_successor_named',
        'people_ownership_transfer_complete',
        'people_ownership_scope_never_unadministered',
      ],
      [...granted, ...ended, ...assignmentEnds],
    ),
  );
};

/** One command may combine plans (a transfer already does); they must agree on scope and tenant. */
export const combinePeopleChangePlans = (
  plans: readonly PeopleChangePlan[],
): Effect.Effect<PeopleChangePlan, PeopleCommandError> => {
  const [first, ...rest] = plans;
  if (first === undefined) {
    return Effect.fail(
      peopleRefusal('people_transfer_scope_missing', 'A people change needs at least one planned row'),
    );
  }
  const disagreeing = rest.find(
    (candidate) => candidate.scopeId !== first.scopeId || candidate.tenantId !== first.tenantId,
  );
  return disagreeing === undefined
    ? Effect.succeed({
        checks: [...new Set(plans.flatMap((candidate) => candidate.checks))],
        scopeId: first.scopeId,
        tenantId: first.tenantId,
        writes: plans.flatMap((candidate) => candidate.writes),
      })
    : Effect.fail(
        peopleRefusal(
          'people_membership_scope_mismatch',
          `A combined change stays in one scope and tenant; ${disagreeing.scopeId} is another scope`,
        ),
      );
};
