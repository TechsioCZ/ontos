import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { DateTime, Effect, Match, Option } from 'effect';

import { accessAssignments, accessMemberships, accessScopes } from '../../db/schema.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AuthorityCell } from '../decision/authority.ts';
import { withOptional } from '../decision/optional.ts';
import { holderEquals } from '../decision/selector.ts';
import type { AccessRecordProjectionPort } from '../enforcement/record-projection-port.ts';
import { readRecordProjection } from '../enforcement/record-projection-port.ts';
import type { AccessScopeId, CapabilityKey, RecordKey, RoleId, RoleRevisionId, TenantId } from '../ids.ts';
import { RoleIdSchema, RoleRevisionIdSchema, TenantIdSchema } from '../ids.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import { asDate } from '../intent/persistence.ts';
import type { AccessTransactions } from '../intent/persistence.ts';
import type { TenantIntentLoaderService } from '../intent/tenant-intent-loader.ts';
import type { AccessMode, AuthorityWitness, Cell, CellSelector, Holder } from '../model.ts';
import { witnessPurposeMode } from '../model.ts';
import { ApprovalAuthorityUnavailableError } from './errors.ts';
import type { WitnessFacts } from './execution.ts';
import type { LivePublishedCatalog } from './live-catalog.ts';
import type { ApprovalAuthorityInspector, ProposalScope } from './service.ts';

/*
 * The live witness inspector: what Core's own intent reports about the exact assignment incarnations,
 * grant cells, role bindings and memberships a proposal bound (O48, O49, R2-H1). It states facts and
 * never a verdict — `witnessAuthorityOf` decides — so a different holder's assignment, a grant cell of
 * another role, a retired incarnation, a company witness without the company's own membership, a
 * suspension anywhere on the membership path and an expired deadline are all facts this adapter
 * states truthfully, and the one shipped verdict refuses them.
 *
 * Three provenances feed it, each of them shipped:
 *
 * - the live cells of one holder, capability, mode and scope come from the intent loader's
 *   `loadAuthorityCells`, so the revision, the delegation envelope, the slot incarnation and the
 *   amount ceiling are resolved exactly as the one gate resolves them (guarantee 9, D10b);
 * - the membership path comes from the raw `access_memberships` rows, because a company command rests
 *   on BOTH the company's own membership and the tenant context's (D6, M2); a boolean answered for
 *   "either scope" would let a tenant-only member witness a company command it never joined;
 * - the reach of a record-scoped cell comes from the owner's projection of that record (H3, D32). A
 *   composition that bound no projection answers "unanswered", never "reaches".
 *
 * A read that fails is `ApprovalAuthorityUnavailableError`, the retryable failure the approvals
 * service keeps distinct from a refusal, and never an empty or lenient fact set.
 *
 * WHERE those reads run is the caller's: a source over `requestTransactions` answers in a transaction
 * of the request scope per read, and one over `callerTransactions(ownerTransaction)` answers inside the
 * transaction whose mandate is being claimed (O75). The queries and the verdict are the same code in
 * both, so a joined claim cannot be proved by a weaker rule than an ordinary approval.
 */

const authorityUnavailable = (reason: string) =>
  new ApprovalAuthorityUnavailableError({ code: 'approval_authority_unavailable', reason });

const intentUnavailable = (failure: AccessIntentError): ApprovalAuthorityUnavailableError =>
  authorityUnavailable(`${failure.code}: ${failure.reason}`);

/** The owner's projection could not be read, which is the same retryable unavailability as any other. */
const projectionUnavailable = (failure: { readonly reason: string }): ApprovalAuthorityUnavailableError =>
  authorityUnavailable(failure.reason);

/** The tenant of a request scope as the access model brands it. */
const tenantIdOf = (scope: OperationalScope): TenantId => TenantIdSchema.make(scope.tenantId);

/** One scope of the tenant, as `access_scopes` states it: a company, or the tenant context itself. */
export interface ScopeRow {
  readonly legalEntityId: string | null;
  readonly scopeId: string;
}

/** The scopes one holder must be a live member of for a command in `scopeId` to be theirs (D6, M2). */
export interface LiveMembershipPath {
  readonly requiredScopeIds: readonly string[];
}

