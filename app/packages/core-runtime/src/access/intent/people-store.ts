import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Match, Option, Ref, Schema } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import {
  accessAssignments,
  accessCatalogEntries,
  accessCatalogSnapshots,
  accessDelegations,
  accessMemberships,
  accessRoleRevisions,
  accessRoles,
  accessScopes,
  accessTeamMembers,
  principalCompanyMemberships,
  principals,
} from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  CatalogSnapshotIdSchema,
  DelegationIdSchema,
  LegalEntityIdSchema,
  TenantIdSchema,
} from '../ids.ts';
import type { CatalogSnapshotId } from '../ids.ts';
import type { Assignment, CatalogSnapshot, Delegation, Role, RoleRevision } from '../model.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  AmountCeilingSchema,
  AssignmentSchema,
  CatalogSnapshotSchema,
  DelegationSchema,
  RoleRevisionSchema,
  RoleSchema,
} from '../model.ts';
import type { PeopleCommandError, PeopleIntentWrite } from '../lifecycle/people-commands.ts';
import { peopleRefusal } from '../lifecycle/people-commands.ts';
import type { AccessIntentError } from './errors.ts';
import { intentConflict } from './errors.ts';
import { lockRoles, writeGrantIncarnations } from './grant-incarnations.ts';
import type { AccessMembership } from './memberships.ts';
import type { AccessIntentDatabase } from './persistence.ts';
import { peopleRevisionOf } from './people-revision.ts';
import { actorIssue, asDate, decodeStored, durable, holderColumns, runScoped, scopeIssue } from './persistence.ts';
import type { AccessTeamMember } from './teams.ts';

/*
 * The one writer of the rows a people change consists of: memberships, role assignments, delegations
 * and team places. The rules live in `lifecycle/people-commands.ts` as a pure planner; this store
 * writes the whole plan in ONE transaction, so a membership that ends cannot commit without the
 * assignments and team places it ends, and a delegation that is revoked cannot commit while an
 * assignment it created keeps an envelope nobody verified (D10, D10b, O65).
 *
 * Every call names the trusted request scope (O66): the tenant is the request's and the acting
 * person is the request's, so a command body can never redirect a write to another tenant or
 * attribute it to somebody else. A compare-and-set that loses is the same conflict as a lost
 * revision, and the caller repairs it by re-reading the tenant's intent.
 */

/** One role with the revision that expresses it now: what an assignment pins and a screen lists. */
export interface AccessRoleWithRevision {
  readonly revision: RoleRevision;
  readonly role: Role;
}

/** A scope row decodes into the access-scope identity every writer names (exactly one context). */
const TenantScopeRowSchema = Schema.Struct({
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  scopeId: AccessScopeIdSchema,
  tenantContextId: Schema.optionalKey(TenantIdSchema),
});
const decodeTenantScope = Schema.decodeUnknownResult(TenantScopeRowSchema, ACCESS_MODEL_PARSE_OPTIONS);

/** One access scope of the tenant: `scopeId` is the only name an access write ever uses. */
export interface TenantScopeRow {
  readonly legalEntityId?: typeof LegalEntityIdSchema.Type;
  readonly scopeId: typeof AccessScopeIdSchema.Type;
  readonly tenantContextId?: typeof TenantIdSchema.Type;
}

/** The intent a people command reads: what stands today, plus the roles and scopes it may name. */
export interface AccessPeopleIntent {
  readonly assignments: readonly Assignment[];
  readonly delegations: readonly Delegation[];
  readonly roles: readonly AccessRoleWithRevision[];
  readonly scopes: readonly TenantScopeRow[];
}

const assignmentColumns = {
  agentId: accessAssignments.agentId,
  assignedBy: accessAssignments.assignedBy,
  delegatedBy: accessAssignments.delegatedBy,
  delegationEnvelopeJson: accessAssignments.delegationEnvelopeJson,
  incarnationId: accessAssignments.incarnationId,
  principalId: accessAssignments.principalId,
  roleId: accessAssignments.roleId,
  roleRevisionId: accessAssignments.roleRevisionId,
  scopeId: accessAssignments.scopeId,
  status: accessAssignments.status,
  tenantId: accessAssignments.tenantId,
  validFrom: accessAssignments.validFrom,
  validUntil: accessAssignments.validUntil,
} as const;

const delegationColumns = {
  amountCeilingJson: accessDelegations.amountCeilingJson,
  capabilityKeys: accessDelegations.capabilityKeys,
  delegationId: accessDelegations.delegationId,
  grantedBy: accessDelegations.grantedBy,
  managerId: accessDelegations.managerId,
  people: accessDelegations.people,
  roleIds: accessDelegations.roleIds,
  scopeId: accessDelegations.scopeId,
  status: accessDelegations.status,
  tenantId: accessDelegations.tenantId,
  until: accessDelegations.until,
  validFrom: accessDelegations.validFrom,
} as const;

const scopeColumns = {
  legalEntityId: accessScopes.legalEntityId,
  scopeId: accessScopes.scopeId,
  tenantContextId: accessScopes.tenantContextId,
} as const;

