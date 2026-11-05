import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Context, DateTime, Effect, Layer, Match, Option, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import type { OperationalScope } from '../../operations/context.ts';
import { delegationIsLive } from '../changes/authority.ts';
import type { AccessConfigureBasis } from '../changes/authority.ts';
import { AccessScopeIdSchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import type {
  AccessScopeId,
  AssignmentIncarnationId,
  DelegationId,
  PrincipalId,
  RoleId,
  RoleRevisionId,
  TenantId,
} from '../ids.ts';
import { delegatedCellCeiling } from '../intent/delegated-cell.ts';
import { AccessMembershipStore } from '../intent/memberships.ts';
import type { AccessMembership, AccessMembershipId } from '../intent/memberships.ts';
import { AccessPeopleStore } from '../intent/people-store.ts';
import type { AccessPeopleIntent, AccessRoleWithRevision, TenantScopeRow } from '../intent/people-store.ts';
import { AccessProjectionWriter } from '../intent/projection-writer.ts';
import { AccessTeamStore } from '../intent/teams.ts';
import { TenantIntentLoader } from '../intent/tenant-intent-loader.ts';
import type { TenantIntentLoaderService } from '../intent/tenant-intent-loader.ts';
import type { AccessTeamMember, AccessTeamMemberId, AccessTeamWithMembers } from '../intent/teams.ts';
import type {
  AccessScope,
  AmountCeiling,
  Assignment,
  CatalogSnapshotEntry,
  Cell,
  Delegation,
  Holder,
} from '../model.ts';
import { AmountCeilingSchema } from '../model.ts';
import type { ManagerAuthority } from './delegation.ts';
import type {
  GrantorAlternative,
  PeopleChangePlan,
  PeopleCommandError,
  PeopleIntentWrite,
  RoleAssignmentRequest,
} from './people-commands.ts';
import {
  membershipIsLive,
  planDelegationGrant,
  planDelegationRevocation,
  planOwnershipTransfer,
  planRoleAssignment,
  planRoleUnassignment,
  planTeamMembership,
} from './people-commands.ts';
import type { OwnerRecord, ScopeAdministration } from './owners.ts';

/*
 * The people command service: the seam the access-administration BFF calls. It owns the composition a
 * pure planner cannot own — read the tenant's people intent, plan the change, persist every row of it
 * in one transaction, then let the one projection writer reconcile and verify the tenant (D9, D15,
 * D24). The rules themselves stay in `people-commands.ts`; this module never decides one.
 *
 * The write order follows the repository's one role-revision writer: intent first, then the
 * projection under the tenant fence. A failure after the intent commit is repaired by retrying the
 * same command, because intent rows are immutable and reconciling already-projected intent writes
 * nothing.
 */

/**
 * A wire money ceiling as the model's anchored value (one currency, an inclusive minor-unit limit).
 * A ceiling the model refuses stays `None`, so a surface refuses it instead of passing a loose shape
 * into an envelope that a decision engine will later read.
 */
export const delegationCeilingOf = (input: {
  readonly currency: string;
  readonly limitMinor: number;
}): Option.Option<AmountCeiling> =>
  Result.match(Schema.decodeResult(AmountCeilingSchema)(input), {
    onFailure: () => Option.none<AmountCeiling>(),
    onSuccess: (decoded) => Option.some(decoded),
  });

/** A refused people command, as the BFF maps it: a rule code, the record and any scope a transfer owes. */
export const PeopleCommandFailureSchema = Schema.Struct({
  code: Schema.String,
  reason: Schema.String,
  scopeIds: Schema.optionalKey(Schema.Array(AccessScopeIdSchema)),
});
export type PeopleCommandFailure = typeof PeopleCommandFailureSchema.Type;

export const peopleFailure = (
  code: string,
  reason: string,
  scopeIds?: readonly AccessScopeId[],
): PeopleCommandFailure => (scopeIds === undefined ? { code, reason } : { code, reason, scopeIds: [...scopeIds] });

const peopleErrorOf = (error: PeopleCommandError): PeopleCommandFailure =>
  peopleFailure(error.code, error.reason, error.scopeIds);

const storeFailureOf = (error: { readonly code: string; readonly reason: string }): PeopleCommandFailure =>
  peopleFailure(error.code, error.reason);

/** A refusal as the effect a generator can yield: the failure, never an exception. */
const refuse = (
  code: string,
  reason: string,
  scopeIds?: readonly AccessScopeId[],
): Effect.Effect<never, PeopleCommandFailure> => Effect.fail(peopleFailure(code, reason, scopeIds));

/** Everything one people read answers, and the token every mutation echoes back. */
export interface AccessPeopleView {
  readonly administration: ScopeAdministration;
  readonly assignments: readonly Assignment[];
  readonly at: Date;
  readonly delegations: readonly Delegation[];
  readonly memberships: readonly AccessMembership[];
  /** Changes exactly when the tenant's people intent changes; a stale echo is refused by the BFF. */
  readonly revision: string;
  readonly roles: readonly AccessRoleWithRevision[];
  readonly scopes: readonly TenantScopeRow[];
  readonly teams: readonly AccessTeamWithMembers[];
  readonly tenantScopeId: AccessScopeId;
}

const principalOf = (holder: Holder): Option.Option<PrincipalId> =>
  Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }) => Option.some(principalId)),
    Match.orElse(() => Option.none<PrincipalId>()),
  );