/**
 * The membership path of one exact scope: a company command rests on the company's own membership and
 * on the tenant context's, and a tenant-context command on that membership alone. A scope this tenant
 * does not own has no path at all, which is never read as "no membership needed".
 */
export const membershipPathOf = (rows: readonly ScopeRow[], scopeId: string): Option.Option<LiveMembershipPath> => {
  const scopeRow = rows.find((row) => row.scopeId === scopeId);
  if (scopeRow === undefined) {
    return Option.none();
  }
  if (scopeRow.legalEntityId === null) {
    return Option.some({ requiredScopeIds: [scopeRow.scopeId] });
  }
  const tenantScopeId = rows.find((row) => row.legalEntityId === null)?.scopeId;
  return tenantScopeId === undefined
    ? Option.none()
    : Option.some({ requiredScopeIds: [scopeRow.scopeId, tenantScopeId] });
};

/** The membership rows of one holder in one tenant, as the path predicate needs them. */
export interface LiveMembershipRow {
  readonly agentId: string | null;
  readonly kind: string;
  readonly principalId: string | null;
  readonly scopeId: string;
  readonly status: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
}

/** The two facts the membership rows state: where the holder is a member, and where it is suspended. */
export interface LiveMembershipFacts {
  readonly memberScopeIds: ReadonlySet<string>;
  readonly suspendedScopeIds: ReadonlySet<string>;
}

/** A row is live from its start to its end; a row that has not begun or has ended states nothing (D6). */
const rowIsLive = (row: LiveMembershipRow, at: Date): boolean =>
  row.validFrom <= at && (row.validUntil === null || at < row.validUntil);

/** The holder a membership row really belongs to; SQL keeps exactly one of a person and an agent. */
const rowIsHolder = (row: LiveMembershipRow, holder: Holder): boolean =>
  Match.value(holder).pipe(
    Match.tags({
      Agent: ({ agentId }) => row.agentId === agentId && row.principalId === null,
      Principal: ({ principalId }) => row.principalId === principalId && row.agentId === null,
    }),
    Match.exhaustive,
  );

/**
 * What the rows state for one holder: the scopes it is an active member of, and the scopes where a
 * live suspension subtracts that membership. Suspension anywhere on the path wins (D27), so the two
 * sets stay apart instead of one pre-decided boolean.
 */
export const membershipFactsOf = (input: {
  readonly at: Date;
  readonly holder: Holder;
  readonly rows: readonly LiveMembershipRow[];
}): LiveMembershipFacts => {
  const memberScopeIds = new Set<string>();
  const suspendedScopeIds = new Set<string>();
  for (const row of input.rows) {
    if (!rowIsHolder(row, input.holder) || !rowIsLive(row, input.at)) {
      continue;
    }
    if (row.status === 'suspended') {
      suspendedScopeIds.add(row.scopeId);
    }
    if (row.kind === 'member' && row.status === 'active') {
      memberScopeIds.add(row.scopeId);
    }
  }
  return Object.freeze({ memberScopeIds, suspendedScopeIds });
};

/** Every scope of the path needs the holder's own live membership, and none of them a suspension. */
export const holdsMembershipPath = (facts: LiveMembershipFacts, path: LiveMembershipPath): boolean =>
  path.requiredScopeIds.every((scopeId) => facts.memberScopeIds.has(scopeId) && !facts.suspendedScopeIds.has(scopeId));

/**
 * The reach a selector decides on its own: `all` covers the whole scope and `targets` names its
 * records, so neither needs the owner's projection. A record-scoped selector is answered there.
 */
export const localReachOf = (selector: CellSelector, target: RecordKey): Option.Option<boolean> =>
  Match.value(selector).pipe(
    Match.tag('targets', ({ recordKeys }) => Option.some(recordKeys.includes(target))),
    Match.tag('all', () => Option.some(true)),
    Match.orElse(() => Option.none<boolean>()),
  );

/** The facts of a witness no live cell proves: a definite loss, never an assumption (R2-H1). */
export const lostWitnessFacts = (witness: AuthorityWitness): WitnessFacts => ({
  assignmentRoleRevisionId: null,
  assignmentScopeId: null,
  assignmentState: 'lost',
  grantCell: null,
  grantRoleRevisionId: null,
  grantScopeId: null,
  grantState: 'lost',
  holderId: null,
  reachesTarget: null,
  witness,
});

