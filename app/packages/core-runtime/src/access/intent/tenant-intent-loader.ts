import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { Clock, Context, DateTime, Effect, Layer, Match, Option, Result, Schema } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import {
  accessAgentConnections,
  accessAssignments,
  accessCatalogEntries,
  accessCatalogSnapshots,
  accessConsentSnapshots,
  accessDelegations,
  accessGrantIncarnations,
  accessMemberships,
  accessRoleRevisions,
  accessScopes,
  accessTeamMembers,
  accessTeams,
  principals,
  tenantModuleStates,
} from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { INSTALLED_TENANT_MODULE_STATES } from '../../modules/module-state-gate.ts';
import { configureBasesOf } from '../changes/authority.ts';
import type { AccessConfigureBasis } from '../changes/authority.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { AccessPrincipalKindSchema } from '../compiler/intent.ts';
import type {
  LegalEntityProjectionIntent,
  ProjectionMemberIntent,
  ProjectionPrincipalIntent,
  ScopeProjectionIntent,
  TenantProjectionIntent,
} from '../compiler/intent.ts';
import { capabilitySlot } from '../compiler/object-id.ts';
import { AccessTeamIdSchema } from '../decision/authority.ts';
import type {
  AccessTeamId,
  AuthorityCell,
  AuthorityCellQuery,
  AuthorityDeadline,
  CompanyOwnershipQuery,
  ConnectionQuery,
  HolderMembershipDeadlines,
  ResolvedAccessScope,
  ResolvedAgentConnection,
  ScopeQuery,
  TeamMembershipQuery,
} from '../decision/authority.ts';
import { earliestDeadline } from '../decision/contract.ts';
import { holderIdOf } from '../decision/selector.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  DelegationIdSchema,
  GrantIncarnationIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../ids.ts';
import type { AccessScopeId, ModuleKey, PrincipalId, TenantId } from '../ids.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  AccessScopeRecordSchema,
  AgentConnectionSchema,
  AmountCeilingSchema,
  AssignmentSchema,
  CatalogSnapshotEntrySchema,
  ConsentCeilingSchema,
  DelegationSchema,
  HolderSchema,
  RoleRevisionSchema,
  holderKey,
} from '../model.ts';
import type { AmountCeiling, Cell, DelegatedLimits, Delegation, Holder } from '../model.ts';
import type { AccessLifecycleError } from '../lifecycle/errors.ts';
import type { AccessIntentError } from './errors.ts';
import { intentConflict } from './errors.ts';
import { delegatedCellCeiling } from './delegated-cell.ts';
import type { AccessMembership, MembershipKind } from './memberships.ts';
import { decodeMembershipRow, membershipColumns } from './memberships.ts';
import type { AccessIntentDatabase, AccessIntentStoreFailure, AccessTransactions } from './persistence.ts';
import {
  asDate,
  callerTransactions,
  decodeStored,
  optionalProperty,
  principalIdOf,
  requestTransactions,
  scopeIssue,
} from './persistence.ts';

/*
 * The one reader of Core's access intent. PostgreSQL is the source of truth and SpiceDB only its
 * projection, so both consumers read here: the projection writer needs one complete, consistent tenant
 * intent (D13), and the decision engine needs the exact scope, cells, connection and teams of one
 * actor (guarantee 5, D6).
 *
 * Every call names the trusted request scope it runs in and installs it on one transaction (O66), so
 * the tenant, the acting person and the tenant row security of `ontos_runtime` all come from the
 * request. A query naming another tenant than the installed scope is a conflict the caller repairs by
 * re-reading, never a quiet empty answer.
 *
 * The loader is a port, not a policy: it states what intent says. Whether a cell may be used, whether
 * a deadline has passed and whether a scope admits the actor are the decision engine's questions;
 * whether the intent is complete and grantable is the compiler's.
 */

/** The five reads the two consumers ask for; `loadProjection` is complete for one whole tenant. */
export interface TenantIntentLoaderService {
  /**
   * The same reader over a transaction the caller already owns (O75). A reader built over the pool
   * answers with one built over `callerTransactions(transaction)`, so a decision taken inside an
   * owner Action's transaction reads that transaction instead of opening a second connection; a
   * reader already joined to a transaction is re-joined to the transaction named here.
   */
  readonly joined?: (transaction: CoreTransaction) => TenantIntentLoaderService;
  /** Claim down to what intent records, for one exact capability, holder and mode (guarantee 9). */
  readonly loadAuthorityCells: (
    scope: OperationalScope,
    query: AuthorityCellQuery,
  ) => Effect.Effect<readonly AuthorityCell[], AccessIntentError>;
  /**
   * `loadAuthorityCells` for many queries in ONE transaction, answered in the asked order: each answer is exactly
   * what that query alone would read at the same instant.
   */
  readonly loadAuthorityCellsMany: (
    scope: OperationalScope,
    queries: readonly AuthorityCellQuery[],
  ) => Effect.Effect<readonly (readonly AuthorityCell[])[], AccessIntentError>;
  /**
   * Whether the named company is one of the tenant's own scopes. It reads that one scope row and nothing about
   * anyone's membership: it is the company-of-tenant check every gate path asks before a decision (O66, O88).
   */
  readonly loadCompanyOwnership: (
    scope: OperationalScope,
    query: CompanyOwnershipQuery,
  ) => Effect.Effect<boolean, AccessIntentError>;
  /** Same owner, scope-admin and delegated bases used by change commands (O81). */
  readonly loadConfigureBases: (
    scope: OperationalScope,
    query: { readonly actor: PrincipalId; readonly at: Date; readonly tenantId: TenantId },
  ) => Effect.Effect<readonly AccessConfigureBasis[], AccessIntentError>;
  /** The agent's fresh connection, its consented ceiling and its consent revision (guarantee 6). */
  readonly loadConnection: (
    scope: OperationalScope,
    query: ConnectionQuery,
  ) => Effect.Effect<Option.Option<ResolvedAgentConnection>, AccessIntentError>;
  /** One consistent, complete picture of every scope, member, assignment and installation. */
  readonly loadProjection: (scope: OperationalScope) => Effect.Effect<TenantProjectionIntent, AccessIntentError>;
  /** The scope an actor asks in, with the membership deadlines of every holder taking part (D6). */
  readonly loadScope: (
    scope: OperationalScope,
    query: ScopeQuery,
  ) => Effect.Effect<Option.Option<ResolvedAccessScope>, AccessIntentError>;
  /** The teams a holder takes part in inside one scope; the list predicate's `TeamMemberOf` (B1). */
  readonly loadTeamIds: (
    scope: OperationalScope,
    query: TeamMembershipQuery,
  ) => Effect.Effect<readonly AccessTeamId[], AccessIntentError>;
  /**
   * The tenant's own context scope id: the one fence that serializes the whole tenant's projection. It is
   * read on its own because a projection writer must take that fence before it reads a single intent row
   * (R5a-1), and a fence is named by a scope id it cannot infer from an intent it has not read yet.
   */
  readonly loadTenantContextScopeId: (
    scope: OperationalScope,
  ) => Effect.Effect<Option.Option<AccessScopeId>, AccessIntentError>;
}