/** The administration facts the owner rules read, derived from the tenant's own membership intent. */
export const administrationOf = (
  memberships: readonly AccessMembership[],
  tenantScopeId: AccessScopeId,
): ScopeAdministration => {
  const tenantOwners: OwnerRecord[] = [];
  const byScope = new Map<AccessScopeId, OwnerRecord[]>();
  for (const membership of memberships) {
    const principalId = Option.getOrUndefined(principalOf(membership.holder));
    const manages = membership.kind !== 'member' && membership.status !== 'revoked' && principalId !== undefined;
    if (manages && principalId !== undefined) {
      const status = membership.status === 'suspended' ? ('suspended' as const) : ('active' as const);
      const record: OwnerRecord =
        membership.validUntil === undefined
          ? { principalId, status }
          : { membershipValidUntil: membership.validUntil, principalId, status };
      if (membership.kind === 'owner') {
        tenantOwners.push(record);
      } else {
        const held = byScope.get(membership.scopeId) ?? [];
        held.push(record);
        byScope.set(membership.scopeId, held);
      }
    }
  }
  return {
    scopeAdministrators: [...byScope].map(([scopeId, administrators]) => ({ administrators, scopeId })),
    tenantOwners,
    tenantScopeId,
  };
};

/**
 * The revision token of one people read: a digest of the intent a screen acts on, so a stale form is
 * refused instead of overwriting a change somebody else already made.
 */
const revisionOf = (intent: {
  readonly assignments: readonly Assignment[];
  readonly delegations: readonly Delegation[];
  readonly memberships: readonly AccessMembership[];
  readonly teamMembers: readonly AccessTeamMember[];
}): string => {
  const lines = [
    ...intent.memberships.map(
      (membership) =>
        `membership ${membership.id} ${membership.kind} ${membership.status} ${membership.validFrom.toISOString()}`,
    ),
    ...intent.assignments.map(
      (assignment) => `assignment ${assignment.incarnationId} ${assignment.status} ${assignment.roleRevisionId}`,
    ),
    ...intent.delegations.map((delegation) => `delegation ${delegation.id} ${delegation.status}`),
    ...intent.teamMembers.map((member) => `team ${member.teamId} ${member.id}`),
  ].toSorted((left, right) => left.localeCompare(right));
  return Hex.encode(sha256(utf8ToBytes(lines.join('\n'))));
};

const tenantOf = (scope: OperationalScope): TenantId => TenantIdSchema.make(scope.tenantId);
const actorOf = (scope: OperationalScope): PrincipalId => PrincipalIdSchema.make(scope.principalId);

/** The v2 scope one access scope id names: the tenant context, or exactly one company. */
const accessScopeOf = (view: AccessPeopleView, scopeId: AccessScopeId, tenantId: TenantId): AccessScope => {
  const row = view.scopes.find((candidate) => candidate.scopeId === scopeId);
  return row === undefined || row.legalEntityId === undefined
    ? { _tag: 'TenantContext', tenantId }
    : { _tag: 'LegalEntity', legalEntityId: row.legalEntityId, tenantId };
};

const assignmentIsLive = (assignment: Assignment, at: Date): boolean =>
  assignment.status === 'active' &&
  assignment.validFrom <= at &&
  (assignment.validUntil === undefined || at < assignment.validUntil);

/**
 * What one person holds right now in one scope, as a delegation envelope there may never exceed it
 * (D10b). Only assignments of that exact scope count, as the gate reads them: authority held in another
 * company, or in the tenant context, is not authority in this one.
 */