const roleColumns = {
  createdAt: accessRoles.createdAt,
  createdBy: accessRoles.createdBy,
  legalEntityId: accessRoles.legalEntityId,
  name: accessRoles.name,
  roleId: accessRoles.roleId,
  tenantId: accessRoles.tenantId,
} as const;

const revisionColumns = {
  catalogSnapshotId: accessRoleRevisions.catalogSnapshotId,
  cellsJson: accessRoleRevisions.cellsJson,
  createdAt: accessRoleRevisions.createdAt,
  createdBy: accessRoleRevisions.createdBy,
  provenance: accessRoleRevisions.provenance,
  revision: accessRoleRevisions.revision,
  roleId: accessRoleRevisions.roleId,
  roleRevisionId: accessRoleRevisions.roleRevisionId,
  templateKey: accessRoleRevisions.templateKey,
  tenantId: accessRoleRevisions.tenantId,
} as const;

/** The frozen delegated limits live beside the assignment, exactly as the loader reads them back. */
const FrozenEnvelopeSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(AmountCeilingSchema),
  capabilityKeys: Schema.NonEmptyArray(CapabilityKeySchema),
  delegationId: DelegationIdSchema,
  until: Schema.DateFromString,
});

const decodeAssignment = Schema.decodeUnknownResult(AssignmentSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeRole = Schema.decodeUnknownResult(RoleSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeRoleRevision = Schema.decodeUnknownResult(RoleRevisionSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeDelegation = Schema.decodeUnknownResult(DelegationSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeFrozenEnvelope = Schema.decodeUnknownResult(FrozenEnvelopeSchema, ACCESS_MODEL_PARSE_OPTIONS);

/** The unique indexes a write can collide with; a collision is a race the caller repairs by reading. */
const PEOPLE_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_assignments_pkey',
  'access_assignments_scope_uk',
  'access_assignments_tenant_id_uk',
  'access_delegations_pkey',
  'access_delegations_tenant_id_uk',
  'access_memberships_agent_uk',
  'access_memberships_pkey',
  'access_memberships_subject_uk',
  'access_memberships_tenant_id_uk',
  'access_team_members_agent_uk',
  'access_team_members_pkey',
  'access_team_members_principal_uk',
  'access_team_members_tenant_id_uk',
]);

interface AssignmentRow {
  readonly agentId: string | null;
  readonly assignedBy: string;
  readonly delegatedBy: string | null;
  readonly delegationEnvelopeJson: unknown;
  readonly incarnationId: string;
  readonly principalId: string | null;
  readonly roleId: string;
  readonly roleRevisionId: string;
  readonly scopeId: string;
  readonly status: string;
  readonly tenantId: string;
  readonly validFrom: Date | string;
  readonly validUntil: Date | string | null;
}

interface DelegationRow {
  readonly amountCeilingJson: unknown;
  readonly capabilityKeys: readonly string[];
  readonly delegationId: string;
  readonly grantedBy: string;
  readonly managerId: string;
  readonly people: readonly string[];
  readonly roleIds: readonly string[];
  readonly scopeId: string;
  readonly status: string;
  readonly tenantId: string;
  readonly until: Date | string;
  readonly validFrom: Date | string;
}

const holderOf = (row: AssignmentRow) =>
  row.principalId === null
    ? { _tag: 'Agent' as const, agentId: row.agentId ?? '' }
    : { _tag: 'Principal' as const, principalId: row.principalId };

const delegatedOf = (row: AssignmentRow) =>
  row.delegatedBy === null
    ? Effect.succeedNone
    : decodeStored(decodeFrozenEnvelope(row.delegationEnvelopeJson), `envelope of ${row.incarnationId}`).pipe(
        Effect.asSome,
      );

const assignmentOf = (row: AssignmentRow) => {
  const base = {
    assignedAt: asDate(row.validFrom),
    assignedBy: row.assignedBy,
    holder: holderOf(row),
    incarnationId: row.incarnationId,
    roleId: row.roleId,
    roleRevisionId: row.roleRevisionId,
    scopeId: row.scopeId,
    status: row.status,
    tenantId: row.tenantId,
    validFrom: asDate(row.validFrom),
  };
  const dated = row.validUntil === null ? base : { ...base, validUntil: asDate(row.validUntil) };
  return delegatedOf(row).pipe(
    Effect.flatMap((delegated) =>
      decodeStored(
        decodeAssignment(Option.isNone(delegated) ? dated : { ...dated, delegated: delegated.value }),
        `assignment ${row.incarnationId}`,
      ),
    ),
  );
};

const delegationOf = (row: DelegationRow) => {
  const base = {
    capabilityKeys: row.capabilityKeys,
    grantedBy: row.grantedBy,
    id: row.delegationId,
    managerId: row.managerId,
    people: row.people,
    roleIds: row.roleIds,
    scopeId: row.scopeId,
    status: row.status,
    tenantId: row.tenantId,
    validFrom: asDate(row.validFrom),
    validUntil: asDate(row.until),
  };
  return decodeStored(
    decodeDelegation(row.amountCeilingJson === null ? base : { ...base, amountCeiling: row.amountCeilingJson }),
    `delegation ${row.delegationId}`,
  );
};

const attributionIssue = (scope: OperationalScope, write: PeopleIntentWrite): string | null =>
  Match.value(write).pipe(
    Match.tag(
      'RecordAssignment',
      ({ assignment }) => scopeIssue(scope, [assignment.tenantId]) ?? actorIssue(scope, assignment.assignedBy),
    ),
    Match.tag(
      'RecordDelegation',
      ({ delegation }) => scopeIssue(scope, [delegation.tenantId]) ?? actorIssue(scope, delegation.grantedBy),
    ),
    Match.tag(
      'RecordMembership',
      ({ membership }) => scopeIssue(scope, [membership.tenantId]) ?? actorIssue(scope, membership.recordedBy),
    ),
    Match.tag(
      'RecordTeamMember',
      ({ member }) => scopeIssue(scope, [member.tenantId]) ?? actorIssue(scope, member.addedBy),
    ),
    // An ending row is attributed to the request by construction: the store only ever moves rows of
    // the installed tenant, and the request scope is the only tenant it can see.
    Match.tag('EndAssignment', () => null),
    Match.tag('EndDelegation', () => null),
    Match.tag('EndMembership', () => null),
    Match.tag('RemoveTeamMember', () => null),
    // A precondition writes nothing; it reads the installed tenant's directory only.
    Match.tag('RequireDirectoryMember', () => null),
    Match.exhaustive,
  );

const roleOf = (row: {
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly legalEntityId: string | null;
  readonly name: string;
  readonly roleId: string;
  readonly tenantId: string;
}) => {
  const base = {
    createdAt: asDate(row.createdAt),
    createdBy: row.createdBy,
    id: row.roleId,
    name: row.name,
    tenantId: row.tenantId,
  };
  return decodeStored(
    decodeRole(row.legalEntityId === null ? base : { ...base, legalEntityId: row.legalEntityId }),
    `role ${row.roleId}`,
  );
};

const roleRevisionOf = (row: {
  readonly catalogSnapshotId: string;
  readonly cellsJson: readonly unknown[];
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly provenance: string;
  readonly revision: number;
  readonly roleId: string;
  readonly roleRevisionId: string;
  readonly templateKey: string | null;
  readonly tenantId: string;
}) => {
  const base = {
    catalogSnapshotId: row.catalogSnapshotId,
    cells: row.cellsJson,
    createdAt: asDate(row.createdAt),
    createdBy: row.createdBy,
    id: row.roleRevisionId,
    provenance: row.provenance,
    revision: row.revision,
    roleId: row.roleId,
    tenantId: row.tenantId,
  };
  return decodeStored(
    decodeRoleRevision(row.templateKey === null ? base : { ...base, templateKey: row.templateKey }),
    `role revision ${row.roleRevisionId}`,
  );
};

/** The revision that expresses each role now: the highest number, which is the one an editor read. */
const latestRevisions = (revisions: readonly RoleRevision[]): ReadonlyMap<string, RoleRevision> => {
  const latest = new Map<string, RoleRevision>();
  for (const revision of revisions) {
    const current = latest.get(revision.roleId);
    if (current === undefined || revision.revision > current.revision) {
      latest.set(revision.roleId, revision);
    }
  }
  return latest;
};

/** A command naming another tenant, or attributed to another person, never reaches SQL (O66). */
const writeIssue = (scope: OperationalScope, writes: readonly PeopleIntentWrite[]): string | null => {
  for (const write of writes) {
    const issue = attributionIssue(scope, write);
    if (issue !== null) {
      return issue;
    }
  }
  return null;
};

const writeMembership = (transaction: CoreTransaction, membership: AccessMembership) =>
  transaction
    .insert(accessMemberships)
    .values({
      ...holderColumns(membership.holder),
      createdAt: membership.createdAt,
      kind: membership.kind,
      membershipId: membership.id,
      recordedBy: membership.recordedBy,
      scopeId: membership.scopeId,
      status: membership.status,
      tenantId: membership.tenantId,
      validFrom: membership.validFrom,
      validUntil: membership.validUntil ?? null,
    })
    .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS), Effect.asVoid);

