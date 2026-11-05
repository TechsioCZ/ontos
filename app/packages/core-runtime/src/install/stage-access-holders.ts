import { Effect } from 'effect';

import { stableUuid } from '../access/catalog/stable-id.ts';
import type { BootstrapScope } from '../access/bootstrap/persistence.ts';
import { intentConflict } from '../access/intent/errors.ts';
import type { AccessIntentError } from '../access/intent/errors.ts';
import { durable, runScoped, scopeIssue } from '../access/intent/persistence.ts';
import type { AccessIntentDatabase } from '../access/intent/persistence.ts';
import { AccessMembershipIdSchema } from '../access/intent/memberships.ts';
import type { AccessMembership, AccessMembershipStore } from '../access/intent/memberships.ts';
import { holderKey } from '../access/model.ts';
import type { OperationalScope } from '../operations/context.ts';
import { PrincipalIdSchema, RoleIdSchema, RoleRevisionIdSchema, TenantIdSchema } from '../access/ids.ts';
import type { PrincipalId, RoleId, RoleRevisionId, TenantId } from '../access/ids.ts';
import { accessAssignments } from '../db/schema.ts';

/*
 * The stage accounts a tenant starts beside its owner (ADR-0028, O67-Q6). `bootstrapTenantAccess` gives a
 * tenant one owner holding "Plný přístup"; the operator accounts file may name further people who take
 * part in the same tenant, and until role templates exist each of them holds that same role in every
 * scope. Two rows express it, exactly as they do for the owner:
 *
 * 1. a membership in each scope — management authority still requires membership before it administers
 *    anything (O28), and a person who is not a member of a scope is not a participant of it;
 * 2. an assignment of the tenant's "Plný přístup" role in each scope, with the incarnation id of that
 *    principal's own assignment. Grant incarnations are per role and scope (O51(2), O52) and the owner's
 *    bootstrap wrote them, so a second holder of the same role adds no grant and cannot widen one.
 *
 * Every identity is derived from what it names, so a repeated bootstrap resumes the rows it wrote instead
 * of adding more (D27), and nothing here revives a membership or assignment an administrator ended.
 */

/** The unique indexes an assignment write can collide on; a collision is a re-run, repaired by reading. */
const ASSIGNMENT_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_assignments_pkey',
  'access_assignments_scope_uk',
  'access_assignments_tenant_id_uk',
]);

/** The one role a stage account can hold until role templates exist. */
export const STAGE_ACCOUNT_ROLE_FULL_ACCESS = 'full_access';

/** The assignment incarnation of one holder of one role in one scope: per holder, never shared (D27). */
export const stageAssignmentIncarnationId = (input: {
  readonly principalId: PrincipalId;
  readonly roleId: RoleId;
  readonly scopeId: string;
  readonly tenantId: TenantId;
}): string =>
  stableUuid(
    ['ontos.access.stage.assignment', input.tenantId, input.scopeId, input.roleId, input.principalId].join(':'),
  );

export const stageMembershipId = (input: {
  readonly kind: AccessMembership['kind'];
  readonly principalId: PrincipalId;
  readonly scopeId: string;
  readonly tenantId: TenantId;
}): string =>
  stableUuid(['ontos.access.stage.membership', input.tenantId, input.scopeId, input.kind, input.principalId].join(':'));

/** The scopes a stage account takes part in: the tenant context and every company of the tenant. */
const membershipScopesOf = (scopes: readonly BootstrapScope[]) => scopes;

export interface StageAccountHolder {
  readonly principalId: PrincipalId;
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
  readonly scopes: readonly BootstrapScope[];
  readonly tenantId: TenantId;
  readonly validFrom: Date;
}

/** The memberships one holder starts with: `member` in the tenant context and in every company. */
export const stageHolderMemberships = (input: {
  readonly assignedBy: PrincipalId;
  readonly holder: StageAccountHolder;
}): readonly AccessMembership[] =>
  membershipScopesOf(input.holder.scopes).map((scope): AccessMembership => ({
    createdAt: input.holder.validFrom,
    holder: { _tag: 'Principal', principalId: input.holder.principalId },
    id: AccessMembershipIdSchema.make(
      stageMembershipId({
        kind: 'member',
        principalId: input.holder.principalId,
        scopeId: scope.scopeId,
        tenantId: input.holder.tenantId,
      }),
    ),
    kind: 'member',
    recordedBy: input.assignedBy,
    scopeId: scope.scopeId,
    status: 'active',
    tenantId: input.holder.tenantId,
    validFrom: input.holder.validFrom,
  }));