const authorityOf = (
  view: AccessPeopleView,
  catalog: readonly CatalogSnapshotEntry[],
  principalId: PrincipalId,
  scopeId: AccessScopeId,
) => {
  const revisions = new Map(view.roles.map((entry) => [entry.revision.id, entry] as const));
  const delegations = new Map(view.delegations.map((delegation) => [delegation.id, delegation] as const));
  const moneyKeys = new Set(catalog.filter((entry) => entry.amountInput !== undefined).map((entry) => entry.key));
  const capabilityKeys = new Set<CatalogSnapshotEntry['key']>();
  const grants = new Map<CatalogSnapshotEntry['key'], GrantorAlternative[]>();
  // Every grant is kept as its own alternative, with its mode: one capability's or one mode's limit
  // never bounds another's, and a narrow grant never hides a wider one.
  const hold = (cell: Cell, cellCeiling: AmountCeiling | undefined) => {
    capabilityKeys.add(cell.capabilityKey);
    const grant: GrantorAlternative =
      cellCeiling === undefined || !moneyKeys.has(cell.capabilityKey)
        ? { mode: cell.mode }
        : { amountCeiling: cellCeiling, mode: cell.mode };
    grants.set(cell.capabilityKey, [...(grants.get(cell.capabilityKey) ?? []), grant]);
  };
  for (const assignment of view.assignments) {
    const mine =
      assignment.scopeId === scopeId &&
      assignmentIsLive(assignment, view.at) &&
      Option.getOrUndefined(principalOf(assignment.holder)) === principalId;
    const entry = mine ? revisions.get(assignment.roleRevisionId) : undefined;
    if (entry === undefined) {
      continue;
    }
    const { delegated } = assignment;
    const delegation = delegated === undefined ? undefined : delegations.get(delegated.delegationId);
    for (const cell of entry.revision.cells) {
      if (delegated === undefined) {
        hold(cell, cell.amountCeiling);
      } else if (delegation !== undefined && delegationIsLive(delegation, view.at) && view.at < delegated.until) {
        // A delegated cell grants only what the decision loader would read for it: nothing once its
        // delegation ends, and only inside the envelope, under its ceiling.
        const bounded = delegatedCellCeiling({
          amountGoverned: moneyKeys.has(cell.capabilityKey),
          cell,
          delegation,
          frozen: delegated,
          holder: assignment.holder,
          roleId: entry.role.id,
        });
        if (Result.isSuccess(bounded)) {
          hold(cell, Option.getOrUndefined(bounded.success));
        }
      }
    }
  }
  return { capabilityKeys: [...capabilityKeys], grants };
};

const assignmentOfPlan = (planned: PeopleChangePlan): Option.Option<Assignment> =>
  Option.fromUndefinedOr(
    planned.writes.flatMap((write: PeopleIntentWrite) =>
      Match.value(write).pipe(
        Match.tag('RecordAssignment', ({ assignment }) => [assignment]),
        Match.orElse((): readonly Assignment[] => []),
      ),
    )[0],
  );

/** One live delegation of the acting person, with their membership fact in its scope. */
interface DelegatedManagement {
  readonly delegation: Delegation;
  readonly managerIsMember: boolean;
}

/**
 * How the acting person manages one scope: `None` is permanent management power (an owner, or the
 * scope's own administrator); `Some` is one live delegation of that exact scope.
 */
type ManagementBasis = Option.Option<DelegatedManagement>;

const managerAuthorityOf = (basis: ManagementBasis): ManagerAuthority =>
  Option.match(basis, { onNone: () => 'permanent' as const, onSome: () => 'delegated' as const });

/** Whether a person's own operational membership in one scope is live right now. */
const isLiveMemberOf = (view: AccessPeopleView, principalId: PrincipalId, scopeId: AccessScopeId): boolean =>
  view.memberships.some(
    (membership) =>
      membership.scopeId === scopeId &&
      membership.kind === 'member' &&
      Option.getOrUndefined(principalOf(membership.holder)) === principalId &&
      membershipIsLive(membership, view.at),
  );

/** Whether a company administrator's live administration reaches one scope (O28, O81). */
const administrationReaches = (
  administration: Extract<AccessConfigureBasis, { readonly _tag: 'ScopeAdmin' }>,
  target: AccessScope,
  at: Date,
): boolean =>
  Match.value(target).pipe(
    Match.tags({
      LegalEntity: ({ legalEntityId }) => {
        const deadline = administration.deadlines?.find((one) => one.legalEntityId === legalEntityId)?.until;
        return (
          new Set<string>(administration.legalEntityIds).has(legalEntityId) && (deadline === undefined || at < deadline)
        );
      },
      TenantContext: () => administration.tenantContext,
    }),
    Match.exhaustive,
  );