/** The grant cell one live authority cell carries, as the verdict reads it. */
const cellOf = (cell: AuthorityCell): Cell =>
  withOptional(
    { capabilityKey: cell.capabilityKey, mode: cell.mode, selector: cell.selector },
    'amountCeiling',
    cell.amountCeiling,
  );

/**
 * The facts of a cell the loader proved live, in the proposal's own scope. The role binding's own
 * revision is a separate fact: the projection refuses two pinned revisions for one role, so a role
 * whose live assignments pin no single revision leaves it unknown and the verdict unavailable.
 */
export const liveWitnessFacts = (input: {
  readonly cell: AuthorityCell;
  /** The role binding's revision, or absent while intent cannot prove one. */
  readonly grantRoleRevisionId?: RoleRevisionId;
  readonly reachesTarget: boolean | null;
  readonly scopeId: AccessScopeId;
  readonly witness: AuthorityWitness;
}): WitnessFacts => ({
  assignmentRoleRevisionId: input.cell.roleRevisionId,
  assignmentScopeId: input.scopeId,
  assignmentState: 'live',
  grantCell: cellOf(input.cell),
  grantRoleRevisionId: input.grantRoleRevisionId ?? null,
  grantScopeId: input.scopeId,
  grantState: 'live',
  holderId: input.cell.holder,
  reachesTarget: input.reachesTarget,
  witness: input.witness,
});

/** The intent reads one witness verdict needs, taken as a port of the request's own scope (O66). */
export interface LiveWitnessIntentReads {
  readonly loadAuthorityCells: TenantIntentLoaderService['loadAuthorityCells'];
  readonly loadTeamIds: TenantIntentLoaderService['loadTeamIds'];
}

/** Everything the live witness inspector reads: Core's rows, its intent and the owner's projection. */
export interface LiveAuthoritySources {
  readonly intent: LiveWitnessIntentReads;
  readonly moduleKeyOf: LivePublishedCatalog['moduleKeyOf'];
  /** The owner's projection of one record; a composition without one leaves a reach unanswered. */
  readonly recordProjection?: AccessRecordProjectionPort;
  /** The request's own scope: every read below runs inside it and never inside another tenant. */
  readonly scope: OperationalScope;
  /**
   * The rows of this request's scope: a source that opens a transaction per read, or one that uses the
   * transaction an owner Action already holds, so an inspector bound to it answers from the transaction
   * whose mandate it is deciding in (O75).
   */
  readonly transactions: AccessTransactions;
}

/** The membership and scope facts one proposal is proved in, read from one snapshot of intent. */
interface ProvedScopePath {
  readonly facts: LiveMembershipFacts;
  readonly path: LiveMembershipPath;
}

const membershipColumns = {
  agentId: accessMemberships.agentId,
  kind: accessMemberships.kind,
  principalId: accessMemberships.principalId,
  scopeId: accessMemberships.scopeId,
  status: accessMemberships.status,
  validFrom: accessMemberships.validFrom,
  validUntil: accessMemberships.validUntil,
} as const;

/** The driver may hand a timestamp back as text; the path predicate compares instants, not strings. */
interface MembershipRow {
  readonly agentId: string | null;
  readonly kind: string;
  readonly principalId: string | null;
  readonly scopeId: string;
  readonly status: string;
  readonly validFrom: Date | string;
  readonly validUntil: Date | string | null;
}

const membershipRowOf = (row: MembershipRow): LiveMembershipRow => ({
  agentId: row.agentId,
  kind: row.kind,
  principalId: row.principalId,
  scopeId: row.scopeId,
  status: row.status,
  validFrom: asDate(row.validFrom),
  validUntil: row.validUntil === null ? null : asDate(row.validUntil),
});

/** The scopes and membership rows of one tenant, read from ONE snapshot of intent (D13, D6). */
export interface TenantMembershipRows {
  readonly membershipRows: readonly LiveMembershipRow[];
  readonly scopeRows: readonly ScopeRow[];
}