/**
 * A membership only ever moves forward; the row it moved from is the compare-and-set this checks. A
 * revocation records who ended it, when and why, exactly once: the migration's guard admits the three
 * columns only on the move to 'revoked' and never changes them afterwards.
 */
const endMembership = (
  transaction: CoreTransaction,
  scope: OperationalScope,
  write: Extract<PeopleIntentWrite, { _tag: 'EndMembership' }>,
) =>
  transaction
    .update(accessMemberships)
    .set(
      write.status === 'revoked'
        ? {
            endedAt: sql`transaction_timestamp()`,
            endedBy: scope.principalId,
            endedReason: write.reason ?? null,
            status: write.status,
          }
        : { status: write.status },
    )
    .where(
      and(
        eq(accessMemberships.tenantId, scope.tenantId),
        eq(accessMemberships.membershipId, write.membershipId),
        // The compare-and-set admits exactly the transitions the model allows: a suspension from an
        // active row, a revocation from an active or a suspended one.
        inArray(accessMemberships.status, write.status === 'revoked' ? ['active', 'suspended'] : ['active']),
      ),
    )
    .returning({ membershipId: accessMemberships.membershipId })
    .pipe(
      durable(PEOPLE_UNIQUE_CONSTRAINTS),
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.fail(
              intentConflict(
                'access_intent_record_conflict',
                `membership ${write.membershipId} is not a membership this command may move to ${write.status}`,
              ),
            ),
      ),
    );

