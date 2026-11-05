import { and, desc, eq, gt, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { DateTime, Effect, Result, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

import {
  accessAgentConnections,
  accessAssignments,
  accessCatalogEntries,
  accessCatalogSnapshots,
  accessDelegations,
  accessMemberships,
  accessRoleRevisions,
  accessRoles,
  accessScopes,
  accessTeamMembers,
  accessTeams,
  principals,
} from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { widestSelectorOf } from '../bootstrap/full-access-role.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import { compileRoleTemplateCells } from '../compiler/cells.ts';
import {
  AccessScopeIdSchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../ids.ts';
import type { AccessScopeId, RoleId, RoleRevisionId, TenantId } from '../ids.ts';
import { lockRoles, writeGrantIncarnations } from '../intent/grant-incarnations.ts';
import type { GrantIncarnationTransaction } from '../intent/grant-incarnations.ts';
import { asDate } from '../intent/persistence.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, CatalogSnapshotEntrySchema, CellSchema } from '../model.ts';
import type { CatalogSnapshot, CatalogSnapshotEntry, Cell } from '../model.ts';
import type { AccessPortalRole } from './portal-role.ts';

/*
 * The portal person's access, written by Core and nobody else (one writer, D9). A module that serves
 * external people — a retail customer bound to a profile, a counterparty's buyer holding a grant — owns
 * the business fact that such a person may use its portal; Core owns what that means for access. When the
 * owner's grant becomes ACTIVE, Core gives the person a membership in the tenant and in the selling company
 * and an assignment of the module's fixed portal role there; when the grant ends, Core ends exactly that
 * assignment, and the memberships it created once nothing else of the person is left in their scope.
 *
 * The rows are written inside the transaction the owner's own Action commits with (O75): the grant and the
 * access it stands for commit together or not at all, and a revocation is effective at its commit even
 * before the projection follows, because every decision reads membership and assignments from this intent
 * first. The projection is reconciled after the commit through the single writer (`portal-projection.ts`).
 *
 * Everything is replay-safe and keeps Core's retained-intent rules:
 * - one owner source (a binding activation, a grant, a redeemed invitation) is one assignment incarnation,
 *   named by the source, so a replay finds the row it wrote and an ended incarnation is never revived;
 * - a membership is written only where the person holds none, named by the assignment it was written for,
 *   so a membership somebody ended stays ended and a later grant is a fresh membership (D27);
 * - a membership Core did not write here, or one beside other live intent of the person, is never ended;
 * - every write for one person runs under that person's row lock, so a grant and a revocation of two
 *   sources of the same person never decide on each other's half-written state.
 *
 * Attribution is a person, as every access row requires: the acting person, or — for work a machine does on
 * a person's behalf, such as an enrollment the Storefront client started — the person the access is for.
 */

export const ACCESS_PORTAL_FAILURE_CODES = [
  /** The portal person is not a principal of this tenant. */
  'access_portal_principal_unknown',
  /** Only a verified human holds a v2 role; a workload or an agent never does (O46). */
  'access_portal_principal_not_a_person',
  /** The tenant context or the company has no access scope, so nothing can be assigned there. */
  'access_portal_scope_missing',
  /** The request names another tenant than the transaction it runs in (O66). */
  'access_portal_scope_mismatch',
  /** No published release carries every capability the portal role declares. */
  'access_portal_role_unreleased',
  /** The portal role does not compile against the release that carries it. */
  'access_portal_role_refused',
  /** The owner grant ends before it could begin, so there is no access to give. */
  'access_portal_grant_expired',
  /** The access intent could not be read or written; retrying the owner's request repeats nothing. */
  'access_portal_unavailable',
] as const;
export type AccessPortalFailureCode = (typeof ACCESS_PORTAL_FAILURE_CODES)[number];

export class AccessPortalError extends Schema.TaggedError<AccessPortalError>()('AccessPortalError', {
  code: Schema.Literals(ACCESS_PORTAL_FAILURE_CODES),
  reason: Schema.String,
}) {}

export const accessPortalRefusal = (code: AccessPortalFailureCode, reason: string, cause?: unknown) => {
  const failure = new AccessPortalError({ code, reason });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { configurable: true, enumerable: false, value: cause });
};

/**
 * The transaction a portal write runs in: the owner Action's own scoped transaction (O75), or one Core opened
 * for the request with its scope installed. Never a second connection beside the owner's.
 */
export type AccessPortalTransaction = Pick<ScopedTransactionExecutor, 'insert' | 'scope' | 'select' | 'update'>;

/** One portal person in one company, standing for one owner grant. */
export interface AccessPortalGrantInput {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly role: AccessPortalRole;
  /**
   * The owner grant this assignment stands for, as a key the owner never gives another grant: a binding
   * activation, a counterparty grant, a redeemed invitation. Replaying the same source finds the assignment
   * it wrote, and ending the source ends exactly that assignment.
   */
  readonly source: string;
  /**
   * When the owner grant ends by itself, such as the expiry of an invitation's claim proof: the assignment
   * ends then too, without anyone having to revoke it.
   */
  readonly validUntil?: Date;
}

/**
 * What one portal write changed: `changed` is false for a replay that found everything in place. The
 * assignment is absent only where Core never wrote one: a revocation for a person or a company it does not know.
 */
export interface AccessPortalReceipt {
  readonly assignmentIncarnationId?: string;
  readonly changed: boolean;
}

export interface AccessPortalWrites {
  /** The owner grant is ACTIVE: the person holds the portal role in the company and is a member there. */
  readonly grant: (input: AccessPortalGrantInput) => Effect.Effect<AccessPortalReceipt, AccessPortalError>;
  /** The owner grant ended: its assignment ends, and so do the memberships nothing else keeps. */
  readonly revoke: (input: AccessPortalGrantInput) => Effect.Effect<AccessPortalReceipt, AccessPortalError>;
}

/** A driver failure is the intent store being unavailable; a retry of the owner's request repeats nothing. */
const unavailable =
  (reason: string) =>
  <Value>(effect: Effect.Effect<Value, EffectDrizzleQueryError | SqlError>): Effect.Effect<Value, AccessPortalError> =>
    effect.pipe(Effect.mapError((cause) => accessPortalRefusal('access_portal_unavailable', reason, cause)));

/** The tenant-wide identity of a module's portal role: one role per tenant and key. */
export const accessPortalRoleId = (tenantId: TenantId, roleKey: string): RoleId =>
  RoleIdSchema.make(stableUuid(['ontos.access.portal.role', tenantId, roleKey].join(':')));

const portalRoleRevisionId = (tenantId: TenantId, roleId: RoleId, catalogSnapshotId: string): RoleRevisionId =>
  RoleRevisionIdSchema.make(
    stableUuid(['ontos.access.portal.role-revision', tenantId, roleId, catalogSnapshotId].join(':')),
  );

/** One owner source in one company scope: the assignment incarnation it stands for, never reused. */
export const accessPortalAssignmentId = (input: {
  readonly principalId: string;
  readonly roleId: RoleId;
  readonly scopeId: AccessScopeId;
  readonly source: string;
  readonly tenantId: TenantId;
}): string =>
  stableUuid(
    [
      'ontos.access.portal.assignment',
      input.tenantId,
      input.scopeId,
      input.roleId,
      input.principalId,
      input.source,
    ].join(':'),
  );

/** A membership Core writes for one portal assignment: named by it, so Core recognises its own rows. */
const portalMembershipId = (input: {
  readonly assignmentIncarnationId: string;
  readonly principalId: string;
  readonly scopeId: string;
  readonly tenantId: TenantId;
}): string =>
  stableUuid(
    [
      'ontos.access.portal.membership',
      input.tenantId,
      input.scopeId,
      input.principalId,
      input.assignmentIncarnationId,
    ].join(':'),
  );

/** The two scopes a company decision rests on: the tenant context and the company itself (D6). */
interface PortalScopes {
  readonly company: AccessScopeId;
  readonly tenantContext: AccessScopeId;
}

const readPortalScopes = Effect.fn('AccessPortal.readScopes')(function* readPortalScopesEffect(
  transaction: AccessPortalTransaction,
  tenantId: TenantId,
  legalEntityId: string,
) {
  const rows = yield* transaction
    .select({
      legalEntityId: accessScopes.legalEntityId,
      scopeId: accessScopes.scopeId,
      tenantContextId: accessScopes.tenantContextId,
    })
    .from(accessScopes)
    .where(eq(accessScopes.tenantId, tenantId))
    .pipe(unavailable('The access scopes of the tenant could not be read'));
  const tenantContext = rows.find((row) => row.tenantContextId !== null)?.scopeId;
  const company = rows.find((row) => row.legalEntityId === legalEntityId)?.scopeId;
  return tenantContext === undefined || company === undefined
    ? undefined
    : ({
        company: AccessScopeIdSchema.make(company),
        tenantContext: AccessScopeIdSchema.make(tenantContext),
      } satisfies PortalScopes);
});

/**
 * The person under the row lock every portal write of that person takes first, so two writes for one person
 * (a grant and a revocation of two of its sources) serialize instead of deciding on each other's half.
 */
const lockPrincipal = Effect.fn('AccessPortal.lockPrincipal')(function* lockPrincipalEffect(
  transaction: AccessPortalTransaction,
  tenantId: TenantId,
  principalId: string,
) {
  const [row] = yield* transaction
    .select({ kind: principals.kind })
    .from(principals)
    .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId)))
    .for('update')
    .pipe(unavailable('The portal person could not be locked'));
  return row;
});