/**
 * The scope and membership rows a membership question rests on. Membership is tenancy intent, not a
 * projection, so it is read from the rows themselves; both reads share one snapshot — REPEATABLE READ
 * when the source opens the transaction, and the caller's own snapshot when it joins one — so a
 * suspension committed between them can never leave the two describing different instants.
 */
export const readTenantMembershipRows = (
  sources: Pick<LiveAuthoritySources, 'transactions' | 'scope'>,
): Effect.Effect<TenantMembershipRows, ApprovalAuthorityUnavailableError> =>
  sources.transactions
    .scopedRead(sources.scope, new Set<string>(), (transaction) =>
      Effect.all(
        [
          transaction
            .select({ legalEntityId: accessScopes.legalEntityId, scopeId: accessScopes.scopeId })
            .from(accessScopes)
            .where(eq(accessScopes.tenantId, sources.scope.tenantId)),
          transaction
            .select(membershipColumns)
            .from(accessMemberships)
            .where(eq(accessMemberships.tenantId, sources.scope.tenantId)),
        ],
        { concurrency: 1 },
      ),
    )
    .pipe(
      Effect.mapError(intentUnavailable),
      Effect.map(([scopeRows, membershipRows]) => ({
        membershipRows: membershipRows.map(membershipRowOf),
        scopeRows,
      })),
    );

/**
 * The membership path of one holder in the proposal's scope. A read that fails is unavailability, and
 * a scope this tenant does not own is no path at all.
 */
const provedScopePath = Effect.fn('LiveApprovalAuthority.provedScopePath')(function* provedScopePathEffect(
  sources: LiveAuthoritySources,
  input: ProposalScope & { readonly at: Date; readonly expectedHolder: Holder },
): Effect.fn.Return<Option.Option<ProvedScopePath>, ApprovalAuthorityUnavailableError> {
  const { membershipRows, scopeRows } = yield* readTenantMembershipRows(sources);
  const path = membershipPathOf(scopeRows, input.scopeId);
  return Option.isNone(path)
    ? Option.none<ProvedScopePath>()
    : Option.some({
        facts: membershipFactsOf({ at: input.at, holder: input.expectedHolder, rows: membershipRows }),
        path: path.value,
      });
});

/** One live assignment of one scope, reduced to the two facts a role binding is pinned from. */
export interface PinnedAssignmentRow {
  readonly roleId: string;
  readonly roleRevisionId: string;
}

/**
 * The one revision each role binding pins in the scope these rows were read for. A role binding is
 * per role and per scope and is built from the single revision its live assignments pin, so this is
 * the binding's own revision, not the witness's: a role whose live assignments pin two revisions is
 * intent the projection refuses (`resolvePinnedRevisions` in `access/compiler/plan.ts`), and then no
 * binding is proven at all. Only the rows handed in are considered, so the caller decides the scope
 * and the instant and this rule never widens them.
 */
export const pinnedRevisionByRole = (rows: readonly PinnedAssignmentRow[]): ReadonlyMap<RoleId, RoleRevisionId> => {
  const pinned = new Map<string, Set<string>>();
  for (const row of rows) {
    const revisions = pinned.get(row.roleId) ?? new Set<string>();
    revisions.add(row.roleRevisionId);
    pinned.set(row.roleId, revisions);
  }
  const resolved = new Map<RoleId, RoleRevisionId>();
  for (const [roleId, revisions] of pinned) {
    const [only] = [...revisions];
    if (revisions.size === 1 && only !== undefined) {
      resolved.set(RoleIdSchema.make(roleId), RoleRevisionIdSchema.make(only));
    }
  }
  return resolved;
};

/**
 * The revision each role binding pins in the proposal's own scope, read from the assignments that are
 * live at the instant of this decision. Three narrowings are the point of the read and none of them
 * may be dropped:
 *
 * - the tenant, because row-level security and the predicate both name it (O66);
 * - the proposal's scope, because `role_binding` is (tenant, scope, role): an assignment in another
 *   company of the same tenant pins that company's binding, and inferring grant authority from it
 *   would let a role in one company justify a mandate in another;
 * - the assignment's own window, because `active` alone still admits a row that has not begun or has
 *   ended (a delegation-bounded assignment), and an expired assignment is not a live role binding.
 *
 * The instant compared here is the one the whole verdict uses, exactly like the intent loader's cell
 * read compares its own (D6), so the binding and the cell are stated for the same moment.
 */