/**
 * The cells of the revision an assignment pins, read in the assignment's own transaction. The pin must
 * still be the role's head: a role edit that landed after the planner read moved every live holder and
 * every incarnation already, so a stale pin is a lost compare-and-set, never a second set of cells. The
 * change holds the role's shared lock (`lockRoles`), so no edit can commit between this read and the insert.
 */
const pinnedRevision = Effect.fn('AccessPeopleStore.pinnedRevision')(function* pinnedRevisionEffect(
  transaction: CoreTransaction,
  assignment: Assignment,
) {
  const [head] = yield* transaction
    .select(revisionColumns)
    .from(accessRoleRevisions)
    .where(
      and(eq(accessRoleRevisions.tenantId, assignment.tenantId), eq(accessRoleRevisions.roleId, assignment.roleId)),
    )
    .orderBy(desc(accessRoleRevisions.revision))
    .limit(1)
    .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS));
  if (head?.roleRevisionId !== assignment.roleRevisionId) {
    return yield* intentConflict(
      'access_intent_record_conflict',
      `assignment ${assignment.incarnationId} pins revision ${assignment.roleRevisionId}, which is not the head of role ${assignment.roleId}`,
    );
  }
  return yield* roleRevisionOf(head);
});

/**
 * An assignment grants its role's cells in its scope only through their grant incarnations (guarantee
 * 9), so both are written together, through the one incarnation writer the bootstrap, the portal and
 * every role edit use: a cell that already has a live incarnation in the scope keeps it, and a retired
 * one is never revived.
 */
const writeAssignment = Effect.fn('AccessPeopleStore.writeAssignment')(function* writeAssignmentEffect(
  transaction: CoreTransaction,
  assignment: Assignment,
) {
  const revision = yield* pinnedRevision(transaction, assignment);
  yield* writeGrantIncarnations(transaction, {
    addedCells: revision.cells,
    removedCells: [],
    roleId: assignment.roleId,
    scopeIds: [assignment.scopeId],
    targetRevisionId: assignment.roleRevisionId,
    tenantId: assignment.tenantId,
  }).pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS));
  return yield* transaction
    .insert(accessAssignments)
    .values({
      ...holderColumns(assignment.holder),
      assignedBy: assignment.assignedBy,
      delegatedBy: assignment.delegated?.delegationId ?? null,
      delegationEnvelopeJson:
        assignment.delegated === undefined
          ? null
          : {
              ...assignment.delegated,
              until: assignment.delegated.until.toISOString(),
            },
      incarnationId: assignment.incarnationId,
      roleId: assignment.roleId,
      roleRevisionId: assignment.roleRevisionId,
      scopeId: assignment.scopeId,
      status: assignment.status,
      tenantId: assignment.tenantId,
      validFrom: assignment.validFrom,
      validUntil: assignment.validUntil ?? null,
    })
    .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS), Effect.asVoid);
});

/**
 * Ending an assignment never rewrites the envelope it froze: the row keeps its delegated limits and
 * the incarnation is never revived, so an ended assignment can never be widened back into authority.
 */
const endAssignment = (
  transaction: CoreTransaction,
  scope: OperationalScope,
  write: Extract<PeopleIntentWrite, { _tag: 'EndAssignment' }>,
) =>
  transaction
    .update(accessAssignments)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(accessAssignments.tenantId, scope.tenantId),
        eq(accessAssignments.incarnationId, write.incarnationId),
        eq(accessAssignments.status, 'active'),
      ),
    )
    .returning({ incarnationId: accessAssignments.incarnationId })
    .pipe(
      durable(PEOPLE_UNIQUE_CONSTRAINTS),
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.fail(
              intentConflict(
                'access_intent_status_terminated',
                `assignment ${write.incarnationId} is not an active assignment this command may end`,
              ),
            ),
      ),
    );

const writeDelegation = (transaction: CoreTransaction, delegation: Delegation) =>
  transaction
    .insert(accessDelegations)
    .values({
      amountCeilingJson: delegation.amountCeiling ?? null,
      capabilityKeys: [...delegation.capabilityKeys],
      delegationId: delegation.id,
      grantedBy: delegation.grantedBy,
      managerId: delegation.managerId,
      people: [...delegation.people],
      roleIds: [...delegation.roleIds],
      scopeId: delegation.scopeId,
      status: delegation.status,
      tenantId: delegation.tenantId,
      until: delegation.validUntil,
      validFrom: delegation.validFrom,
    })
    .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS), Effect.asVoid);