/** The person a portal row is attributed to: the acting person, or the person a machine acted for. */
const attributionOf = Effect.fn('AccessPortal.attribution')(function* attributionEffect(
  transaction: AccessPortalTransaction,
  scope: OperationalScope,
  tenantId: TenantId,
  principalId: string,
) {
  if (scope.principalId === principalId) {
    return principalId;
  }
  const [actor] = yield* transaction
    .select({ kind: principals.kind })
    .from(principals)
    .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, scope.principalId)))
    .pipe(unavailable('The acting principal could not be read'));
  return actor?.kind === 'human' ? scope.principalId : principalId;
});

const decodeEntry = Schema.decodeUnknownResult(CatalogSnapshotEntrySchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeCells = Schema.decodeUnknownResult(Schema.Array(CellSchema), ACCESS_MODEL_PARSE_OPTIONS);

interface ReleaseEntryRow {
  readonly catalogSnapshotId: string;
  readonly digest: string;
  readonly entryJson: unknown;
  readonly publishedAt: Date | string;
}

/**
 * The newest published release that carries every capability of the role, restricted to those entries: the
 * only release the role's cells may be pinned to (O1). A release is global, so this is never a tenant read.
 */
export const portalRoleRelease = (
  role: AccessPortalRole,
  rows: readonly ReleaseEntryRow[],
): Result.Result<CatalogSnapshot, AccessPortalError> => {
  const bySnapshot = new Map<
    string,
    { readonly digest: string; readonly entries: unknown[]; readonly publishedAt: Date }
  >();
  for (const row of rows) {
    const known = bySnapshot.get(row.catalogSnapshotId);
    if (known === undefined) {
      bySnapshot.set(row.catalogSnapshotId, {
        digest: row.digest,
        entries: [row.entryJson],
        publishedAt: asDate(row.publishedAt),
      });
    } else {
      known.entries.push(row.entryJson);
    }
  }
  const [newest] = [...bySnapshot.entries()]
    .filter(([, release]) => release.entries.length === role.capabilities.length)
    .toSorted(
      ([leftId, left], [rightId, right]) =>
        right.publishedAt.getTime() - left.publishedAt.getTime() || rightId.localeCompare(leftId),
    );
  if (newest === undefined) {
    return Result.fail(
      accessPortalRefusal(
        'access_portal_role_unreleased',
        `No published release carries every capability of portal role ${role.key}`,
      ),
    );
  }
  const [catalogSnapshotId, release] = newest;
  const entries: CatalogSnapshotEntry[] = [];
  for (const entry of release.entries) {
    const decoded = decodeEntry(entry);
    if (Result.isFailure(decoded)) {
      return Result.fail(
        accessPortalRefusal('access_portal_role_refused', `A release entry of ${role.key} is not a catalog entry`),
      );
    }
    entries.push(decoded.success);
  }
  return Result.succeed({
    digest: CatalogDigestSchema.make(release.digest),
    entries,
    id: CatalogSnapshotIdSchema.make(catalogSnapshotId),
    publishedAt: release.publishedAt,
  });
};

/**
 * The portal role as cells: every declared capability, run mode only, at the widest selector its declaration
 * names — the module's owner rule narrows the records, the role only opens the capability (O70).
 */
export const compilePortalRole = (
  role: AccessPortalRole,
  release: CatalogSnapshot,
): Result.Result<readonly Cell[], AccessPortalError> => {
  const entries = new Map(release.entries.map((entry) => [entry.key, entry] as const));
  const compiled = compileRoleTemplateCells(
    {
      limits: [],
      rows: [],
      switches: role.capabilities.map((capabilityKey) => {
        const entry = entries.get(capabilityKey);
        return entry === undefined
          ? { capabilityKey, modes: ['run'] as const }
          : { capabilityKey, modes: ['run'] as const, selector: widestSelectorOf(entry) };
      }),
      templateKey: role.key,
    },
    release,
  );
  return Result.isFailure(compiled)
    ? Result.fail(
        accessPortalRefusal(
          'access_portal_role_refused',
          compiled.failure.map((failure) => `${failure.code}: ${failure.reason}`).join('; '),
        ),
      )
    : Result.succeed(compiled.success.cells);
};

/** The role's revision that expresses it now: the highest number, pinned by every new assignment. */
interface PortalRoleHead {
  readonly cells: readonly Cell[];
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
}

/**
 * The tenant's role for this portal role, written the first time a person needs it: the role and its first
 * revision, pinned to the release that carries it. A role that exists is kept exactly as it is — the module's
 * declaration never rewrites a role somebody may already hold (guarantee 2).
 */
const ensurePortalRole = Effect.fn('AccessPortal.ensureRole')(function* ensurePortalRoleEffect(
  transaction: AccessPortalTransaction,
  input: {
    readonly at: Date;
    readonly attributedTo: string;
    readonly role: AccessPortalRole;
    readonly tenantId: TenantId;
  },
) {
  const roleId = accessPortalRoleId(input.tenantId, input.role.key);
  const [existing] = yield* transaction
    .select({ roleId: accessRoles.roleId })
    .from(accessRoles)
    .where(and(eq(accessRoles.tenantId, input.tenantId), eq(accessRoles.roleId, roleId)))
    .pipe(unavailable('The portal role could not be read'));
  if (existing === undefined) {
    const rows = yield* transaction
      .select({
        catalogSnapshotId: accessCatalogEntries.catalogSnapshotId,
        digest: accessCatalogSnapshots.digest,
        entryJson: accessCatalogEntries.entryJson,
        publishedAt: accessCatalogSnapshots.publishedAt,
      })
      .from(accessCatalogEntries)
      .innerJoin(
        accessCatalogSnapshots,
        eq(accessCatalogSnapshots.catalogSnapshotId, accessCatalogEntries.catalogSnapshotId),
      )
      .where(inArray(accessCatalogEntries.capabilityKey, [...input.role.capabilities]))
      .pipe(unavailable('The releases of the portal role could not be read'));
    const release = yield* Effect.fromResult(portalRoleRelease(input.role, rows));
    const cells = yield* Effect.fromResult(compilePortalRole(input.role, release));
    yield* transaction
      .insert(accessRoles)
      .values({
        createdAt: input.at,
        createdBy: input.attributedTo,
        name: input.role.name,
        roleId,
        tenantId: input.tenantId,
      })
      .onConflictDoNothing()
      .pipe(unavailable('The portal role could not be written'));
    yield* transaction
      .insert(accessRoleRevisions)
      .values({
        catalogSnapshotId: release.id,
        cellsJson: [...cells],
        createdAt: input.at,
        createdBy: input.attributedTo,
        provenance: 'template',
        revision: 1,
        roleId,
        roleRevisionId: portalRoleRevisionId(input.tenantId, roleId, release.id),
        templateKey: input.role.key,
        tenantId: input.tenantId,
      })
      .onConflictDoNothing()
      .pipe(unavailable('The portal role revision could not be written'));
  }
  const [head] = yield* transaction
    .select({ cellsJson: accessRoleRevisions.cellsJson, roleRevisionId: accessRoleRevisions.roleRevisionId })
    .from(accessRoleRevisions)
    .where(and(eq(accessRoleRevisions.tenantId, input.tenantId), eq(accessRoleRevisions.roleId, roleId)))
    .orderBy(desc(accessRoleRevisions.revision))
    .limit(1)
    .pipe(unavailable('The portal role revision could not be read'));
  if (head === undefined) {
    return yield* accessPortalRefusal('access_portal_role_refused', `Portal role ${input.role.key} has no revision`);
  }
  const cells = decodeCells(head.cellsJson);
  if (Result.isFailure(cells)) {
    return yield* accessPortalRefusal('access_portal_role_refused', `Portal role ${input.role.key} has invalid cells`);
  }
  return {
    cells: cells.success,
    roleId,
    roleRevisionId: RoleRevisionIdSchema.make(head.roleRevisionId),
  } satisfies PortalRoleHead;
});

/**
 * A live `member` membership of the person in one scope, if the person holds one. A membership past its
 * `validUntil` no longer admits anyone (the projection drops it), so it is not one; a suspended one still is,
 * so a portal grant never overrides an administrator's suspension.
 */
const liveMembershipOf = Effect.fn('AccessPortal.liveMembership')(function* liveMembershipEffect(
  transaction: AccessPortalTransaction,
  input: { readonly at: Date; readonly principalId: string; readonly scopeId: string; readonly tenantId: TenantId },
) {
  const [row] = yield* transaction
    .select({ membershipId: accessMemberships.membershipId })
    .from(accessMemberships)
    .where(
      and(
        eq(accessMemberships.tenantId, input.tenantId),
        eq(accessMemberships.scopeId, input.scopeId),
        eq(accessMemberships.principalId, input.principalId),
        eq(accessMemberships.kind, 'member'),
        ne(accessMemberships.status, 'revoked'),
        or(isNull(accessMemberships.validUntil), gt(accessMemberships.validUntil, input.at)),
      ),
    )
    .pipe(unavailable('The membership of the portal person could not be read'));
  return row?.membershipId;
});

/**
 * Membership where the person holds none: one row, named by the assignment it is written for. A membership
 * this assignment already wrote and somebody ended stays ended, because its identity is taken (D27).
 */
const ensureMembership = Effect.fn('AccessPortal.ensureMembership')(function* ensureMembershipEffect(
  transaction: AccessPortalTransaction,
  input: {
    readonly assignmentIncarnationId: string;
    readonly at: Date;
    readonly attributedTo: string;
    readonly principalId: string;
    readonly scopeId: AccessScopeId;
    readonly tenantId: TenantId;
  },
) {
  const live = yield* liveMembershipOf(transaction, input);
  if (live !== undefined) {
    return false;
  }
  // A membership whose time ran out admits nobody, yet it still holds the one open place a person has in a
  // scope. It is recorded as ended, which is what it already is, so the new membership can be written.
  yield* transaction
    .update(accessMemberships)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(accessMemberships.tenantId, input.tenantId),
        eq(accessMemberships.scopeId, input.scopeId),
        eq(accessMemberships.principalId, input.principalId),
        eq(accessMemberships.kind, 'member'),
        ne(accessMemberships.status, 'revoked'),
        lte(accessMemberships.validUntil, input.at),
      ),
    )
    .pipe(unavailable('The lapsed membership of the portal person could not be ended'));
  const written = yield* transaction
    .insert(accessMemberships)
    .values({
      agentId: null,
      createdAt: input.at,
      kind: 'member',
      membershipId: portalMembershipId(input),
      principalId: input.principalId,
      recordedBy: input.attributedTo,
      scopeId: input.scopeId,
      status: 'active',
      tenantId: input.tenantId,
      validFrom: input.at,
      validUntil: null,
    })
    .onConflictDoNothing()
    .returning({ membershipId: accessMemberships.membershipId })
    .pipe(unavailable('The membership of the portal person could not be written'));
  return written.length > 0;
});