/**
 * The configure bases (the gate's and Novinky's one source, O81) that reach one scope, most
 * authoritative first. An owner reaches every scope and a company administrator their live companies;
 * a delegated manager reaches only the scope of a delegation that is still live.
 */
const managementBasesIn = (input: {
  readonly actor: PrincipalId;
  readonly bases: readonly AccessConfigureBasis[];
  readonly scopeId: AccessScopeId;
  readonly target: AccessScope;
  readonly view: AccessPeopleView;
}): readonly ManagementBasis[] => {
  const { at } = input.view;
  const permanent = input.bases.some((basis) =>
    Match.value(basis).pipe(
      Match.tags({
        DelegatedManager: () => false,
        Owner: () => true,
        ScopeAdmin: (administration) => administrationReaches(administration, input.target, at),
      }),
      Match.exhaustive,
    ),
  );
  const delegated = input.bases.flatMap((basis): readonly ManagementBasis[] =>
    Match.value(basis).pipe(
      Match.tag('DelegatedManager', ({ delegation }) =>
        delegation.scopeId === input.scopeId && delegationIsLive(delegation, at)
          ? [Option.some({ delegation, managerIsMember: isLiveMemberOf(input.view, input.actor, delegation.scopeId) })]
          : [],
      ),
      Match.orElse(() => []),
    ),
  );
  return permanent ? [Option.none(), ...delegated] : delegated;
};

/**
 * The first plan any reaching basis accepts, tried most authoritative first as Novinky does; the first
 * refusal when none does. A person with no basis in the scope manages nothing there.
 */
const firstAcceptedPlan = (
  bases: readonly ManagementBasis[],
  plan: (basis: ManagementBasis) => Effect.Effect<PeopleChangePlan, PeopleCommandError>,
  refused?: PeopleCommandError,
): Effect.Effect<PeopleChangePlan, PeopleCommandFailure> => {
  const [basis, ...rest] = bases;
  if (basis === undefined) {
    return refused === undefined
      ? refuse('people_authority_missing', 'The acting person manages nothing in this scope')
      : Effect.fail(peopleErrorOf(refused));
  }
  return plan(basis).pipe(
    Effect.catchTag('PeopleCommandError', (refusal) => firstAcceptedPlan(rest, plan, refused ?? refusal)),
  );
};

export interface AssignRoleCommand {
  readonly incarnationId: AssignmentIncarnationId;
  readonly principalId: PrincipalId;
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
  readonly scopeId: AccessScopeId;
  readonly validUntil?: Date;
}

export interface UnassignRoleCommand {
  readonly incarnationId: AssignmentIncarnationId;
}

export interface TeamMembershipCommand {
  readonly action: 'join' | 'leave';
  readonly memberId: AccessTeamMemberId;
  readonly principalId: PrincipalId;
  readonly teamId: string;
}

export interface GrantDelegationCommand {
  /** The wire ceiling (currency code + inclusive limit); the service decodes it against the model. */
  readonly amountCeiling?: { readonly currency: string; readonly limitMinor: number };
  readonly capabilityKeys: readonly CatalogSnapshotEntry['key'][];
  readonly delegationId: DelegationId;
  readonly managerId: PrincipalId;
  readonly people: readonly PrincipalId[];
  readonly roleIds: readonly RoleId[];
  readonly scopeId: AccessScopeId;
  readonly validUntil: Date;
}

export interface RevokeDelegationCommand {
  readonly delegationId: DelegationId;
}

export interface TransferOwnershipCommand {
  readonly fromPrincipalId: PrincipalId;
  readonly membershipIds: readonly AccessMembershipId[];
  readonly scopeIds: readonly AccessScopeId[];
  readonly toPrincipalId: PrincipalId;
}

/** What a write answers: the token a screen re-reads with, and the row it changed. */
export interface PeopleCommandReceipt {
  readonly assignment?: Assignment;
  readonly delegation?: Delegation;
  readonly revision: string;
  readonly transferredScopeIds?: readonly AccessScopeId[];
}