const decodeScope = Schema.decodeUnknownResult(AccessScopeRecordSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeAssignment = Schema.decodeUnknownResult(AssignmentSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeDelegation = Schema.decodeUnknownResult(DelegationSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeConnection = Schema.decodeUnknownResult(AgentConnectionSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeRevision = Schema.decodeUnknownResult(RoleRevisionSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeCatalogEntry = Schema.decodeUnknownResult(CatalogSnapshotEntrySchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeModuleKey = Schema.decodeUnknownResult(ModuleKeySchema);
const decodeHolder = Schema.decodeUnknownResult(HolderSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeCeiling = Schema.decodeUnknownResult(ConsentCeilingSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeTeamId = Schema.decodeUnknownResult(AccessTeamIdSchema);
const decodePrincipalKind = Schema.decodeUnknownResult(AccessPrincipalKindSchema);

/**
 * The request's identifiers as the access model brands them. `OperationalScope` carries them as plain
 * strings (its schema is Core's identity contract), so the reader decodes them once, at the boundary,
 * exactly like every row it reads.
 */
const decodeScopeIds = Schema.decodeUnknownResult(
  Schema.Struct({ principalId: PrincipalIdSchema, tenantId: TenantIdSchema }),
);

/** The identifiers of one exact grant cell, decoded from the rows that name it. */
const decodeCellIdentity = Schema.decodeUnknownResult(
  Schema.Struct({
    assignedBy: PrincipalIdSchema,
    assignmentIncarnationId: AssignmentIncarnationIdSchema,
    grantIncarnationId: GrantIncarnationIdSchema,
    roleId: RoleIdSchema,
    roleRevisionId: RoleRevisionIdSchema,
  }),
);

/** The identifiers of one agent connection, decoded from its row. */
const decodeConnectionIdentity = Schema.decodeUnknownResult(
  Schema.Struct({
    agentId: AgentIdSchema,
    connectionId: AgentConnectionIdSchema,
    principalId: PrincipalIdSchema,
    scopeId: AccessScopeIdSchema,
  }),
);

/** The frozen delegated limits as PostgreSQL stores them: JSON, so the one instant arrives as text. */
const decodeDelegatedEnvelope = Schema.decodeUnknownResult(
  Schema.Struct({
    amountCeiling: Schema.optionalKey(AmountCeilingSchema),
    capabilityKeys: Schema.NonEmptyArray(CapabilityKeySchema),
    delegationId: DelegationIdSchema,
    until: Schema.DateFromString,
  }),
  ACCESS_MODEL_PARSE_OPTIONS,
);

/** The transaction's instant: the clock the caller runs under, so a test can pin it. */
const now = Effect.fn('TenantIntentLoader.now')(function* nowEffect() {
  const millis = yield* Clock.currentTimeMillis;
  return DateTime.toDateUtc(DateTime.makeUnsafe(millis));
});

/** A holder is a person or an agent, and SQL keeps exactly one column filled. */
const holderOf = (
  row: { readonly agentId: string | null; readonly principalId: string | null },
  subject: string,
): Effect.Effect<Holder, AccessIntentError> =>
  decodeStored(
    decodeHolder(
      row.principalId === null
        ? { _tag: 'Agent', agentId: row.agentId }
        : { _tag: 'Principal', principalId: row.principalId },
    ),
    subject,
  );

/** One half of the holder XOR as a predicate, so a person and an agent never match one query. */
const holderMatch = (principal: AnyPgColumn, agent: AnyPgColumn, holder: Holder) =>
  Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }) => sql`${principal} = ${principalId} and ${agent} is null`),
    Match.tag('Agent', ({ agentId }) => sql`${principal} is null and ${agent} = ${agentId}`),
    Match.exhaustive,
  );

const scopeColumns = {
  legalEntityId: accessScopes.legalEntityId,
  scopeId: accessScopes.scopeId,
  tenantContextId: accessScopes.tenantContextId,
  tenantId: accessScopes.tenantId,
} as const;

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

/**
 * The revision columns with only the cells of the asked capabilities and modes, in their stored order: a cell read
 * transfers what it asks about, not a whole preset of every capability the role holds.
 */
const askedRevisionColumns = (capabilityKeys: readonly string[], modes: readonly string[]) => ({
  ...revisionColumns,
  cellsJson: sql<readonly Cell[]>`coalesce(
      (select jsonb_agg(asked.cell order by asked.position)
         from jsonb_array_elements(${accessRoleRevisions.cellsJson}) with ordinality as asked(cell, position)
        where asked.cell->>'capabilityKey' in ${capabilityKeys} and asked.cell->>'mode' in ${modes}),
      '[]'::jsonb)`.mapWith(accessRoleRevisions.cellsJson),
});

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

const connectionColumns = {
  agentId: accessAgentConnections.agentId,
  connectionId: accessAgentConnections.connectionId,
  principalId: accessAgentConnections.principalId,
  revision: accessAgentConnections.revision,
  scopeId: accessAgentConnections.scopeId,
  status: accessAgentConnections.status,
  tenantId: accessAgentConnections.tenantId,
  validFrom: accessAgentConnections.validFrom,
  validUntil: accessAgentConnections.validUntil,
} as const;

interface ScopeRow {
  readonly legalEntityId: string | null;
  readonly scopeId: string;
  readonly tenantContextId: string | null;
  readonly tenantId: string;
}

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

interface RevisionRow {
  readonly catalogSnapshotId: string;
  readonly cellsJson: readonly Cell[];
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly provenance: string;
  readonly revision: number;
  readonly roleId: string;
  readonly roleRevisionId: string;
  readonly templateKey: string | null;
  readonly tenantId: string;
}

interface DelegationRow {
  readonly amountCeilingJson: Delegation['amountCeiling'] | null;
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

interface ConnectionRow {
  readonly agentId: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly revision: number;
  readonly scopeId: string;
  readonly status: string;
  readonly tenantId: string;
  readonly validFrom: Date | string;
  readonly validUntil: Date | string;
}

interface EntryRow {
  readonly capabilityKey: string;
  readonly catalogSnapshotId: string;
  readonly entryJson: unknown;
}

const scopeRecordOf = (row: ScopeRow) =>
  row.legalEntityId === null
    ? decodeScope({ id: row.scopeId, scope: { _tag: 'TenantContext', tenantId: row.tenantId } })
    : decodeScope({
        id: row.scopeId,
        scope: { _tag: 'LegalEntity', legalEntityId: row.legalEntityId, tenantId: row.tenantId },
      });

/** The frozen envelope of one assignment, named by the assignment it bounds (D10, D10b). */
const envelopePairOf =
  (row: AssignmentRow) =>
  (limits: Option.Option<DelegatedLimits>): readonly (readonly [string, DelegatedLimits])[] =>
    Option.match(limits, {
      onNone: () => [],
      onSome: (frozen) => [[row.incarnationId, frozen] as const],
    });

/** The frozen limits a delegation left on its assignment; they outlive the delegation itself (D6). */
const delegatedLimitsOf = (row: AssignmentRow): Effect.Effect<Option.Option<DelegatedLimits>, AccessIntentError> =>
  row.delegatedBy === null
    ? Effect.succeed(Option.none())
    : Effect.map(
        decodeStored(
          decodeDelegatedEnvelope(row.delegationEnvelopeJson),
          `delegated limits of assignment ${row.incarnationId}`,
        ),
        Option.some,
      );

const assignmentOf = (row: AssignmentRow) =>
  Effect.all([holderOf(row, `assignment ${row.incarnationId}`), delegatedLimitsOf(row)], { concurrency: 1 }).pipe(
    Effect.flatMap(([holder, delegated]) =>
      decodeStored(
        decodeAssignment({
          assignedAt: asDate(row.validFrom),
          assignedBy: row.assignedBy,
          holder,
          incarnationId: row.incarnationId,
          roleId: row.roleId,
          roleRevisionId: row.roleRevisionId,
          scopeId: row.scopeId,
          status: row.status,
          tenantId: row.tenantId,
          validFrom: asDate(row.validFrom),
          ...optionalProperty({}, 'delegated', Option.getOrUndefined(delegated)),
          ...optionalProperty({}, 'validUntil', row.validUntil === null ? null : asDate(row.validUntil)),
        }),
        `assignment ${row.incarnationId}`,
      ),
    ),
  );

const revisionOf = (row: RevisionRow) =>
  decodeStored(
    decodeRevision({
      catalogSnapshotId: row.catalogSnapshotId,
      cells: row.cellsJson,
      createdAt: asDate(row.createdAt),
      createdBy: row.createdBy,
      id: row.roleRevisionId,
      provenance: row.provenance,
      revision: row.revision,
      roleId: row.roleId,
      tenantId: row.tenantId,
      ...optionalProperty({}, 'templateKey', row.templateKey),
    }),
    `role revision ${row.roleRevisionId}`,
  );

const delegationOf = (row: DelegationRow) =>
  decodeStored(
    decodeDelegation({
      ...optionalProperty({}, 'amountCeiling', row.amountCeilingJson),
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
    }),
    `delegation ${row.delegationId}`,
  );

const connectionOf = (row: ConnectionRow) =>
  decodeStored(
    decodeConnection({
      agentId: row.agentId,
      id: row.connectionId,
      principalId: row.principalId,
      revision: row.revision,
      scopeId: row.scopeId,
      status: row.status,
      tenantId: row.tenantId,
      validFrom: asDate(row.validFrom),
      validUntil: asDate(row.validUntil),
    }),
    `agent connection ${row.connectionId}`,
  );

/**
 * The live `member` rows of a set of memberships, with the end date each one carries. Owner and
 * access-admin rows are management authority, which the graph projects as its own relations and which
 * still requires membership before it administers anything (O28).
 *
 * The membership's own window bounds it here, exactly as the decision engine's time rule bounds every
 * other intent (D6): a membership that has not started or has already ended is not part of intent at
 * this instant, so it is never projected as a live tuple.
 */
const liveAt = (membership: AccessMembership, at: Date): boolean =>
  membership.validFrom <= at && (membership.validUntil === undefined || membership.validUntil > at);

/**
 * The end dates one holder's live `member` rows carry in one scope: the deadline source of D6. Only
 * operational membership bounds a business decision. An owner or access-admin row is management
 * authority with its own deadline, read by the configure-authority path, so its end never denies the
 * capabilities the person still holds as a member.
 */
const membershipDeadlines = (
  memberships: readonly AccessMembership[],
  scopeId: string,
  holder: Holder,
  at: Date,
): readonly AuthorityDeadline[] =>
  memberships.flatMap((membership): readonly AuthorityDeadline[] =>
    membership.scopeId === scopeId &&
    membership.kind === 'member' &&
    membership.status === 'active' &&
    liveAt(membership, at) &&
    membership.validUntil !== undefined &&
    holderKey(membership.holder) === holderKey(holder)
      ? [{ source: 'membership', until: membership.validUntil }]
      : [],
  );

const uniqueDeadlines = (deadlines: readonly AuthorityDeadline[]): readonly AuthorityDeadline[] => {
  const seen = new Set<string>();
  return deadlines.filter((deadline) => {
    const key = `${deadline.source}:${deadline.until.toISOString()}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
};

const activeMembers = (memberships: readonly AccessMembership[], at: Date): readonly ProjectionMemberIntent[] =>
  memberships.flatMap((membership): readonly ProjectionMemberIntent[] => {
    const { holder, kind, status, validUntil } = membership;
    return kind === 'member' && status === 'active' && liveAt(membership, at)
      ? [validUntil === undefined ? { holder } : { expiresAt: validUntil, holder }]
      : [];
  });

const suspendedHolders = (memberships: readonly AccessMembership[], at: Date): readonly Holder[] =>
  memberships.flatMap((membership): readonly Holder[] =>
    membership.status === 'suspended' && liveAt(membership, at) ? [membership.holder] : [],
  );

/** The people a set of memberships gives one management kind to; an agent never holds it (O46). */
const principalHolders = (
  memberships: readonly AccessMembership[],
  kind: MembershipKind,
  at: Date,
): readonly PrincipalId[] =>
  memberships.flatMap((membership) =>
    membership.kind === kind && membership.status === 'active' && liveAt(membership, at)
      ? Option.toArray(principalIdOf(membership.holder))
      : [],
  );

/**
 * Whether one holder has a live membership in every scope on this scope's path, without a live
 * suspension anywhere on it. A tenant membership cannot stand in for a company's, nor override a
 * company suspension (or vice versa), except that a tenant owner needs no company membership: the graph
 * subtracts suspension, and structural decisions must enforce the same refusal before bypassing graph
 * checks. Revoked, future and ended rows provide neither membership nor a live suspension.
 */
const isLiveMember = (
  memberships: readonly AccessMembership[],
  path: { readonly scopeId: string; readonly tenantScopeId: string | undefined },
  holder: Holder,
  at: Date,
): boolean => {
  const holderOfInterest = holderKey(holder);
  const rowsIn = (scopeId: string) =>
    memberships.filter(
      (membership) =>
        membership.scopeId === scopeId && liveAt(membership, at) && holderKey(membership.holder) === holderOfInterest,
    );
  const clearIn = (scopeId: string) => !rowsIn(scopeId).some((membership) => membership.status === 'suspended');
  const memberIn = (scopeId: string) =>
    rowsIn(scopeId).some((membership) => membership.kind === 'member' && membership.status === 'active');
  const { scopeId, tenantScopeId } = path;
  if (tenantScopeId === undefined || scopeId === tenantScopeId) {
    return clearIn(scopeId) && memberIn(scopeId);
  }
  // A tenant owner administers every company without joining it (`tenant->administer`), so the
  // company's own membership is waived for them; its suspension is not, and neither is the tenant's.
  const owner = rowsIn(tenantScopeId).some(
    (membership) => membership.kind === 'owner' && membership.status === 'active',
  );
  return clearIn(tenantScopeId) && memberIn(tenantScopeId) && clearIn(scopeId) && (memberIn(scopeId) || owner);
};

const readScopeRows = (transaction: CoreTransaction, tenantId: string) =>
  transaction.select(scopeColumns).from(accessScopes).where(eq(accessScopes.tenantId, tenantId));

/** The request names the tenant every query below must land in; anything else is a conflict (D13). */
const assertScope = (scope: OperationalScope, tenantId: string): Effect.Effect<void, AccessIntentError> => {
  const issue = scopeIssue(scope, [tenantId]);
  return issue === null ? Effect.void : Effect.fail(intentConflict('access_intent_scope_mismatch', issue));
};

const tenantScopeIdOf = (rows: readonly ScopeRow[]): string | undefined =>
  rows.find(({ legalEntityId }) => legalEntityId === null)?.scopeId;

/** One grant cell a decision could witness, before its identifiers are decoded. */
interface AuthorityCellCandidate {
  readonly amountCeiling?: AuthorityCell['amountCeiling'];
  readonly assignedAt: Date;
  readonly assignedBy: string;
  readonly assignmentIncarnationId: string;
  readonly capabilityKey: Cell['capabilityKey'];
  readonly deadline?: Date;
  readonly grantIncarnationId: string;
  readonly holder: Holder;
  readonly mode: Cell['mode'];
  readonly roleId: string;
  readonly roleRevisionId: string;
  readonly selector: Cell['selector'];
}

/** The delegation an assignment names and the envelope it froze from it (D21). */
interface DelegationBasis {
  readonly delegation: Delegation;
  readonly frozen: DelegatedLimits;
}

interface CandidateInput {
  /**
   * Whether the asked capability's catalog entry declares an `amountInput`, or nothing when the
   * catalog the held revisions pin does not declare it. Read only when an assignment is delegated.
   */
  readonly amountGoverned: Option.Option<boolean>;
  readonly capabilityKey: AuthorityCellQuery['capabilityKey'];
  readonly delegationById: ReadonlyMap<string, Delegation>;
  readonly envelopeByAssignment: ReadonlyMap<string, DelegatedLimits>;
  readonly grantOfCell: ReadonlyMap<string, string>;
  readonly holder: Holder;
  readonly mode: Cell['mode'];
  readonly revisionById: ReadonlyMap<string, RevisionRow>;
  readonly rows: readonly AssignmentRow[];
}

/** The delegation and envelope of an assignment, or nothing when the assignment stands on its own. */
const delegationBasisOf = (input: CandidateInput, row: AssignmentRow): Option.Option<DelegationBasis> => {
  if (row.delegatedBy === null) {
    return Option.none();
  }
  const delegation = input.delegationById.get(row.delegatedBy);
  const frozen = input.envelopeByAssignment.get(row.incarnationId);
  return delegation === undefined || frozen === undefined ? Option.none() : Option.some({ delegation, frozen });
};

/** The instants a delegated assignment is bounded by: the envelope it froze and the live delegation. */
const basisDeadlines = (basis: Option.Option<DelegationBasis>): readonly Date[] =>
  Option.match(basis, {
    onNone: () => [],
    onSome: ({ delegation, frozen }) => [frozen.until, delegation.validUntil],
  });

/**
 * The ceiling a cell may spend: its own, narrowed by the envelope when its assignment is delegated and
 * its capability moves money (D10b).
 */
const cellCeilingOf = (
  input: CandidateInput,
  amountGoverned: boolean,
  row: AssignmentRow,
  cell: Cell,
  basis: Option.Option<DelegationBasis>,
): Result.Result<Option.Option<AmountCeiling>, AccessLifecycleError> =>
  Option.match(basis, {
    onNone: (): Result.Result<Option.Option<AmountCeiling>, AccessLifecycleError> =>
      Result.succeed(cell.amountCeiling === undefined ? Option.none() : Option.some(cell.amountCeiling)),
    onSome: ({ delegation, frozen }) =>
      delegatedCellCeiling({ amountGoverned, cell, delegation, frozen, holder: input.holder, roleId: row.roleId }),
  });

/**
 * Every cell of the asked capability and mode that is held right now, folded without an imperative
 * loop: the revision gives the cells, the incarnation that holds the cell's slot gives the witness, the
 * delegation that bounded the assignment gives its end, and a delegated cell's ceiling is the narrower
 * of its own and the envelope's (D10b).
 */
const cellCandidates = (input: CandidateInput): readonly AuthorityCellCandidate[] =>
  input.rows.flatMap((row): readonly AuthorityCellCandidate[] => {
    const revision = input.revisionById.get(row.roleRevisionId);
    const basis = delegationBasisOf(input, row);
    // A delegated assignment lives only while its delegation does, and only inside the envelope it
    // froze: a revoked, past or envelope-less delegation leaves no cell behind, rather than a wider one.
    // Its money limit applies only to a capability the catalog declares, so a capability the pinned
    // catalog does not know leaves no delegated cell either (fail closed).
    if (
      revision === undefined ||
      (row.delegatedBy !== null && (Option.isNone(basis) || Option.isNone(input.amountGoverned)))
    ) {
      return [];
    }
    const amountGoverned = Option.getOrElse(input.amountGoverned, () => false);
    return revision.cellsJson.flatMap((cell): readonly AuthorityCellCandidate[] => {
      const grantIncarnationId = input.grantOfCell.get(`${row.roleId}|${capabilitySlot(cell)}`);
      if (cell.capabilityKey !== input.capabilityKey || cell.mode !== input.mode || grantIncarnationId === undefined) {
        return [];
      }
      const ceiling = cellCeilingOf(input, amountGoverned, row, cell, basis);
      if (Result.isFailure(ceiling)) {
        // The cell disagrees with the envelope that was granted for it, so the decision must not see it.
        return [];
      }
      const deadline = earliestDeadline([
        row.validUntil === null ? undefined : asDate(row.validUntil),
        ...basisDeadlines(basis),
      ]);
      return [
        {
          ...optionalProperty({}, 'amountCeiling', Option.getOrUndefined(ceiling.success)),
          ...optionalProperty({}, 'deadline', deadline),
          assignedAt: asDate(row.validFrom),
          assignedBy: row.assignedBy,
          assignmentIncarnationId: row.incarnationId,
          capabilityKey: cell.capabilityKey,
          grantIncarnationId,
          holder: input.holder,
          mode: cell.mode,
          roleId: row.roleId,
          roleRevisionId: row.roleRevisionId,
          selector: cell.selector,
        },
      ];
    });
  });

/**
 * The entries the pinned role revisions were validated against. A key may be published by more than
 * one release at a time (one role edited against a newer snapshot than its neighbour), so a key
 * resolves to the entry of the most recently published release that names it — the current meaning of
 * the capability, never an older one (O1).
 */
const newestEntryByKey = (
  entries: readonly EntryRow[],
  releases: readonly { readonly catalogSnapshotId: string; readonly publishedAt: Date | string }[],
): readonly EntryRow[] => {
  const rankOf = new Map(releases.map((release, index) => [release.catalogSnapshotId, index]));
  const newest = new Map<string, EntryRow>();
  for (const entry of entries.toSorted(
    (left, right) =>
      (rankOf.get(right.catalogSnapshotId) ?? -1) - (rankOf.get(left.catalogSnapshotId) ?? -1) ||
      left.capabilityKey.localeCompare(right.capabilityKey),
  )) {
    if (!newest.has(entry.capabilityKey)) {
      newest.set(entry.capabilityKey, entry);
    }
  }
  return [...newest.values()];
};

const makeIntentLoaderOver = (
  transactions: AccessTransactions,
  enrollment: DatabaseIdentityEnrollment,
): TenantIntentLoaderService => {
  /**
   * Every read of this loader runs in one transaction under the caller's scope (O66, D13), and that
   * transaction is REPEATABLE READ when the source opens it: the loader never answers a request from
   * one statement, so all of its statements must come from one snapshot. A loader built over a
   * caller's transaction reads that transaction's snapshot instead, which is `scopedRead`'s
   * documented joined semantics and not a level this reader can choose.
   */
  const readScoped = Effect.fn('TenantIntentLoader.read')(function* readScopedEffect<Value>(
    scope: OperationalScope,
    body: (transaction: CoreTransaction, at: Date) => Effect.Effect<Value, AccessIntentStoreFailure>,
  ) {
    const at = yield* now();
    return yield* transactions.scopedRead(scope, new Set<string>(), (transaction) => body(transaction, at));
  });

  const scopeIdsOf = Effect.fn('TenantIntentLoader.scopeIds')(function* scopeIdsEffect(scope: OperationalScope) {
    return yield* decodeStored(
      decodeScopeIds({ principalId: scope.principalId, tenantId: scope.tenantId }),
      `request scope of tenant ${scope.tenantId}`,
    );
  });

  const readMemberships = Effect.fn('TenantIntentLoader.readMemberships')(function* readMembershipsEffect(
    transaction: CoreTransaction,
    tenantId: string,
  ) {
    const rows = yield* transaction
      .select(membershipColumns)
      .from(accessMemberships)
      .where(eq(accessMemberships.tenantId, tenantId));
    return yield* Effect.forEach(rows, (row) => decodeMembershipRow(row), { concurrency: 1 });
  });

  /** The scope an actor asks in, with the membership end dates of every holder taking part (D6). */
  const readResolvedScope = Effect.fn('TenantIntentLoader.readScope')(function* readResolvedScopeEffect(
    transaction: CoreTransaction,
    query: ScopeQuery,
    at: Date,
  ) {
    const [scopeRows, memberships] = yield* Effect.all(
      [readScopeRows(transaction, query.tenantId), readMemberships(transaction, query.tenantId)],
      { concurrency: 1 },
    );
    const { checkedCompany } = query;
    if (checkedCompany !== undefined && !scopeRows.some((candidate) => candidate.legalEntityId === checkedCompany)) {
      // The request pairs the tenant with a company it does not own: nothing here is decided (O66, O88).
      return Option.none<ResolvedAccessScope>();
    }
    const row = scopeRows.find((candidate) =>
      query.legalEntityId === undefined
        ? candidate.legalEntityId === null
        : candidate.legalEntityId === query.legalEntityId,
    );
    if (row === undefined) {
      // The scope does not exist, so nothing here is accessible: that is a refusal of the actor
      // (DENIED), never a retryable read failure.
      return Option.none<ResolvedAccessScope>();
    }
    const tenantScopeId = tenantScopeIdOf(scopeRows);
    // Membership is intent, not projection: a holder with no live membership on this scope's path is
    // refused here, so a graph that still carries a revoked member's tuple grants nothing (R5a-1). The
    // path is the tenant context's membership and, for a company, the company's too: both memberships a
    // legal-entity decision rests on (D6, M2), so a member of the tenant is never read as a member of a
    // company it never joined or has left.
    const path = { scopeId: row.scopeId, tenantScopeId };
    const nonMember = query.holders.find((holder) => !isLiveMember(memberships, path, holder, at));
    if (nonMember !== undefined) {
      return Option.none<ResolvedAccessScope>();
    }
    const resolvedScope = yield* decodeStored(scopeRecordOf(row), `scope ${row.scopeId}`);
    // A legal-entity decision rests on two memberships: the company's and the tenant's. Both end dates
    // bound the path, and each holder carries only its own (D6, M2).
    const holderDeadlines: readonly HolderMembershipDeadlines[] = query.holders.map((holder) => ({
      deadlines: uniqueDeadlines([
        ...(tenantScopeId === undefined ? [] : membershipDeadlines(memberships, tenantScopeId, holder, at)),
        ...(row.scopeId === tenantScopeId ? [] : membershipDeadlines(memberships, row.scopeId, holder, at)),
      ]),
      holder,
    }));
    return Option.some({
      deadlines: uniqueDeadlines(holderDeadlines.flatMap(({ deadlines }) => deadlines)),
      holderDeadlines,
      scope: resolvedScope.scope,
      scopeId: resolvedScope.id,
      tenantId: query.tenantId,
    });
  });

  /**
   * The catalog entries the pinned revisions reference, newest release first per key (O1); with
   * capability keys, only those capabilities' entries.
   */
  const readCatalogEntries = Effect.fn('TenantIntentLoader.readCatalogEntries')(function* readCatalogEntriesEffect(
    transaction: CoreTransaction,
    snapshotIds: readonly string[],
    capabilityKeys?: readonly string[],
  ) {
    const ids = [...new Set(snapshotIds)];
    if (ids.length === 0) {
      return [];
    }
    const [releases, entries] = yield* Effect.all(
      [
        transaction
          .select({
            catalogSnapshotId: accessCatalogSnapshots.catalogSnapshotId,
            publishedAt: accessCatalogSnapshots.publishedAt,
          })
          .from(accessCatalogSnapshots)
          .where(inArray(accessCatalogSnapshots.catalogSnapshotId, ids))
          .orderBy(asc(accessCatalogSnapshots.publishedAt), asc(accessCatalogSnapshots.catalogSnapshotId)),
        transaction
          .select({
            capabilityKey: accessCatalogEntries.capabilityKey,
            catalogSnapshotId: accessCatalogEntries.catalogSnapshotId,
            entryJson: accessCatalogEntries.entryJson,
          })
          .from(accessCatalogEntries)
          .where(
            and(
              inArray(accessCatalogEntries.catalogSnapshotId, ids),
              capabilityKeys === undefined
                ? undefined
                : inArray(accessCatalogEntries.capabilityKey, [...new Set(capabilityKeys)]),
            ),
          ),
      ],
      { concurrency: 1 },
    );
    return yield* Effect.forEach(
      newestEntryByKey(entries, releases),
      (entry) => decodeStored(decodeCatalogEntry(entry.entryJson), `catalog entry ${entry.capabilityKey}`),
      { concurrency: 1 },
    );
  });

  /** One candidate with its raw identifiers decoded into the branded ones a decision carries. */
  const decodeAuthorityCell = Effect.fn('TenantIntentLoader.authorityCell')(function* decodeAuthorityCellEffect(
    candidate: AuthorityCellCandidate,
  ) {
    const identity = yield* decodeStored(
      decodeCellIdentity(candidate),
      `grant cell of assignment ${candidate.assignmentIncarnationId}`,
    );
    return {
      ...optionalProperty({}, 'amountCeiling', candidate.amountCeiling),
      ...optionalProperty({}, 'deadline', candidate.deadline),
      assignedAt: candidate.assignedAt,
      assignedBy: identity.assignedBy,
      assignmentIncarnationId: identity.assignmentIncarnationId,
      capabilityKey: candidate.capabilityKey,
      grantIncarnationId: identity.grantIncarnationId,
      holder: candidate.holder,
      mode: candidate.mode,
      roleId: identity.roleId,
      roleRevisionId: identity.roleRevisionId,
      selector: candidate.selector,
    } satisfies AuthorityCell;
  });

  /** One holder's cells in one scope, for each of `queries` (all of that tenant, scope and holder). */
  const readHolderCells = Effect.fn('TenantIntentLoader.readHolderCells')(function* readHolderCellsEffect(
    transaction: CoreTransaction,
    queries: readonly [AuthorityCellQuery, ...AuthorityCellQuery[]],
    at: Date,
  ) {
    const [holderQuery] = queries;
    const rows = yield* transaction
      .select(assignmentColumns)
      .from(accessAssignments)
      .where(
        and(
          eq(accessAssignments.tenantId, holderQuery.tenantId),
          eq(accessAssignments.scopeId, holderQuery.scopeId),
          eq(accessAssignments.status, 'active'),
          holderMatch(accessAssignments.principalId, accessAssignments.agentId, holderQuery.holder),
          lte(accessAssignments.validFrom, at),
          // A cell is usable from its start to its end, both compared with the transaction time the
          // decision itself will use, so intent and answer can never disagree (D6).
          or(isNull(accessAssignments.validUntil), gt(accessAssignments.validUntil, at)),
        ),
      );
    if (rows.length === 0) {
      return queries.map((): readonly AuthorityCell[] => []);
    }
    const [revisions, grants, delegationRows] = yield* Effect.all(
      [
        transaction
          .select(
            askedRevisionColumns(
              [...new Set(queries.map((query) => query.capabilityKey))],
              [...new Set(queries.map((query) => query.mode))],
            ),
          )
          .from(accessRoleRevisions)
          .where(
            and(
              eq(accessRoleRevisions.tenantId, holderQuery.tenantId),
              inArray(accessRoleRevisions.roleRevisionId, [...new Set(rows.map((row) => row.roleRevisionId))]),
            ),
          ),
        transaction
          .select({
            capabilityKey: accessGrantIncarnations.capabilityKey,
            grantIncarnationId: accessGrantIncarnations.grantIncarnationId,
            mode: accessGrantIncarnations.mode,
            roleId: accessGrantIncarnations.roleId,
            slot: accessGrantIncarnations.slot,
          })
          .from(accessGrantIncarnations)
          .where(
            and(
              eq(accessGrantIncarnations.tenantId, holderQuery.tenantId),
              eq(accessGrantIncarnations.scopeId, holderQuery.scopeId),
              eq(accessGrantIncarnations.status, 'active'),
              inArray(accessGrantIncarnations.capabilityKey, [...new Set(queries.map((query) => query.capabilityKey))]),
              inArray(accessGrantIncarnations.mode, [...new Set(queries.map((query) => query.mode))]),
              inArray(accessGrantIncarnations.roleId, [...new Set(rows.map((row) => row.roleId))]),
            ),
          ),
        transaction
          .select(delegationColumns)
          .from(accessDelegations)
          .where(
            and(
              eq(accessDelegations.tenantId, holderQuery.tenantId),
              inArray(accessDelegations.delegationId, [
                ...new Set(rows.flatMap((row) => (row.delegatedBy === null ? [] : [row.delegatedBy]))),
              ]),
            ),
          ),
      ],
      { concurrency: 1 },
    );
    const delegatedRows = rows.filter((row) => row.delegatedBy !== null);
    // The delegation's own end and ceiling bound the cell it froze, so the assignment's envelope is read
    // together with the delegation it came from (D10, D10b).
    const envelopes = yield* Effect.forEach(
      delegatedRows,
      (row) => Effect.map(delegatedLimitsOf(row), envelopePairOf(row)),
      { concurrency: 1 },
    );
    const liveDelegations = yield* Effect.forEach(delegationRows, (row) => delegationOf(row), { concurrency: 1 });
    // Whether a delegation's money limit applies is the catalog's to say (D10b), so a delegated read
    // loads the asked capabilities' entries from the releases its held revisions pin.
    const delegatedRevisionIds = new Set(delegatedRows.map((row) => row.roleRevisionId));
    const entries =
      delegatedRows.length === 0
        ? []
        : yield* readCatalogEntries(
            transaction,
            revisions.flatMap((revision) =>
              delegatedRevisionIds.has(revision.roleRevisionId) ? [revision.catalogSnapshotId] : [],
            ),
            queries.map((query) => query.capabilityKey),
          );
    const delegationById = new Map(liveDelegations.map((delegation) => [delegation.id, delegation] as const));
    const envelopeByAssignment = new Map(envelopes.flat());
    // Each revision's cells by capability and mode, so a query reads only its own cells, not the whole revision.
    const revisionsByCapability = new Map<string, Map<string, RevisionRow>>();
    for (const revision of revisions) {
      const cellsByCapability = new Map<string, Cell[]>();
      for (const cell of revision.cellsJson) {
        const key = `${cell.capabilityKey}\u0000${cell.mode}`;
        const known = cellsByCapability.get(key);
        if (known === undefined) {
          cellsByCapability.set(key, [cell]);
        } else {
          known.push(cell);
        }
      }
      for (const [key, cells] of cellsByCapability) {
        const narrowed = revisionsByCapability.get(key) ?? new Map<string, RevisionRow>();
        narrowed.set(revision.roleRevisionId, { ...revision, cellsJson: cells });
        revisionsByCapability.set(key, narrowed);
      }
    }
    // A revision without a cell of the asked capability and mode still stands: it simply offers no cell.
    const revisionsOf = (key: string): ReadonlyMap<string, RevisionRow> =>
      new Map(
        revisions.map((revision) => [
          revision.roleRevisionId,
          revisionsByCapability.get(key)?.get(revision.roleRevisionId) ?? { ...revision, cellsJson: [] },
        ]),
      );
    const grantsByCapability = new Map<string, Map<string, string>>();
    for (const grant of grants) {
      const key = `${grant.capabilityKey}\u0000${grant.mode}`;
      const known = grantsByCapability.get(key) ?? new Map<string, string>();
      known.set(`${grant.roleId}|${grant.slot}`, grant.grantIncarnationId);
      grantsByCapability.set(key, known);
    }
    return yield* Effect.forEach(
      queries,
      (query) => {
        const candidates = cellCandidates({
          amountGoverned: Option.map(
            Option.fromUndefinedOr(entries.find((entry) => entry.key === query.capabilityKey)),
            (entry) => entry.amountInput !== undefined,
          ),
          capabilityKey: query.capabilityKey,
          delegationById,
          envelopeByAssignment,
          grantOfCell: grantsByCapability.get(`${query.capabilityKey}\u0000${query.mode}`) ?? new Map<string, string>(),
          holder: query.holder,
          mode: query.mode,
          revisionById: revisionsOf(`${query.capabilityKey}\u0000${query.mode}`),
          rows,
        });
        return Effect.forEach(candidates, (candidate) => decodeAuthorityCell(candidate), { concurrency: 1 });
      },
      { concurrency: 1 },
    );
  });

  /**
   * The exact cells one holder holds for each asked capability and mode, each with its own end (D6), answered in
   * the asked order. Every query of one tenant, scope and holder shares its assignment, revision, grant, delegation
   * and catalog reads, so a batch costs a fixed number of statements however many capabilities it names.
   */
  const readAuthorityCellsMany = Effect.fn('TenantIntentLoader.readAuthorityCellsMany')(
    function* readAuthorityCellsManyEffect(
      transaction: CoreTransaction,
      queries: readonly AuthorityCellQuery[],
      at: Date,
    ) {
      const groups = new Map<string, [AuthorityCellQuery, ...AuthorityCellQuery[]]>();
      for (const query of queries) {
        const key = [query.tenantId, query.scopeId, holderIdOf(query.holder)].join('\u0000');
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, [query]);
        } else {
          group.push(query);
        }
      }
      // One holder after another inside this one transaction, each with its fixed set of statements.
      const groupList = [...groups.values()];
      const answers = yield* Effect.forEach(groupList, (group) => readHolderCells(transaction, group, at), {
        concurrency: 1,
      });
      const answered = new Map<AuthorityCellQuery, readonly AuthorityCell[]>(
        groupList.flatMap((group, groupIndex) =>
          group.map((query, index) => [query, answers[groupIndex]?.[index] ?? []] as const),
        ),
      );
      return queries.map((query) => answered.get(query) ?? []);
    },
  );

  /** The agent's fresh connection: its consented ceiling comes from the revision it is at (D13). */
  const readAgentConnection = Effect.fn('TenantIntentLoader.readConnection')(function* readAgentConnectionEffect(
    transaction: CoreTransaction,
    query: ConnectionQuery,
  ) {
    const [row] = yield* transaction
      .select(connectionColumns)
      .from(accessAgentConnections)
      .where(
        and(
          eq(accessAgentConnections.tenantId, query.tenantId),
          eq(accessAgentConnections.connectionId, query.connectionId),
        ),
      );
    if (row === undefined) {
      return Option.none<ResolvedAgentConnection>();
    }
    // The ceiling is the consent granted at the connection's current revision. An older snapshot is
    // never a fallback: a missing one leaves the connection without any authority (D13).
    const [consent, identity] = yield* Effect.all(
      [
        transaction
          .select({ ceilingJson: accessConsentSnapshots.ceilingJson })
          .from(accessConsentSnapshots)
          .where(
            and(
              eq(accessConsentSnapshots.tenantId, query.tenantId),
              eq(accessConsentSnapshots.connectionId, query.connectionId),
              eq(accessConsentSnapshots.revision, row.revision),
            ),
          )
          .pipe(Effect.map((rows) => rows[0])),
        decodeStored(
          decodeConnectionIdentity({
            agentId: row.agentId,
            connectionId: row.connectionId,
            principalId: row.principalId,
            scopeId: row.scopeId,
          }),
          `agent connection ${row.connectionId}`,
        ),
      ],
      { concurrency: 1 },
    );
    if (consent === undefined) {
      return Option.none<ResolvedAgentConnection>();
    }
    const ceiling = yield* decodeStored(
      decodeCeiling(consent.ceilingJson),
      `consent ${row.revision} of connection ${row.connectionId}`,
    );
    return Option.some<ResolvedAgentConnection>({
      agentId: identity.agentId,
      ceiling,
      connectionId: identity.connectionId,
      consentRevision: row.revision,
      deadline: asDate(row.validUntil),
      principalId: identity.principalId,
      scopeId: identity.scopeId,
      status: row.status,
    });
  });

  /** The teams one holder takes part in inside one scope; the team relation never crosses a scope. */
  const readHolderTeamIds = Effect.fn('TenantIntentLoader.readTeamIds')(function* readTeamIdsEffect(
    transaction: CoreTransaction,
    query: TeamMembershipQuery,
  ) {
    const rows = yield* transaction
      .select({ teamId: accessTeams.teamId })
      .from(accessTeamMembers)
      .innerJoin(
        accessTeams,
        and(eq(accessTeams.tenantId, accessTeamMembers.tenantId), eq(accessTeams.teamId, accessTeamMembers.teamId)),
      )
      .where(
        and(
          eq(accessTeamMembers.tenantId, query.tenantId),
          eq(accessTeams.scopeId, query.scopeId),
          holderMatch(accessTeamMembers.principalId, accessTeamMembers.agentId, query.holder),
        ),
      );
    return yield* Effect.forEach(rows, (row) => decodeStored(decodeTeamId(row.teamId), `team ${row.teamId}`), {
      concurrency: 1,
    });
  });

  /**
   * One scope's projection intent: the authority that is live at this instant, the revisions it pins,
   * the delegations and connections that bound it, and the modules installed in every scope.
   *
   * Time is filtered here, not left to the graph: a row that has not started yet must not project,
   * because SpiceDB has no "not before" and a tuple would grant it early, and an ended row is gone from
   * intent as it is gone from the decision read (D6). The projection therefore equals the intent read at
   * the same instant, and a scheduled start still needs its own reconcile — no writer creates one today.
   */
  const readScopeProjection = Effect.fn('TenantIntentLoader.readScopeProjection')(function* readScopeProjectionEffect(
    transaction: CoreTransaction,
    tenantId: string,
    row: ScopeRow,
    installations: readonly ModuleKey[],
    at: Date,
  ) {
    const delegations = yield* transaction
      .select(delegationColumns)
      .from(accessDelegations)
      .where(
        and(
          eq(accessDelegations.tenantId, tenantId),
          eq(accessDelegations.scopeId, row.scopeId),
          eq(accessDelegations.status, 'active'),
          lte(accessDelegations.validFrom, at),
          gt(accessDelegations.until, at),
        ),
      );
    const liveDelegations = new Set(delegations.map(({ delegationId }) => delegationId));
    const [scope, assignmentRows, connections] = yield* Effect.all(
      [
        decodeStored(scopeRecordOf(row), `scope ${row.scopeId}`),
        transaction
          .select(assignmentColumns)
          .from(accessAssignments)
          .where(
            and(
              eq(accessAssignments.tenantId, tenantId),
              eq(accessAssignments.scopeId, row.scopeId),
              eq(accessAssignments.status, 'active'),
              lte(accessAssignments.validFrom, at),
              or(isNull(accessAssignments.validUntil), gt(accessAssignments.validUntil, at)),
            ),
          ),
        transaction
          .select(connectionColumns)
          .from(accessAgentConnections)
          .where(
            and(
              eq(accessAgentConnections.tenantId, tenantId),
              eq(accessAgentConnections.scopeId, row.scopeId),
              eq(accessAgentConnections.status, 'active'),
              lte(accessAgentConnections.validFrom, at),
              gt(accessAgentConnections.validUntil, at),
            ),
          ),
      ],
      { concurrency: 1 },
    );
    // An assignment bounded by a delegation that is gone carries no authority: the delegation's end
    // also ends the cells it froze, so intent no longer contains the assignment (D10).
    const assignments = assignmentRows.filter(
      ({ delegatedBy }) => delegatedBy === null || liveDelegations.has(delegatedBy),
    );
    const revisions =
      assignments.length === 0
        ? []
        : yield* transaction
            .select(revisionColumns)
            .from(accessRoleRevisions)
            .where(
              and(
                eq(accessRoleRevisions.tenantId, tenantId),
                inArray(accessRoleRevisions.roleRevisionId, [
                  ...new Set(assignments.map(({ roleRevisionId }) => roleRevisionId)),
                ]),
              ),
            );
    const [decodedAssignments, decodedConnections, decodedDelegations, decodedRevisions] = yield* Effect.all(
      [
        Effect.forEach(assignments, (value) => assignmentOf(value), { concurrency: 1 }),
        Effect.forEach(connections, (value) => connectionOf(value), { concurrency: 1 }),
        Effect.forEach(delegations, (value) => delegationOf(value), { concurrency: 1 }),
        Effect.forEach(revisions, (value) => revisionOf(value), { concurrency: 1 }),
      ],
      { concurrency: 1 },
    );
    return {
      assignments: decodedAssignments,
      connections: decodedConnections,
      delegations: decodedDelegations,
      installations: installations.map((moduleKey) => ({ moduleKey })),
      roleRevisions: decodedRevisions,
      scope,
    } satisfies ScopeProjectionIntent;
  });

  /** The modules whose state still offers the module's data; a narrower state is not installed (O7). */
  const readInstallations = Effect.fn('TenantIntentLoader.readInstallations')(function* readInstallationsEffect(
    transaction: CoreTransaction,
    tenantId: string,
  ) {
    const rows = yield* transaction
      .select({ moduleKey: tenantModuleStates.moduleKey })
      .from(tenantModuleStates)
      .where(
        and(
          eq(tenantModuleStates.tenantId, tenantId),
          inArray(tenantModuleStates.state, [...INSTALLED_TENANT_MODULE_STATES]),
        ),
      );
    return yield* Effect.forEach(
      rows,
      (row) => decodeStored(decodeModuleKey(row.moduleKey), `module installation ${row.moduleKey}`),
      { concurrency: 1 },
    );
  });

  /** One complete, consistent tenant intent: every scope, member, assignment and installation (D13). */
  const readTenantProjection = Effect.fn('TenantIntentLoader.readProjection')(function* readTenantProjectionEffect(
    transaction: CoreTransaction,
    tenantId: TenantId,
    at: Date,
  ) {
    const [scopeRows, memberships, installations, principalRows] = yield* Effect.all(
      [
        readScopeRows(transaction, tenantId),
        readMemberships(transaction, tenantId),
        readInstallations(transaction, tenantId),
        transaction
          .select({ kind: principals.kind, principalId: principals.principalId })
          .from(principals)
          .where(eq(principals.tenantId, tenantId)),
      ],
      { concurrency: 1 },
    );
    const scopes = yield* Effect.forEach(
      scopeRows,
      (row) => readScopeProjection(transaction, tenantId, row, installations, at),
      { concurrency: 1 },
    );
    const catalogEntries = yield* readCatalogEntries(
      transaction,
      scopes.flatMap(({ roleRevisions }) => roleRevisions.map(({ catalogSnapshotId }) => catalogSnapshotId)),
    );
    const scopeOfEntity = new Map(
      scopeRows.flatMap(({ legalEntityId, scopeId }) =>
        legalEntityId === null ? [] : [[legalEntityId, scopeId] as const],
      ),
    );
    const membershipsOf = (legalEntityId: string) =>
      memberships.filter(({ scopeId }) => scopeId === scopeOfEntity.get(legalEntityId));
    const legalEntities: readonly LegalEntityProjectionIntent[] = [...scopeOfEntity.keys()].map((legalEntityId) => ({
      accessAdmins: principalHolders(membershipsOf(legalEntityId), 'access_admin', at),
      legalEntityId,
      members: activeMembers(membershipsOf(legalEntityId), at),
      suspended: suspendedHolders(membershipsOf(legalEntityId), at),
    }));
    const tenantMemberships = memberships.filter(({ scopeId }) => scopeId === tenantScopeIdOf(scopeRows));
    const principalsOfTenant = yield* Effect.forEach(
      principalRows,
      (row) =>
        Effect.map(
          decodeStored(decodePrincipalKind(row.kind), `principal ${row.principalId}`),
          (kind): ProjectionPrincipalIntent => ({ kind, principalId: row.principalId }),
        ),
      { concurrency: 1 },
    );
    return {
      catalogEntries,
      coverage: 'complete',
      legalEntities,
      members: activeMembers(tenantMemberships, at),
      owners: principalHolders(tenantMemberships, 'owner', at),
      principals: principalsOfTenant,
      scopes,
      suspended: suspendedHolders(tenantMemberships, at),
      tenantId,
    } satisfies TenantProjectionIntent;
  });

  const loadScope: TenantIntentLoaderService['loadScope'] = Effect.fn('TenantIntentLoader.loadScope')(
    function* loadScopeEffect(scope: OperationalScope, query: ScopeQuery) {
      yield* assertScope(scope, query.tenantId);
      return yield* readScoped<Option.Option<ResolvedAccessScope>>(scope, (transaction, at) =>
        readResolvedScope(transaction, query, at),
      );
    },
  );

  const loadCompanyOwnership: TenantIntentLoaderService['loadCompanyOwnership'] = Effect.fn(
    'TenantIntentLoader.loadCompanyOwnership',
  )(function* loadCompanyOwnershipEffect(scope: OperationalScope, query: CompanyOwnershipQuery) {
    yield* assertScope(scope, query.tenantId);
    return yield* readScoped<boolean>(scope, (transaction) =>
      transaction
        .select({ scopeId: accessScopes.scopeId })
        .from(accessScopes)
        .where(and(eq(accessScopes.tenantId, query.tenantId), eq(accessScopes.legalEntityId, query.legalEntityId)))
        .limit(1)
        .pipe(Effect.map((rows) => rows.length === 1)),
    );
  });

  const loadTenantContextScopeId: TenantIntentLoaderService['loadTenantContextScopeId'] = Effect.fn(
    'TenantIntentLoader.loadTenantContextScopeId',
  )(function* loadTenantContextScopeIdEffect(scope: OperationalScope) {
    const { tenantId } = yield* scopeIdsOf(scope);
    const rows = yield* readScoped<readonly ScopeRow[]>(scope, (transaction) => readScopeRows(transaction, tenantId));
    return Option.map(Option.fromUndefinedOr(tenantScopeIdOf(rows)), (scopeId) => AccessScopeIdSchema.make(scopeId));
  });

  const loadAuthorityCells: TenantIntentLoaderService['loadAuthorityCells'] = Effect.fn(
    'TenantIntentLoader.loadAuthorityCells',
  )(function* loadAuthorityCellsEffect(scope: OperationalScope, query: AuthorityCellQuery) {
    yield* assertScope(scope, query.tenantId);
    return yield* readScoped<readonly AuthorityCell[]>(scope, (transaction, at) =>
      readAuthorityCellsMany(transaction, [query], at).pipe(Effect.map(([cells = []]) => cells)),
    );
  });

  const loadAuthorityCellsMany: TenantIntentLoaderService['loadAuthorityCellsMany'] = Effect.fn(
    'TenantIntentLoader.loadAuthorityCellsMany',
  )(function* loadAuthorityCellsManyEffect(scope: OperationalScope, queries: readonly AuthorityCellQuery[]) {
    yield* Effect.forEach(new Set(queries.map((query) => query.tenantId)), (tenantId) => assertScope(scope, tenantId), {
      concurrency: 1,
      discard: true,
    });
    if (queries.length === 0) {
      return [];
    }
    return yield* readScoped<readonly (readonly AuthorityCell[])[]>(scope, (transaction, at) =>
      readAuthorityCellsMany(transaction, queries, at),
    );
  });

  const loadConnection: TenantIntentLoaderService['loadConnection'] = Effect.fn('TenantIntentLoader.loadConnection')(
    function* loadConnectionEffect(scope: OperationalScope, query: ConnectionQuery) {
      yield* assertScope(scope, query.tenantId);
      return yield* readScoped<Option.Option<ResolvedAgentConnection>>(scope, (transaction) =>
        readAgentConnection(transaction, query),
      );
    },
  );

  const loadTeamIds: TenantIntentLoaderService['loadTeamIds'] = Effect.fn('TenantIntentLoader.loadTeamIds')(
    function* loadTeamIdsEffect(scope: OperationalScope, query: TeamMembershipQuery) {
      yield* assertScope(scope, query.tenantId);
      return yield* readScoped<readonly AccessTeamId[]>(scope, (transaction) => readHolderTeamIds(transaction, query));
    },
  );

  /**
   * Owner, scope-admin and delegated bases read in one scoped transaction: the projection supplies the
   * owners and delegations, the raw membership rows supply the exact live access-admin windows and
   * their expiry. Both reads belong to ONE transaction, so a suspension committed between them cannot
   * be half-observed: a pool source opens that transaction REPEATABLE READ, and a loader built over a
   * caller's transaction reads the caller's snapshot — which is one snapshot only if the caller opened
   * it at that level, and nothing here claims otherwise.
   */
  const readConfigureBasesIn = Effect.fn('TenantIntentLoader.readConfigureBasesIn')(
    function* readConfigureBasesInEffect(
      transaction: CoreTransaction,
      query: { readonly actor: PrincipalId; readonly at: Date; readonly tenantId: TenantId },
    ) {
      const [intent, memberships] = yield* Effect.all(
        [readTenantProjection(transaction, query.tenantId, query.at), readMemberships(transaction, query.tenantId)],
        { concurrency: 1 },
      );
      return configureBasesOf({ actor: query.actor, at: query.at, intent, memberships });
    },
  );

  const loadConfigureBases: TenantIntentLoaderService['loadConfigureBases'] = Effect.fn(
    'TenantIntentLoader.loadConfigureBases',
  )(function* loadConfigureBasesEffect(scope: OperationalScope, query) {
    yield* assertScope(scope, query.tenantId);
    return yield* readScoped<readonly AccessConfigureBasis[]>(scope, (transaction) =>
      readConfigureBasesIn(transaction, query),
    );
  });

  const loadProjection: TenantIntentLoaderService['loadProjection'] = Effect.fn('TenantIntentLoader.loadProjection')(
    function* loadProjectionEffect(scope: OperationalScope) {
      const { tenantId } = yield* scopeIdsOf(scope);
      return yield* readScoped<TenantProjectionIntent>(scope, (transaction, at) =>
        readTenantProjection(transaction, tenantId, at),
      );
    },
  );

  return Object.freeze({
    joined: (transaction: CoreTransaction) =>
      makeIntentLoaderOver(callerTransactions(transaction, enrollment), enrollment),
    loadAuthorityCells,
    loadAuthorityCellsMany,
    loadCompanyOwnership,
    loadConfigureBases,
    loadConnection,
    loadProjection,
    loadScope,
    loadTeamIds,
    loadTenantContextScopeId,
  });
};

/**
 * The intent reader of one request, over the pool: each read opens a transaction of the request's
 * scope at REPEATABLE READ (O66, D13).
 */
export const makeTenantIntentLoader = (database: AccessIntentDatabase): TenantIntentLoaderService =>
  makeIntentLoaderOver(requestTransactions(database), database.enrollment);

/**
 * The same reader over a transaction the caller already opened and still owns (O75): every read of a
 * loader built this way runs in THAT transaction, so a mandate claim is proved from the rows, cells
 * and memberships its own transaction sees — including changes that transaction has not committed. It
 * opens nothing of its own, and its snapshot is the caller's (`AccessTransactions`).
 */
export const makeJoinedTenantIntentLoader = (
  transaction: CoreTransaction,
  enrollment: DatabaseIdentityEnrollment,
): TenantIntentLoaderService => makeIntentLoaderOver(callerTransactions(transaction, enrollment), enrollment);

export class TenantIntentLoader extends Context.Service<TenantIntentLoader, TenantIntentLoaderService>()(
  '@app/core-runtime/access/intent/tenant-intent-loader/TenantIntentLoader',
) {}

export const TenantIntentLoaderLive = Layer.effect(
  TenantIntentLoader,
  Effect.gen(function* tenantIntentLoaderLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeTenantIntentLoader({ enrollment, executor: database.executor });
  }),
);