/**
 * Whether anything of the person still lives in one scope besides the `member` row this module may end: an
 * active assignment, a management membership, a team place, a delegation it manages or an agent connection.
 * Any of these keeps the membership, because leaving a scope would have to end it too. A row whose own time
 * has run out is not live, though its status still says so: an invitee assignment that lapsed with its claim
 * proof keeps nothing.
 */
const holdsOtherIntent = Effect.fn('AccessPortal.holdsOtherIntent')(function* holdsOtherIntentEffect(
  transaction: AccessPortalTransaction,
  input: {
    readonly at: Date;
    readonly principalId: string;
    readonly scopeIds: readonly string[];
    readonly tenantId: TenantId;
  },
) {
  const [assignments, management, teamPlaces, delegations, connections] = yield* Effect.all(
    [
      transaction
        .select({ id: accessAssignments.incarnationId })
        .from(accessAssignments)
        .where(
          and(
            eq(accessAssignments.tenantId, input.tenantId),
            eq(accessAssignments.principalId, input.principalId),
            eq(accessAssignments.status, 'active'),
            or(isNull(accessAssignments.validUntil), gt(accessAssignments.validUntil, input.at)),
            inArray(accessAssignments.scopeId, [...input.scopeIds]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: accessMemberships.membershipId })
        .from(accessMemberships)
        .where(
          and(
            eq(accessMemberships.tenantId, input.tenantId),
            eq(accessMemberships.principalId, input.principalId),
            ne(accessMemberships.kind, 'member'),
            ne(accessMemberships.status, 'revoked'),
            or(isNull(accessMemberships.validUntil), gt(accessMemberships.validUntil, input.at)),
            inArray(accessMemberships.scopeId, [...input.scopeIds]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: accessTeamMembers.teamMemberId })
        .from(accessTeamMembers)
        .innerJoin(
          accessTeams,
          and(eq(accessTeams.tenantId, accessTeamMembers.tenantId), eq(accessTeams.teamId, accessTeamMembers.teamId)),
        )
        .where(
          and(
            eq(accessTeamMembers.tenantId, input.tenantId),
            eq(accessTeamMembers.principalId, input.principalId),
            inArray(accessTeams.scopeId, [...input.scopeIds]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: accessDelegations.delegationId })
        .from(accessDelegations)
        .where(
          and(
            eq(accessDelegations.tenantId, input.tenantId),
            eq(accessDelegations.managerId, input.principalId),
            eq(accessDelegations.status, 'active'),
            gt(accessDelegations.until, input.at),
            inArray(accessDelegations.scopeId, [...input.scopeIds]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: accessAgentConnections.connectionId })
        .from(accessAgentConnections)
        .where(
          and(
            eq(accessAgentConnections.tenantId, input.tenantId),
            eq(accessAgentConnections.principalId, input.principalId),
            eq(accessAgentConnections.status, 'active'),
            gt(accessAgentConnections.validUntil, input.at),
            inArray(accessAgentConnections.scopeId, [...input.scopeIds]),
          ),
        )
        .limit(1),
    ],
    { concurrency: 1 },
  ).pipe(unavailable('The access intent of the portal person could not be read'));
  return [assignments, management, teamPlaces, delegations, connections].some((rows) => rows.length > 0);
});

/**
 * Ends the membership Core wrote for this person in one scope, when nothing else of the person lives there. A
 * membership is Core's only when its identity is the one Core derives from one of the person's assignments, so
 * a membership an administrator recorded is never ended here.
 */
const endPortalMembership = Effect.fn('AccessPortal.endMembership')(function* endPortalMembershipEffect(
  transaction: AccessPortalTransaction,
  input: {
    readonly assignmentIds: readonly string[];
    readonly at: Date;
    readonly keepScopeIds: readonly string[];
    readonly principalId: string;
    readonly scopeId: string;
    readonly tenantId: TenantId;
  },
) {
  if (yield* holdsOtherIntent(transaction, { ...input, scopeIds: [input.scopeId, ...input.keepScopeIds] })) {
    return false;
  }
  const live = yield* liveMembershipOf(transaction, input);
  const ownIds = new Set(
    input.assignmentIds.map((assignmentIncarnationId) => portalMembershipId({ ...input, assignmentIncarnationId })),
  );
  if (live === undefined || !ownIds.has(live)) {
    return false;
  }
  const ended = yield* transaction
    .update(accessMemberships)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(accessMemberships.tenantId, input.tenantId),
        eq(accessMemberships.membershipId, live),
        ne(accessMemberships.status, 'revoked'),
      ),
    )
    .returning({ membershipId: accessMemberships.membershipId })
    .pipe(unavailable('The membership of the portal person could not be ended'));
  return ended.length > 0;
});

/** Ends one assignment incarnation if it is still active; an ended one stays as it is. */
const endAssignment = (transaction: AccessPortalTransaction, tenantId: TenantId, incarnationId: string) =>
  transaction
    .update(accessAssignments)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(accessAssignments.tenantId, tenantId),
        eq(accessAssignments.incarnationId, incarnationId),
        eq(accessAssignments.status, 'active'),
      ),
    )
    .returning({ incarnationId: accessAssignments.incarnationId })
    .pipe(
      Effect.map((ended) => ended.length > 0),
      unavailable('The portal assignment could not be ended'),
    );