export interface AccessPeopleCommandsService {
  readonly assignRole: (
    scope: OperationalScope,
    command: AssignRoleCommand,
  ) => Effect.Effect<PeopleCommandReceipt, PeopleCommandFailure>;
  readonly grantDelegation: (
    scope: OperationalScope,
    command: GrantDelegationCommand,
  ) => Effect.Effect<PeopleCommandReceipt, PeopleCommandFailure>;
  readonly read: (scope: OperationalScope) => Effect.Effect<AccessPeopleView, PeopleCommandFailure>;
  /** The published release, so a form offers exactly the capabilities, risks and money inputs it has. */
  readonly readCatalog: (
    scope: OperationalScope,
  ) => Effect.Effect<readonly CatalogSnapshotEntry[], PeopleCommandFailure>;
  /**
   * Projects the tenant's committed intent again. A write commits before it reconciles, so one whose
   * reconcile failed is already in intent: its retry is refused as stale, and the caller converges the
   * projection here instead of waiting for an unrelated write to do it.
   */
  readonly reconcile: (scope: OperationalScope) => Effect.Effect<void, PeopleCommandFailure>;
  readonly revokeDelegation: (
    scope: OperationalScope,
    command: RevokeDelegationCommand,
  ) => Effect.Effect<PeopleCommandReceipt, PeopleCommandFailure>;
  readonly setTeamMembership: (
    scope: OperationalScope,
    command: TeamMembershipCommand,
  ) => Effect.Effect<PeopleCommandReceipt, PeopleCommandFailure>;
  readonly transferOwnership: (
    scope: OperationalScope,
    command: TransferOwnershipCommand,
  ) => Effect.Effect<PeopleCommandReceipt, PeopleCommandFailure>;
  readonly unassignRole: (
    scope: OperationalScope,
    command: UnassignRoleCommand,
  ) => Effect.Effect<PeopleCommandReceipt, PeopleCommandFailure>;
}

export class AccessPeopleCommands extends Context.Service<AccessPeopleCommands, AccessPeopleCommandsService>()(
  '@app/core-runtime/access/lifecycle/people-service/AccessPeopleCommands',
) {}

interface LoadedPeopleIntent {
  readonly intent: AccessPeopleIntent;
  readonly memberships: readonly AccessMembership[];
  readonly teams: readonly AccessTeamWithMembers[];
  readonly tenantScopeId: AccessScopeId;
}