const pinnedRevisionsOf = Effect.fn('LiveApprovalAuthority.pinnedRevisions')(function* pinnedRevisionsEffect(
  sources: LiveAuthoritySources,
  input: { readonly at: Date; readonly roleIds: readonly RoleId[]; readonly scopeId: AccessScopeId },
): Effect.fn.Return<ReadonlyMap<RoleId, RoleRevisionId>, ApprovalAuthorityUnavailableError> {
  if (input.roleIds.length === 0) {
    return new Map<RoleId, RoleRevisionId>();
  }
  const rows = yield* sources.transactions
    .scopedRead(sources.scope, new Set<string>(), (transaction) =>
      transaction
        .select({ roleId: accessAssignments.roleId, roleRevisionId: accessAssignments.roleRevisionId })
        .from(accessAssignments)
        .where(
          and(
            eq(accessAssignments.tenantId, sources.scope.tenantId),
            eq(accessAssignments.scopeId, input.scopeId),
            eq(accessAssignments.status, 'active'),
            inArray(accessAssignments.roleId, [...input.roleIds]),
            lte(accessAssignments.validFrom, input.at),
            or(isNull(accessAssignments.validUntil), gt(accessAssignments.validUntil, input.at)),
          ),
        ),
    )
    .pipe(Effect.mapError(intentUnavailable));
  return pinnedRevisionByRole(rows);
});

/**
 * Whether one record-scoped cell reaches the record a command changes. The owner's projection of that
 * record is the only source that knows its holder and its teams (H3, D32): a composition without one,
 * or a capability the release names no module for, leaves the reach unanswered.
 */
const reachOf = Effect.fn('LiveApprovalAuthority.reach')(function* reachOfEffect(
  sources: LiveAuthoritySources,
  input: {
    readonly cell: AuthorityCell;
    readonly scopeId: AccessScopeId;
    readonly target: RecordKey;
  },
): Effect.fn.Return<boolean | null, ApprovalAuthorityUnavailableError> {
  const local = localReachOf(input.cell.selector, input.target);
  if (Option.isSome(local)) {
    return local.value;
  }
  // A composition that bound no owner projection has no answer for this record; the shipped
  // `UNPROJECTED_RECORD` would answer "projects nothing", which is a denial this adapter has no fact
  // for. Unanswered is the honest answer, and the verdict keeps it retryable.
  if (sources.recordProjection === undefined) {
    return null;
  }
  const moduleKey = yield* sources
    .moduleKeyOf(input.cell.capabilityKey)
    .pipe(Effect.mapError((failure) => authorityUnavailable(failure.reason)));
  if (Option.isNone(moduleKey)) {
    return null;
  }
  const projected = yield* readRecordProjection(sources.recordProjection, {
    moduleKey: moduleKey.value,
    recordKey: input.target,
    scope: sources.scope,
  }).pipe(Effect.mapError(projectionUnavailable));
  if (Option.isNone(projected)) {
    return false;
  }
  const row = projected.value;
  const { holder } = input.cell;
  return yield* Match.value(input.cell.selector).pipe(
    Match.tags({
      assigned: () => Effect.succeed(row.assigned !== undefined && holderEquals(holder, row.assigned)),
      entrusted: () => Effect.succeed(row.entrusted !== undefined && holderEquals(holder, row.entrusted)),
      team: () =>
        sources.intent
          .loadTeamIds(sources.scope, {
            holder,
            scopeId: input.scopeId,
            tenantId: tenantIdOf(sources.scope),
          })
          .pipe(
            Effect.mapError(intentUnavailable),
            Effect.map((teamIds) => {
              const membership = new Set(teamIds);
              return row.teamIds.some((teamId) => membership.has(teamId));
            }),
          ),
    }),
    Match.orElse(() => Effect.succeed(false)),
  );
});