/** Every assignment incarnation the person ever held: the identities Core's own memberships derive from. */
const readAssignmentIdsOf = (transaction: AccessPortalTransaction, tenantId: TenantId, principalId: string) =>
  transaction
    .select({ incarnationId: accessAssignments.incarnationId })
    .from(accessAssignments)
    .where(and(eq(accessAssignments.tenantId, tenantId), eq(accessAssignments.principalId, principalId)))
    .pipe(
      Effect.map((rows) => rows.map(({ incarnationId }) => incarnationId)),
      unavailable('The assignments of the portal person could not be read'),
    );

/** The company scopes of the tenant: every scope but its tenant context. */
const readCompanyScopeIdsOf = (
  transaction: AccessPortalTransaction,
  tenantId: TenantId,
  tenantContextScopeId: string,
) =>
  transaction
    .select({ scopeId: accessScopes.scopeId })
    .from(accessScopes)
    .where(and(eq(accessScopes.tenantId, tenantId), ne(accessScopes.scopeId, tenantContextScopeId)))
    .pipe(
      Effect.map((rows) => rows.map((row) => row.scopeId)),
      unavailable('The access scopes of the tenant could not be read'),
    );

/**
 * The tenant context keeps the person while any company of the tenant still does: membership there is the
 * path every company decision rests on (D6).
 */