const endDelegation = (
  transaction: CoreTransaction,
  scope: OperationalScope,
  write: Extract<PeopleIntentWrite, { _tag: 'EndDelegation' }>,
) =>
  transaction
    .update(accessDelegations)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(accessDelegations.tenantId, scope.tenantId),
        eq(accessDelegations.delegationId, write.delegationId),
        eq(accessDelegations.status, 'active'),
      ),
    )
    .returning({ delegationId: accessDelegations.delegationId })
    .pipe(
      durable(PEOPLE_UNIQUE_CONSTRAINTS),
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.fail(
              intentConflict(
                'access_intent_status_terminated',
                `delegation ${write.delegationId} is not an active delegation this command may end`,
              ),
            ),
      ),
    );

const writeTeamMember = (transaction: CoreTransaction, member: AccessTeamMember) =>
  transaction
    .insert(accessTeamMembers)
    .values({
      ...holderColumns(member.holder),
      addedAt: member.addedAt,
      addedBy: member.addedBy,
      teamId: member.teamId,
      teamMemberId: member.id,
      tenantId: member.tenantId,
    })
    .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS), Effect.asVoid);

const removeTeamMember = (
  transaction: CoreTransaction,
  scope: OperationalScope,
  write: Extract<PeopleIntentWrite, { _tag: 'RemoveTeamMember' }>,
) =>
  transaction
    .delete(accessTeamMembers)
    .where(and(eq(accessTeamMembers.tenantId, scope.tenantId), eq(accessTeamMembers.teamMemberId, write.teamMemberId)))
    .returning({ teamMemberId: accessTeamMembers.teamMemberId })
    .pipe(
      durable(PEOPLE_UNIQUE_CONSTRAINTS),
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.fail(
              intentConflict(
                'access_intent_record_conflict',
                `team place ${write.teamMemberId} does not exist in this tenant`,
              ),
            ),
      ),
    );

/**
 * A delegated assignment commits only while the grantor still holds what it was checked against: the
 * covering grantor assignments are locked for share, so a concurrent removal waits for this commit,
 * and one that already committed makes this write refuse instead of granting authority nobody holds.
 */
const requireGrantorAssignments = (
  transaction: CoreTransaction,
  scope: OperationalScope,
  cover: readonly { readonly incarnationId: string; readonly roleRevisionId: string }[],
): Effect.Effect<void, AccessIntentError> =>
  cover.length === 0
    ? Effect.void
    : transaction
        .select({ incarnationId: accessAssignments.incarnationId, roleRevisionId: accessAssignments.roleRevisionId })
        .from(accessAssignments)
        .where(
          and(
            eq(accessAssignments.tenantId, scope.tenantId),
            inArray(
              accessAssignments.incarnationId,
              cover.map(({ incarnationId }) => incarnationId),
            ),
            eq(accessAssignments.status, 'active'),
          ),
        )
        .for('share')
        .pipe(
          durable(PEOPLE_UNIQUE_CONSTRAINTS),
          Effect.flatMap((rows) =>
            // Each covering assignment must still be active and still cover through the same revision:
            // an edit that removed the covering cell moves the assignment to another revision.
            cover.every(({ incarnationId, roleRevisionId }) =>
              rows.some((row) => row.incarnationId === incarnationId && row.roleRevisionId === roleRevisionId),
            )
              ? Effect.void
              : Effect.fail(
                  intentConflict(
                    'access_intent_record_conflict',
                    'the grantor no longer holds the authority this delegated assignment was checked against',
                  ),
                ),
          ),
        );

/** The reason a refused precondition gives; the store's own conflict carries the same text. */
const DIRECTORY_MEMBERSHIP_MISSING = (write: Extract<PeopleIntentWrite, { _tag: 'RequireDirectoryMember' }>) =>
  `Principal ${write.principalId} is not an active ${write.principalKind} with an active directory membership of company ${write.legalEntityId}`;

/**
 * The company directory precondition of an admission, inside the change's own transaction (S2). The
 * directory rows are company-scoped by row security, so the company is installed for these two reads
 * the way invitation acceptance does, and the request's own company is installed again afterwards.
 * Both rows are share-locked: a concurrent departure, disabling or principal deactivation waits for
 * this commit, and one that committed first makes the admission refuse instead of landing.
 */
const requireDirectoryMember = Effect.fn('AccessPeopleStore.requireDirectoryMember')(
  function* requireDirectoryMemberEffect(
    transaction: CoreTransaction,
    scope: OperationalScope,
    write: Extract<PeopleIntentWrite, { _tag: 'RequireDirectoryMember' }>,
    refused: Ref.Ref<Option.Option<PeopleCommandError>>,
  ) {
    yield* transaction
      .execute(sql`select set_config('ontos.legal_entity_id', ${write.legalEntityId}, true)`, 'objects')
      .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS));
    // One statement: the active directory row joined to the active principal of the holder's kind, both share-locked.
    const directory = yield* transaction
      .select({ principalId: principalCompanyMemberships.principalId })
      .from(principalCompanyMemberships)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, principalCompanyMemberships.tenantId),
          eq(principals.principalId, principalCompanyMemberships.principalId),
        ),
      )
      .where(
        and(
          eq(principalCompanyMemberships.tenantId, scope.tenantId),
          eq(principalCompanyMemberships.legalEntityId, write.legalEntityId),
          eq(principalCompanyMemberships.principalId, write.principalId),
          eq(principalCompanyMemberships.status, 'active'),
          eq(principals.kind, write.principalKind),
          eq(principals.status, 'active'),
        ),
      )
      .for('share')
      .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS));
    yield* transaction
      .execute(sql`select set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`, 'objects')
      .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS));
    if (directory.length === 1) {
      return yield* Effect.void;
    }
    const reason = DIRECTORY_MEMBERSHIP_MISSING(write);
    yield* Ref.set(refused, Option.some(peopleRefusal('people_directory_membership_missing', reason)));
    // Failing the body rolls back every row the change wrote; the caller reports the refusal above.
    return yield* intentConflict('access_intent_write_refused', reason);
  },
);