/** One (capability, mode) pair of a witness group: the cells every witness of that pair is proven against. */
interface WitnessCellQuery {
  readonly capabilityKey: CapabilityKey;
  readonly key: string;
  readonly mode: AccessMode;
}

const cellQueryOf = (witness: AuthorityWitness): WitnessCellQuery => {
  const mode = witnessPurposeMode(witness.purpose);
  return { capabilityKey: witness.capabilityKey, key: `${witness.capabilityKey} ${mode}`, mode };
};

/** The live cell a witness names exactly: same assignment incarnation, same grant incarnation. */
const cellOfWitness = (cells: readonly AuthorityCell[], witness: AuthorityWitness): AuthorityCell | undefined =>
  cells.find(
    (cell) =>
      cell.assignmentIncarnationId === witness.assignmentIncarnationId &&
      cell.grantIncarnationId === witness.grantIncarnationId,
  );

/**
 * The live inspector of one request scope. Every answer is re-read from intent on the call, so a
 * revocation, a retirement, a suspension and an expiry are seen at the next question instead of at the
 * next restart; and a group whose holder is not a live member of the whole membership path loses every
 * witness it names before a cell is read at all.
 */
export const liveApprovalAuthorityInspector = (sources: LiveAuthoritySources): ApprovalAuthorityInspector => {
  const inspect = Effect.fn('LiveApprovalAuthority.inspect')(function* inspectEffect(
    input: Parameters<ApprovalAuthorityInspector['inspect']>[0],
  ) {
    if (input.tenantId !== sources.scope.tenantId) {
      return yield* authorityUnavailable('A witness is only inspected inside the request own tenant');
    }
    if (input.witnesses.length === 0) {
      return [];
    }
    const at = yield* DateTime.nowAsDate;
    const proved = yield* provedScopePath(sources, {
      ...input,
      at,
      expectedHolder: input.expectedHolder,
    });
    if (Option.isNone(proved)) {
      return yield* authorityUnavailable('The scope of this proposal is not an access scope of this tenant');
    }
    const { facts, path } = proved.value;
    if (!holdsMembershipPath(facts, path)) {
      return input.witnesses.map(lostWitnessFacts);
    }
    const queries = [
      ...new Map(input.witnesses.map((witness) => [cellQueryOf(witness).key, cellQueryOf(witness)] as const)).values(),
    ];
    const reads = yield* Effect.forEach(
      queries,
      (query) =>
        sources.intent
          .loadAuthorityCells(sources.scope, {
            capabilityKey: query.capabilityKey,
            holder: input.expectedHolder,
            mode: query.mode,
            scopeId: input.scopeId,
            tenantId: input.tenantId,
          })
          .pipe(Effect.mapError(intentUnavailable)),
      { concurrency: 1 },
    );
    const cellsByQuery = new Map(queries.map((query, index) => [query.key, reads[index] ?? []] as const));
    const matched = input.witnesses.map((witness) => ({
      cell: cellOfWitness(cellsByQuery.get(cellQueryOf(witness).key) ?? [], witness),
      witness,
    }));
    const expired = new Set(
      matched.flatMap(({ cell, witness }) =>
        cell !== undefined && cell.deadline !== undefined && cell.deadline <= at ? [witness] : [],
      ),
    );
    const roleIds = [...new Set(matched.flatMap(({ cell }) => (cell === undefined ? [] : [cell.roleId])))];
    const pinned = yield* pinnedRevisionsOf(sources, { at, roleIds, scopeId: input.scopeId });
    return yield* Effect.forEach(
      matched,
      ({ cell, witness }) => {
        if (cell === undefined || expired.has(witness)) {
          return Effect.succeed(lostWitnessFacts(witness));
        }
        const reach =
          input.target === undefined
            ? Effect.succeed<boolean | null>(null)
            : reachOf(sources, { cell, scopeId: input.scopeId, target: input.target });
        return reach.pipe(
          Effect.map((reachesTarget) =>
            liveWitnessFacts(
              withOptional(
                { cell, reachesTarget, scopeId: input.scopeId, witness },
                'grantRoleRevisionId',
                pinned.get(cell.roleId),
              ),
            ),
          ),
        );
      },
      { concurrency: 1 },
    );
  });

  return Object.freeze({ inspect });
};