const endTenantContextMembership = (
  transaction: AccessPortalTransaction,
  input: {
    readonly assignmentIds: readonly string[];
    readonly at: Date;
    readonly companyScopeIds: readonly string[];
    readonly principalId: string;
    readonly tenantContextScopeId: string;
    readonly tenantId: TenantId;
  },
) =>
  Effect.forEach(
    input.companyScopeIds,
    (scopeId) =>
      liveMembershipOf(transaction, {
        at: input.at,
        principalId: input.principalId,
        scopeId,
        tenantId: input.tenantId,
      }),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((companyMemberships) =>
      companyMemberships.some((membershipId) => membershipId !== undefined)
        ? Effect.succeed(false)
        : endPortalMembership(transaction, {
            assignmentIds: input.assignmentIds,
            at: input.at,
            keepScopeIds: input.companyScopeIds,
            principalId: input.principalId,
            scopeId: input.tenantContextScopeId,
            tenantId: input.tenantId,
          }),
    ),
  );

const scopeIssueOf = (scope: OperationalScope, transaction: AccessPortalTransaction) =>
  transaction.scope.tenantId === scope.tenantId
    ? undefined
    : accessPortalRefusal(
        'access_portal_scope_mismatch',
        `The portal write names tenant ${scope.tenantId} inside a transaction of tenant ${transaction.scope.tenantId}`,
      );