/** The precondition refusal a rolled-back change recorded, or the conflict itself when there is none. */
const refusalOr = (
  refused: Ref.Ref<Option.Option<PeopleCommandError>>,
  conflict: AccessIntentError,
): Effect.Effect<never, AccessIntentError | PeopleCommandError> =>
  Effect.flatMap(Ref.get(refused), (refusal) =>
    Effect.fail(Option.getOrElse(refusal, (): AccessIntentError | PeopleCommandError => conflict)),
  );

const applyWrite = (
  transaction: CoreTransaction,
  scope: OperationalScope,
  write: PeopleIntentWrite,
  refused: Ref.Ref<Option.Option<PeopleCommandError>>,
): Effect.Effect<void, AccessIntentError> =>
  Match.value(write).pipe(
    Match.tag('EndAssignment', (ending) => endAssignment(transaction, scope, ending)),
    Match.tag('EndDelegation', (ending) => endDelegation(transaction, scope, ending)),
    Match.tag('EndMembership', (ending) => endMembership(transaction, scope, ending)),
    Match.tag('RecordAssignment', ({ assignment, grantorCover }) =>
      requireGrantorAssignments(transaction, scope, grantorCover ?? []).pipe(
        Effect.andThen(writeAssignment(transaction, assignment)),
      ),
    ),
    Match.tag('RecordDelegation', ({ delegation }) => writeDelegation(transaction, delegation)),
    Match.tag('RecordMembership', ({ membership }) => writeMembership(transaction, membership)),
    Match.tag('RecordTeamMember', ({ member }) => writeTeamMember(transaction, member)),
    Match.tag('RemoveTeamMember', (removal) => removeTeamMember(transaction, scope, removal)),
    Match.tag('RequireDirectoryMember', (required) => requireDirectoryMember(transaction, scope, required, refused)),
    Match.exhaustive,
  );

/**
 * One release: the named one, or with no id the newest published one, which is the one a new envelope
 * names its capabilities from. Every release names the same capability keys again, so the entries are
 * read for the one release the header resolved to, never across releases.
 */
const readRelease = Effect.fn('AccessPeopleStore.readRelease')(function* readReleaseEffect(
  transaction: CoreTransaction,
  catalogSnapshotId: CatalogSnapshotId | undefined,
) {
  const headers = transaction
    .select({
      catalogSnapshotId: accessCatalogSnapshots.catalogSnapshotId,
      digest: accessCatalogSnapshots.digest,
      publishedAt: accessCatalogSnapshots.publishedAt,
    })
    .from(accessCatalogSnapshots);
  const [header] = yield* catalogSnapshotId === undefined
    ? headers.orderBy(desc(accessCatalogSnapshots.publishedAt), desc(accessCatalogSnapshots.catalogSnapshotId)).limit(1)
    : headers.where(eq(accessCatalogSnapshots.catalogSnapshotId, CatalogSnapshotIdSchema.make(catalogSnapshotId)));
  if (header === undefined) {
    return Option.none();
  }
  const entries = yield* transaction
    .select({ entryJson: accessCatalogEntries.entryJson })
    .from(accessCatalogEntries)
    .where(eq(accessCatalogEntries.catalogSnapshotId, header.catalogSnapshotId));
  return Option.some({ entries, snapshot: header });
});

/** The roles a change adds holders to: each is locked before its head is read (`lockRoles`). */
const assignedRoleIds = (writes: readonly PeopleIntentWrite[]): readonly string[] =>
  writes.flatMap((write) =>
    Match.value(write).pipe(
      Match.tag('RecordAssignment', ({ assignment }): readonly string[] => [assignment.roleId]),
      Match.orElse((): readonly string[] => []),
    ),
  );

export interface ApplyPeopleChangeInput {
  /**
   * The people revision (`peopleRevisionOf`) of the view the change was planned on. When it is given,
   * the store re-reads the tenant's people intent under the tenant's people lock and refuses the change
   * if anything moved since, so no rule the plan checked is decided on a view another change overtook.
   */
  readonly expectedRevision?: string;
  readonly writes: readonly PeopleIntentWrite[];
}

/**
 * The namespace of the transaction lock that serializes the people changes of one tenant. The second
 * key is the tenant id, both hashed by `hashtext`, so one tenant never waits on another.
 */