export const makeAccessPeopleCommands = (dependencies: {
  readonly loader: Pick<TenantIntentLoaderService, 'loadConfigureBases'>;
  readonly memberships: Effect.Success<typeof AccessMembershipStore>;
  readonly people: Effect.Success<typeof AccessPeopleStore>;
  readonly projection: Effect.Success<typeof AccessProjectionWriter>;
  readonly teams: Effect.Success<typeof AccessTeamStore>;
}): AccessPeopleCommandsService => {
  const { loader, memberships: membershipStore, people: peopleStore, projection, teams: teamStore } = dependencies;

  const loadIntent = Effect.fn('accessPeopleCommands.loadIntent')(function* loadIntentEffect(
    scope: OperationalScope,
  ): Effect.fn.Return<LoadedPeopleIntent, PeopleCommandFailure> {
    const [loadedMemberships, intent, loadedTeams] = yield* Effect.all(
      [
        membershipStore.loadTenantMemberships(scope),
        peopleStore.loadTenantPeople(scope),
        teamStore.loadTenantTeams(scope),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(storeFailureOf));
    const tenantScope = intent.scopes.find((candidate) => candidate.tenantContextId !== undefined);
    if (tenantScope === undefined) {
      return yield* refuse(
        'people_tenant_scope_missing',
        `Tenant ${scope.tenantId} has no tenant-context access scope, so no administration exists`,
      );
    }
    return { intent, memberships: loadedMemberships, teams: loadedTeams, tenantScopeId: tenantScope.scopeId };
  });

  const read = Effect.fn('accessPeopleCommands.read')(function* readPeopleEffect(
    scope: OperationalScope,
  ): Effect.fn.Return<AccessPeopleView, PeopleCommandFailure> {
    const loaded = yield* loadIntent(scope);
    return {
      administration: administrationOf(loaded.memberships, loaded.tenantScopeId),
      assignments: loaded.intent.assignments,
      at: yield* DateTime.nowAsDate,
      delegations: loaded.intent.delegations,
      memberships: loaded.memberships,
      revision: revisionOf({
        assignments: loaded.intent.assignments,
        delegations: loaded.intent.delegations,
        memberships: loaded.memberships,
        teamMembers: loaded.teams.flatMap((entry) => entry.members),
      }),
      roles: loaded.intent.roles,
      scopes: loaded.intent.scopes,
      teams: loaded.teams,
      tenantScopeId: loaded.tenantScopeId,
    };
  });

  const readCatalog = Effect.fn('accessPeopleCommands.readCatalog')(function* readCatalogEffect(
    scope: OperationalScope,
  ): Effect.fn.Return<readonly CatalogSnapshotEntry[], PeopleCommandFailure> {
    const catalog = yield* peopleStore.loadCatalogSnapshot(scope).pipe(Effect.mapError(storeFailureOf));
    return Option.match(catalog, {
      onNone: () => [],
      onSome: (snapshot) => snapshot.entries,
    });
  });

  const reconcile = (scope: OperationalScope) =>
    projection.reconcileTenant({ scope }).pipe(Effect.asVoid, Effect.mapError(storeFailureOf));

  /** Persist one plan in a single transaction, then reconcile and verify the tenant (D9, D24). */
  const applyPlan = (scope: OperationalScope, planned: PeopleChangePlan) =>
    peopleStore
      .applyPeopleChange(scope, { writes: planned.writes })
      .pipe(Effect.mapError(storeFailureOf), Effect.andThen(reconcile(scope)));

  /** How the acting person reaches one scope of the view they act on, read from live intent. */
  const basesIn = Effect.fn('accessPeopleCommands.basesIn')(function* basesInEffect(
    scope: OperationalScope,
    view: AccessPeopleView,
    scopeId: AccessScopeId,
  ): Effect.fn.Return<readonly ManagementBasis[], PeopleCommandFailure> {
    const actor = actorOf(scope);
    const tenantId = tenantOf(scope);
    const bases = yield* loader
      .loadConfigureBases(scope, { actor, at: view.at, tenantId })
      .pipe(Effect.mapError(storeFailureOf));
    return managementBasesIn({ actor, bases, scopeId, target: accessScopeOf(view, scopeId, tenantId), view });
  });

  const receipt = (scope: OperationalScope, extra: Omit<PeopleCommandReceipt, 'revision'>) =>
    read(scope).pipe(Effect.map((view): PeopleCommandReceipt => ({ ...extra, revision: view.revision })));

  const assignRole = Effect.fn('accessPeopleCommands.assignRole')(function* assignRoleEffect(
    scope: OperationalScope,
    command: AssignRoleCommand,
  ): Effect.fn.Return<PeopleCommandReceipt, PeopleCommandFailure> {
    const view = yield* read(scope);
    const chosen = view.roles.find(
      (candidate) => candidate.role.id === command.roleId && candidate.revision.id === command.roleRevisionId,
    );
    if (chosen === undefined) {
      return yield* refuse(
        'people_role_revision_mismatch',
        `Role ${command.roleId} no longer carries revision ${command.roleRevisionId}; reload the role`,
      );
    }
    const catalog = yield* peopleStore
      .loadCatalogSnapshot(scope, chosen.revision.catalogSnapshotId)
      .pipe(Effect.mapError(storeFailureOf));
    if (Option.isNone(catalog)) {
      return yield* refuse(
        'people_capability_unknown',
        `The release ${chosen.revision.catalogSnapshotId} the role pins is not published`,
      );
    }
    const proposal: RoleAssignmentRequest = {
      actor: actorOf(scope),
      at: view.at,
      catalog: catalog.value.entries,
      holder: { _tag: 'Principal', principalId: command.principalId },
      incarnationId: command.incarnationId,
      memberships: view.memberships,
      role: chosen.role,
      roleRevision: chosen.revision,
      scope: accessScopeOf(view, command.scopeId, tenantOf(scope)),
      scopeId: command.scopeId,
      tenantId: tenantOf(scope),
    };
    const request: RoleAssignmentRequest =
      command.validUntil === undefined ? proposal : { ...proposal, validUntil: command.validUntil };
    // A delegated manager assigns through their envelope, so the assignment freezes its limits (D10).
    const planned = yield* firstAcceptedPlan(yield* basesIn(scope, view, command.scopeId), (basis) =>
      planRoleAssignment(
        Option.match(basis, { onNone: () => request, onSome: (delegation) => ({ ...request, delegation }) }),
      ),
    );
    yield* applyPlan(scope, planned);
    const written = assignmentOfPlan(planned);
    return yield* Option.match(written, {
      onNone: () => receipt(scope, {}),
      onSome: (recorded) => receipt(scope, { assignment: recorded }),
    });
  });

  const unassignRole = Effect.fn('accessPeopleCommands.unassignRole')(function* unassignRoleEffect(
    scope: OperationalScope,
    command: UnassignRoleCommand,
  ): Effect.fn.Return<PeopleCommandReceipt, PeopleCommandFailure> {
    const view = yield* read(scope);
    const assignment = view.assignments.find((candidate) => candidate.incarnationId === command.incarnationId);
    if (assignment === undefined) {
      return yield* refuse(
        'people_assignment_unknown',
        `Incarnation ${command.incarnationId} is not an assignment of this tenant`,
      );
    }
    const delegation = view.delegations.find((candidate) => candidate.id === assignment.delegated?.delegationId);
    const request = {
      actor: actorOf(scope),
      assignment,
      at: view.at,
      scopeId: assignment.scopeId,
      tenantId: tenantOf(scope),
    };
    const created = delegation === undefined ? request : { ...request, delegation };
    const planned = yield* firstAcceptedPlan(yield* basesIn(scope, view, assignment.scopeId), (basis) =>
      planRoleUnassignment(
        Option.match(basis, { onNone: () => created, onSome: (manager) => ({ ...created, manager }) }),
      ),
    );
    yield* applyPlan(scope, planned);
    return yield* receipt(scope, { assignment: { ...assignment, status: 'revoked' } });
  });

  const setTeamMembership = Effect.fn('accessPeopleCommands.setTeamMembership')(function* setTeamMembershipEffect(
    scope: OperationalScope,
    command: TeamMembershipCommand,
  ): Effect.fn.Return<PeopleCommandReceipt, PeopleCommandFailure> {
    const view = yield* read(scope);
    const entry = view.teams.find((candidate) => candidate.team.id === command.teamId);
    if (entry === undefined) {
      return yield* refuse('people_team_scope_mismatch', `Team ${command.teamId} is not a team of this tenant`);
    }
    const planned = yield* firstAcceptedPlan(yield* basesIn(scope, view, entry.team.scopeId), (basis) =>
      planTeamMembership({
        action: command.action,
        actor: actorOf(scope),
        at: view.at,
        holder: { _tag: 'Principal', principalId: command.principalId },
        managerAuthority: managerAuthorityOf(basis),
        memberId: command.memberId,
        memberships: view.memberships,
        scopeId: entry.team.scopeId,
        team: entry.team,
        teamMembers: entry.members,
        tenantId: tenantOf(scope),
      }),
    );
    yield* applyPlan(scope, planned);
    return yield* receipt(scope, {});
  });

  const grantDelegation = Effect.fn('accessPeopleCommands.grantDelegation')(function* grantDelegationEffect(
    scope: OperationalScope,
    command: GrantDelegationCommand,
  ): Effect.fn.Return<PeopleCommandReceipt, PeopleCommandFailure> {
    // The form choices and the release are two independent reads, so they are batched in one step.
    const [view, catalog] = yield* Effect.all(
      [read(scope), peopleStore.loadCatalogSnapshot(scope).pipe(Effect.mapError(storeFailureOf))],
      { concurrency: 1 },
    );
    if (Option.isNone(catalog)) {
      return yield* refuse(
        'people_capability_unknown',
        'No release is published, so no envelope can name a capability',
      );
    }
    const [firstCapability, ...otherCapabilities] = command.capabilityKeys;
    const [firstPerson, ...otherPeople] = command.people;
    const [firstRole, ...otherRoles] = command.roleIds;
    if (firstCapability === undefined || firstPerson === undefined || firstRole === undefined) {
      return yield* refuse(
        'delegation_role_empty',
        'A delegation names at least one person, one role and one capability, or it bounds nothing',
      );
    }
    const ceiling =
      command.amountCeiling === undefined ? Option.none<AmountCeiling>() : delegationCeilingOf(command.amountCeiling);
    if (command.amountCeiling !== undefined && Option.isNone(ceiling)) {
      return yield* refuse(
        'delegation_amount_outside_envelope',
        'A delegation amount ceiling names one currency and an inclusive minor-unit limit',
      );
    }
    // The acting person grants the envelope and the named manager receives it; the planner refuses a
    // person delegating to themselves.
    const grantedBy = actorOf(scope);
    const base: Omit<Delegation, 'amountCeiling'> = {
      capabilityKeys: [firstCapability, ...otherCapabilities] as const,
      grantedBy,
      id: command.delegationId,
      managerId: command.managerId,
      people: [firstPerson, ...otherPeople] as const,
      roleIds: [firstRole, ...otherRoles] as const,
      scopeId: command.scopeId,
      status: 'active' as const,
      tenantId: tenantOf(scope),
      validFrom: view.at,
      validUntil: command.validUntil,
    };
    const delegation: Delegation = Option.match(ceiling, {
      onNone: () => base,
      onSome: (amountCeiling) => ({ ...base, amountCeiling }),
    });
    const grantor = authorityOf(view, catalog.value.entries, grantedBy, command.scopeId);
    const envelope = {
      actor: grantedBy,
      at: view.at,
      catalog: catalog.value.entries,
      delegatedCells: view.roles.flatMap((entry) =>
        delegation.roleIds.some((roleId) => roleId === entry.role.id) ? entry.revision.cells : [],
      ),
      delegation,
      grantorAuthority: grantor.grants,
      grantorCapabilityKeys: grantor.capabilityKeys,
      memberships: view.memberships,
      roles: view.roles.map((entry) => entry.role),
      scope: accessScopeOf(view, command.scopeId, tenantOf(scope)),
      scopeId: command.scopeId,
      tenantId: tenantOf(scope),
    };
    // A delegate never delegates further, so a delegated basis is refused by the envelope rule (P8).
    const planned = yield* firstAcceptedPlan(yield* basesIn(scope, view, command.scopeId), (basis) =>
      planDelegationGrant({ ...envelope, managerAuthority: managerAuthorityOf(basis) }),
    );
    yield* applyPlan(scope, planned);
    return yield* receipt(scope, { delegation });
  });

  const revokeDelegation = Effect.fn('accessPeopleCommands.revokeDelegation')(function* revokeDelegationEffect(
    scope: OperationalScope,
    command: RevokeDelegationCommand,
  ): Effect.fn.Return<PeopleCommandReceipt, PeopleCommandFailure> {
    const view = yield* read(scope);
    const delegation = view.delegations.find((candidate) => candidate.id === command.delegationId);
    if (delegation === undefined) {
      return yield* refuse('delegation_not_live', `Delegation ${command.delegationId} is not in this tenant`);
    }
    const planned = yield* firstAcceptedPlan(yield* basesIn(scope, view, delegation.scopeId), (basis) =>
      planDelegationRevocation({
        actor: actorOf(scope),
        assignments: view.assignments,
        at: view.at,
        delegation,
        managerAuthority: managerAuthorityOf(basis),
        scopeId: delegation.scopeId,
        tenantId: tenantOf(scope),
      }),
    );
    yield* applyPlan(scope, planned);
    return yield* receipt(scope, { delegation: { ...delegation, status: 'revoked' } });
  });

  const transferOwnership = Effect.fn('accessPeopleCommands.transferOwnership')(function* transferOwnershipEffect(
    scope: OperationalScope,
    command: TransferOwnershipCommand,
  ): Effect.fn.Return<PeopleCommandReceipt, PeopleCommandFailure> {
    const view = yield* read(scope);
    // Ownership is permanent, so only permanent authority hands it on: a delegated manager whose
    // envelope names this capability would otherwise make themselves owner and outlive the delegation.
    // The bases of each scope are one loader read apiece, asked in turn against the same view.
    const bases = yield* Effect.forEach(command.scopeIds, (scopeId) => basesIn(scope, view, scopeId), {
      concurrency: 1,
    });
    const unauthorized = command.scopeIds.filter((_scopeId, index) => !(bases[index] ?? []).some(Option.isNone));
    if (unauthorized.length > 0) {
      return yield* refuse(
        'people_authority_missing',
        'Only an owner or the administrator of a scope transfers its ownership, never a delegated manager',
        unauthorized,
      );
    }
    const planned = yield* planOwnershipTransfer({
      actor: actorOf(scope),
      administration: view.administration,
      assignments: view.assignments,
      at: view.at,
      from: command.fromPrincipalId,
      membershipIds: command.membershipIds,
      memberships: view.memberships,
      scopeId: command.scopeIds[0] ?? view.tenantScopeId,
      scopeIds: command.scopeIds,
      successor: command.toPrincipalId,
      tenantId: tenantOf(scope),
    }).pipe(Effect.mapError(peopleErrorOf));
    yield* applyPlan(scope, planned);
    return yield* receipt(scope, { transferredScopeIds: command.scopeIds });
  });

  return Object.freeze({
    assignRole,
    grantDelegation,
    read,
    readCatalog,
    reconcile,
    revokeDelegation,
    setTeamMembership,
    transferOwnership,
    unassignRole,
  });
};

export const AccessPeopleCommandsLive: Layer.Layer<
  AccessPeopleCommands,
  never,
  AccessMembershipStore | AccessPeopleStore | AccessProjectionWriter | AccessTeamStore | TenantIntentLoader
> = Layer.effect(
  AccessPeopleCommands,
  Effect.gen(function* accessPeopleCommandsLayer() {
    const memberships = yield* AccessMembershipStore;
    const people = yield* AccessPeopleStore;
    const projection = yield* AccessProjectionWriter;
    const teams = yield* AccessTeamStore;
    const loader = yield* TenantIntentLoader;
    return makeAccessPeopleCommands({ loader, memberships, people, projection, teams });
  }),
);