/**
 * The portal writes of one owner transaction. `scope` is the trusted request scope of the owner Action: its
 * tenant is the only tenant written, and its principal is the actor the rows are attributed to.
 */
export const accessPortalWritesForTransaction = (
  transaction: AccessPortalTransaction,
  scope: OperationalScope,
): AccessPortalWrites => {
  const tenantId = TenantIdSchema.make(scope.tenantId);
  const moves: GrantIncarnationTransaction = transaction;

  const grant = Effect.fn('AccessPortal.grant')(function* grantEffect(input: AccessPortalGrantInput) {
    const issue = scopeIssueOf(scope, transaction);
    if (issue !== undefined) {
      return yield* issue;
    }
    const person = yield* lockPrincipal(transaction, tenantId, input.principalId);
    if (person === undefined) {
      return yield* accessPortalRefusal(
        'access_portal_principal_unknown',
        `Principal ${input.principalId} is not a principal of tenant ${tenantId}`,
      );
    }
    if (person.kind !== 'human') {
      return yield* accessPortalRefusal(
        'access_portal_principal_not_a_person',
        `Principal ${input.principalId} is a ${person.kind}; only a person holds a portal role`,
      );
    }
    const scopes = yield* readPortalScopes(transaction, tenantId, input.legalEntityId);
    if (scopes === undefined) {
      return yield* accessPortalRefusal(
        'access_portal_scope_missing',
        `Tenant ${tenantId} has no access scope for its context and company ${input.legalEntityId}`,
      );
    }
    const at = yield* DateTime.nowAsDate;
    if (input.validUntil !== undefined && input.validUntil <= at) {
      return yield* accessPortalRefusal(
        'access_portal_grant_expired',
        `The owner grant ${input.source} ended before its access could begin`,
      );
    }
    const attributedTo = yield* attributionOf(transaction, scope, tenantId, input.principalId);
    // The role's head is read under the same shared role lock an assignment takes, so a concurrent
    // revision cannot commit between the head this grant pins and its insert.
    yield* lockRoles(transaction, {
      mode: 'share',
      roleIds: [accessPortalRoleId(tenantId, input.role.key)],
      tenantId,
    }).pipe(unavailable('The portal role could not be locked'));
    const role = yield* ensurePortalRole(transaction, { at, attributedTo, role: input.role, tenantId });
    const assignmentIncarnationId = accessPortalAssignmentId({
      principalId: input.principalId,
      roleId: role.roleId,
      scopeId: scopes.company,
      source: input.source,
      tenantId,
    });
    const [existing] = yield* transaction
      .select({ status: accessAssignments.status })
      .from(accessAssignments)
      .where(
        and(eq(accessAssignments.tenantId, tenantId), eq(accessAssignments.incarnationId, assignmentIncarnationId)),
      )
      .pipe(unavailable('The portal assignment could not be read'));
    if (existing !== undefined) {
      // A replay of the same source: the incarnation exists, live or ended, and nothing is written again.
      return { assignmentIncarnationId, changed: false };
    }
    // The role's cells are witnessed in the company only through their grant incarnations (guarantee 9).
    yield* writeGrantIncarnations(moves, {
      addedCells: role.cells,
      removedCells: [],
      roleId: role.roleId,
      scopeIds: [scopes.company],
      targetRevisionId: role.roleRevisionId,
      tenantId,
    }).pipe(unavailable('The grant incarnations of the portal role could not be written'));
    yield* transaction
      .insert(accessAssignments)
      .values({
        agentId: null,
        assignedBy: attributedTo,
        delegatedBy: null,
        delegationEnvelopeJson: null,
        incarnationId: assignmentIncarnationId,
        principalId: input.principalId,
        roleId: role.roleId,
        roleRevisionId: role.roleRevisionId,
        scopeId: scopes.company,
        status: 'active',
        tenantId,
        validFrom: at,
        validUntil: input.validUntil ?? null,
      })
      .pipe(unavailable('The portal assignment could not be written'));
    // One membership per scope, written one after the other in the owner's transaction.
    yield* Effect.forEach(
      [scopes.tenantContext, scopes.company],
      (scopeId) =>
        ensureMembership(transaction, {
          assignmentIncarnationId,
          at,
          attributedTo,
          principalId: input.principalId,
          scopeId,
          tenantId,
        }),
      { concurrency: 1, discard: true },
    );
    return { assignmentIncarnationId, changed: true };
  });

  const revoke = Effect.fn('AccessPortal.revoke')(function* revokeEffect(input: AccessPortalGrantInput) {
    const issue = scopeIssueOf(scope, transaction);
    if (issue !== undefined) {
      return yield* issue;
    }
    const roleId = accessPortalRoleId(tenantId, input.role.key);
    const person = yield* lockPrincipal(transaction, tenantId, input.principalId);
    const scopes = yield* readPortalScopes(transaction, tenantId, input.legalEntityId);
    if (person === undefined || scopes === undefined) {
      // Nothing was ever written for a person or a company Core does not know: there is nothing to end.
      return { changed: false };
    }
    const assignmentIncarnationId = accessPortalAssignmentId({
      principalId: input.principalId,
      roleId,
      scopeId: scopes.company,
      source: input.source,
      tenantId,
    });
    // Neither the person's assignment identities nor the tenant's companies change when this source ends, so
    // both are read first; the writes then run in order, each deciding on what the one before left.
    const [assignmentIds, companyScopeIds] = yield* Effect.all(
      [
        readAssignmentIdsOf(transaction, tenantId, input.principalId),
        readCompanyScopeIdsOf(transaction, tenantId, scopes.tenantContext),
      ],
      { concurrency: 1 },
    );
    const at = yield* DateTime.nowAsDate;
    const membership = { assignmentIds, at, principalId: input.principalId, tenantId };
    const changed = yield* endAssignment(transaction, tenantId, assignmentIncarnationId).pipe(
      Effect.flatMap((assignmentEnded) =>
        endPortalMembership(transaction, { ...membership, keepScopeIds: [], scopeId: scopes.company }).pipe(
          Effect.map((companyEnded) => assignmentEnded || companyEnded),
        ),
      ),
      Effect.flatMap((endedSoFar) =>
        endTenantContextMembership(transaction, {
          ...membership,
          companyScopeIds,
          tenantContextScopeId: scopes.tenantContext,
        }).pipe(Effect.map((tenantEnded) => endedSoFar || tenantEnded)),
      ),
    );
    return { assignmentIncarnationId, changed };
  });

  return Object.freeze({ grant, revoke });
};