export const PEOPLE_CHANGE_LOCK_NAMESPACE = 'ontos.access.people-change';

/**
 * Takes the tenant's people lock for the rest of the transaction. Every planned people change commits
 * under it, so two plans read against the same view can never both commit: the second one waits here
 * and then meets the first one's rows in its revision check.
 */
const lockTenantPeople = (transaction: CoreTransaction, scope: OperationalScope) =>
  transaction
    .execute(
      sql`select pg_advisory_xact_lock(hashtext(${PEOPLE_CHANGE_LOCK_NAMESPACE}), hashtext(${scope.tenantId}))`,
      'objects',
    )
    .pipe(durable(PEOPLE_UNIQUE_CONSTRAINTS), Effect.asVoid);

/** The people revision of the tenant as this transaction reads it, after it took the people lock. */
const currentPeopleRevision = (transaction: CoreTransaction, scope: OperationalScope) =>
  Effect.all(
    [
      transaction
        .select({
          id: accessMemberships.membershipId,
          kind: accessMemberships.kind,
          status: accessMemberships.status,
          validFrom: accessMemberships.validFrom,
        })
        .from(accessMemberships)
        .where(eq(accessMemberships.tenantId, scope.tenantId)),
      transaction
        .select({
          incarnationId: accessAssignments.incarnationId,
          roleRevisionId: accessAssignments.roleRevisionId,
          status: accessAssignments.status,
        })
        .from(accessAssignments)
        .where(eq(accessAssignments.tenantId, scope.tenantId)),
      transaction
        .select({ id: accessDelegations.delegationId, status: accessDelegations.status })
        .from(accessDelegations)
        .where(eq(accessDelegations.tenantId, scope.tenantId)),
      transaction
        .select({ id: accessTeamMembers.teamMemberId, teamId: accessTeamMembers.teamId })
        .from(accessTeamMembers)
        .where(eq(accessTeamMembers.tenantId, scope.tenantId)),
    ],
    { concurrency: 1 },
  ).pipe(
    durable(PEOPLE_UNIQUE_CONSTRAINTS),
    Effect.map(([memberships, assignments, delegations, teamMembers]) =>
      peopleRevisionOf({
        assignments,
        delegations,
        memberships: memberships.map((row) => ({ ...row, validFrom: asDate(row.validFrom) })),
        teamMembers,
      }),
    ),
  );

/** Refuses the change when the tenant's people intent moved since the view it was planned on. */
const requirePeopleRevision = (
  transaction: CoreTransaction,
  scope: OperationalScope,
  expectedRevision: string | undefined,
): Effect.Effect<void, AccessIntentError> =>
  expectedRevision === undefined
    ? Effect.void
    : currentPeopleRevision(transaction, scope).pipe(
        Effect.flatMap((current) =>
          current === expectedRevision
            ? Effect.void
            : Effect.fail(
                intentConflict(
                  'access_intent_record_conflict',
                  'the people of this tenant changed after this change was planned; read them again',
                ),
              ),
        ),
      );

/**
 * The people intent port. Every call names the trusted request scope it runs in (O66), so the tenant
 * and the acting person are the request's and never the command body's.
 */
export interface AccessPeopleStoreService {
  /**
   * Every row of one planned change, in one transaction, or nothing at all. A precondition the change
   * names and the transaction refutes is a people refusal (`people_directory_membership_missing`).
   */
  readonly applyPeopleChange: (
    scope: OperationalScope,
    input: ApplyPeopleChangeInput,
  ) => Effect.Effect<void, AccessIntentError | PeopleCommandError>;
  /**
   * The release a role revision pinned: the entries a cell must still exist in. A release is global
   * data, but it is read through the caller's scope so no command can consult one it was not given.
   */
  readonly loadCatalogSnapshot: (
    scope: OperationalScope,
    catalogSnapshotId?: CatalogSnapshotId,
  ) => Effect.Effect<Option.Option<CatalogSnapshot>, AccessIntentError>;
  /** The tenant's assignments, delegations and roles with the revision each role carries now. */
  readonly loadTenantPeople: (scope: OperationalScope) => Effect.Effect<AccessPeopleIntent, AccessIntentError>;
}