/**
 * Records the memberships of one stage account, skipping the ones a previous run already wrote. A
 * membership that was suspended or revoked stays as the administrator left it (D27).
 */
export const recordStageHolderMemberships = Effect.fn('StageAccessHolders.recordStageHolderMemberships')(
  function* recordStageHolderMembershipsEffect(
    memberships: Pick<(typeof AccessMembershipStore)['Service'], 'loadTenantMemberships' | 'recordMemberships'>,
    scope: OperationalScope,
    input: { readonly assignedBy: PrincipalId; readonly holder: StageAccountHolder },
  ): Effect.fn.Return<readonly AccessMembership[], AccessIntentError> {
    const wanted = stageHolderMemberships(input);
    const existing = yield* memberships.loadTenantMemberships(scope);
    const present = new Set(
      existing.map((membership) => [membership.scopeId, membership.kind, holderKey(membership.holder)].join(':')),
    );
    const missing = wanted.filter(
      (membership) => !present.has([membership.scopeId, membership.kind, holderKey(membership.holder)].join(':')),
    );
    if (missing.length > 0) {
      yield* memberships.recordMemberships(scope, { memberships: missing });
    }
    return wanted;
  },
);

export interface WriteStageAssignmentsInput {
  readonly assignedBy: PrincipalId;
  readonly holders: readonly StageAccountHolder[];
}

/**
 * Assigns the tenant's "Plný přístup" role to every named stage account in every scope of the tenant.
 * The owner's own assignment is the bootstrap's, so an owner never appears here; a re-run finds the rows
 * it wrote and writes nothing.
 */
export const writeStageAssignments = Effect.fn('StageAccessHolders.writeStageAssignments')(
  function* writeStageAssignmentsEffect(
    database: AccessIntentDatabase,
    scope: OperationalScope,
    input: WriteStageAssignmentsInput,
  ): Effect.fn.Return<void, AccessIntentError> {
    for (const holder of input.holders) {
      const issue = scopeIssue(scope, [holder.tenantId]);
      if (issue !== null) {
        return yield* intentConflict('access_intent_scope_mismatch', issue);
      }
    }
    const rows = input.holders.flatMap((holder) =>
      holder.scopes.map((entry) => ({
        assignedBy: input.assignedBy,
        incarnationId: stageAssignmentIncarnationId({
          principalId: holder.principalId,
          roleId: holder.roleId,
          scopeId: entry.scopeId,
          tenantId: holder.tenantId,
        }),
        principalId: holder.principalId,
        roleId: holder.roleId,
        roleRevisionId: holder.roleRevisionId,
        scopeId: entry.scopeId,
        status: 'active' as const,
        tenantId: holder.tenantId,
        validFrom: holder.validFrom,
      })),
    );
    if (rows.length === 0) {
      return yield* Effect.void;
    }
    return yield* runScoped(database, scope, ASSIGNMENT_UNIQUE_CONSTRAINTS, (transaction) =>
      transaction
        .insert(accessAssignments)
        .values(rows)
        .onConflictDoNothing()
        .pipe(durable(ASSIGNMENT_UNIQUE_CONSTRAINTS), Effect.asVoid),
    );
  },
);

/** The identifiers a stage tenant's authority is named by, as the bootstrap returned them. */
export interface StageTenantAuthority {
  readonly roleId: string;
  readonly roleRevisionId: string;
  readonly tenantId: string;
}

export const stageHolderOf = (input: {
  readonly authority: StageTenantAuthority;
  readonly principalId: string;
  readonly scopes: readonly BootstrapScope[];
  readonly validFrom: Date;
}): StageAccountHolder => ({
  principalId: PrincipalIdSchema.make(input.principalId),
  roleId: RoleIdSchema.make(input.authority.roleId),
  roleRevisionId: RoleRevisionIdSchema.make(input.authority.roleRevisionId),
  scopes: input.scopes,
  tenantId: TenantIdSchema.make(input.authority.tenantId),
  validFrom: input.validFrom,
});