const makeAccessPeopleDrizzleStore = (database: AccessIntentDatabase): AccessPeopleStoreService => {
  const loadTenantPeople: AccessPeopleStoreService['loadTenantPeople'] = Effect.fn(
    'AccessPeopleStore.loadTenantPeople',
  )(function* loadTenantPeopleEffect(scope: OperationalScope) {
    // One transaction, so an assignment, the delegation that bounds it and the role revision it pins
    // are all the same instant of intent.
    const [assignments, delegations, roles, revisions, scopes] = yield* runScoped(
      database,
      scope,
      PEOPLE_UNIQUE_CONSTRAINTS,
      (transaction) =>
        Effect.all(
          [
            transaction
              .select(assignmentColumns)
              .from(accessAssignments)
              .where(eq(accessAssignments.tenantId, scope.tenantId)),
            transaction
              .select(delegationColumns)
              .from(accessDelegations)
              .where(eq(accessDelegations.tenantId, scope.tenantId)),
            transaction.select(roleColumns).from(accessRoles).where(eq(accessRoles.tenantId, scope.tenantId)),
            transaction
              .select(revisionColumns)
              .from(accessRoleRevisions)
              .where(eq(accessRoleRevisions.tenantId, scope.tenantId)),
            transaction.select(scopeColumns).from(accessScopes).where(eq(accessScopes.tenantId, scope.tenantId)),
          ],
          { concurrency: 1 },
        ),
    );
    const decodedAssignments = yield* Effect.forEach(assignments, (row) => assignmentOf(row), { concurrency: 1 });
    const decodedDelegations = yield* Effect.forEach(delegations, (row) => delegationOf(row), { concurrency: 1 });
    const decodedRoles = yield* Effect.forEach(roles, (row) => roleOf(row), { concurrency: 1 });
    const decodedRevisions = yield* Effect.forEach(revisions, (row) => roleRevisionOf(row), { concurrency: 1 });
    const latest = latestRevisions(decodedRevisions);
    const rolesWithRevision = decodedRoles.flatMap((role): readonly AccessRoleWithRevision[] => {
      const revision = latest.get(role.id);
      return revision === undefined ? [] : [{ revision, role }];
    });
    const tenantScopes = yield* Effect.forEach(
      scopes,
      (row) => {
        const base = { scopeId: row.scopeId };
        const withTenant = row.tenantContextId === null ? base : { ...base, tenantContextId: row.tenantContextId };
        return decodeStored(
          decodeTenantScope(
            row.legalEntityId === null ? withTenant : { ...withTenant, legalEntityId: row.legalEntityId },
          ),
          `access scope ${row.scopeId}`,
        );
      },
      { concurrency: 1 },
    );
    return {
      assignments: decodedAssignments,
      delegations: decodedDelegations,
      roles: rolesWithRevision,
      scopes: tenantScopes,
    };
  });

  const loadCatalogSnapshot: AccessPeopleStoreService['loadCatalogSnapshot'] = Effect.fn(
    'AccessPeopleStore.loadCatalogSnapshot',
  )(function* loadCatalogSnapshotEffect(scope: OperationalScope, catalogSnapshotId?: CatalogSnapshotId) {
    const read = yield* runScoped(database, scope, PEOPLE_UNIQUE_CONSTRAINTS, (transaction) =>
      readRelease(transaction, catalogSnapshotId),
    );
    if (Option.isNone(read)) {
      return Option.none<CatalogSnapshot>();
    }
    const { entries, snapshot } = read.value;
    return Option.some(
      yield* decodeStored(
        Schema.decodeResult(
          CatalogSnapshotSchema,
          ACCESS_MODEL_PARSE_OPTIONS,
        )({
          digest: snapshot.digest,
          entries: entries.map((row) => row.entryJson),
          id: snapshot.catalogSnapshotId,
          publishedAt: asDate(snapshot.publishedAt),
        }),
        `catalog snapshot ${snapshot.catalogSnapshotId}`,
      ),
    );
  });

  const applyPeopleChange: AccessPeopleStoreService['applyPeopleChange'] = Effect.fn(
    'AccessPeopleStore.applyPeopleChange',
  )(function* applyPeopleChangeEffect(scope: OperationalScope, { expectedRevision, writes }: ApplyPeopleChangeInput) {
    const issue = writeIssue(scope, writes);
    if (issue !== null) {
      return yield* intentConflict('access_intent_scope_mismatch', issue);
    }
    if (writes.length === 0) {
      return yield* Effect.void;
    }
    const refused = yield* Ref.make(Option.none<PeopleCommandError>());
    // The tenant's people lock first, then the revision the plan was read at, then the role locks.
    return yield* runScoped(database, scope, PEOPLE_UNIQUE_CONSTRAINTS, (transaction) =>
      lockTenantPeople(transaction, scope).pipe(
        Effect.andThen(requirePeopleRevision(transaction, scope, expectedRevision)),
        Effect.andThen(
          lockRoles(transaction, {
            mode: 'share',
            roleIds: assignedRoleIds(writes),
            tenantId: scope.tenantId,
          }),
        ),
        Effect.andThen(
          Effect.forEach(writes, (write) => applyWrite(transaction, scope, write, refused), {
            concurrency: 1,
            discard: true,
          }),
        ),
      ),
    ).pipe(Effect.catchTag('AccessIntentConflictError', (conflict) => refusalOr(refused, conflict)));
  });

  return Object.freeze({ applyPeopleChange, loadCatalogSnapshot, loadTenantPeople });
};

export class AccessPeopleStore extends Context.Service<AccessPeopleStore, AccessPeopleStoreService>()(
  '@app/core-runtime/access/intent/people-store/AccessPeopleStore',
) {}

export const AccessPeopleStoreLive = Layer.effect(
  AccessPeopleStore,
  Effect.gen(function* accessPeopleStoreLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeAccessPeopleDrizzleStore({ enrollment, executor: database.executor });
  }),
);
