import { Context, Effect, Match, Option, Schema } from 'effect';
import type { Array as Arr } from 'effect';

import type {
  AccessScopeId,
  AgentConnectionId,
  AgentId,
  AssignmentIncarnationId,
  CapabilityKey,
  GrantIncarnationId,
  LegalEntityId,
  PrincipalId,
  RoleId,
  RoleRevisionId,
  TenantId,
} from '../ids.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AccessConfigureBasis } from '../changes/authority.ts';
import type {
  AccessMode,
  AccessScope,
  ActorContext,
  AmountCeiling,
  CellSelector,
  ConsentCeiling,
  DecisionReason,
  Holder,
  LifecycleStatus,
} from '../model.ts';
import { sameHolder } from '../model.ts';
import { decisionReason } from './contract.ts';
import type { AccessDecisionRequest } from './contract.ts';
import type { AccessDecisionUnavailable } from './errors.ts';
import type { HolderSide } from './selector.ts';

/** Team identity for the list predicate contract; immutable ids, never human-chosen slugs (O9). */
export const AccessTeamIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AccessTeamId'));
export type AccessTeamId = typeof AccessTeamIdSchema.Type;

export const AUTHORITY_DEADLINE_SOURCES = ['assignment', 'connection', 'delegation', 'membership'] as const;
export type AuthorityDeadlineSource = (typeof AUTHORITY_DEADLINE_SOURCES)[number];

/** One end date that applies to an authority path; the admission deadline is their minimum (D6). */
export interface AuthorityDeadline {
  readonly source: AuthorityDeadlineSource;
  readonly until: Date;
}

export const holderOf = (side: HolderSide, actor: ActorContext): Holder =>
  Match.value(actor).pipe(
    Match.tags({
      Agent: ({ agentId, principalId }): Holder =>
        side === 'agent' ? { _tag: 'Agent', agentId } : { _tag: 'Principal', principalId },
      Principal: ({ principalId }): Holder => ({ _tag: 'Principal', principalId }),
    }),
    Match.exhaustive,
  );

/** The membership end dates of one member of the scope (tenant and legal entity, D6). */
export interface HolderMembershipDeadlines {
  readonly deadlines: readonly AuthorityDeadline[];
  readonly holder: Holder;
}

export interface ResolvedAccessScope {
  /** Membership end dates that bound every path in this scope (tenant and legal entity). */
  readonly deadlines: readonly AuthorityDeadline[];
  /**
   * The same deadlines per holder, so the person's own membership end is refused and the agent's
   * only bounds the agent's paths instead of being read as the other holder's (D6, M2).
   */
  readonly holderDeadlines: readonly HolderMembershipDeadlines[];
  readonly scope: AccessScope;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

export interface ScopeQuery {
  /**
   * A tenant-context request that names a company (O66, O88): the scope resolves only when that company is one of the
   * tenant's own scopes, answered from the scope rows this read loads anyway, never by a read of its own.
   */
  readonly checkedCompany?: LegalEntityId;
  /** Every holder that takes part in the decision: the person and, for an agent, the agent. */
  readonly holders: readonly Holder[];
  readonly legalEntityId?: LegalEntityId;
  readonly tenantId: TenantId;
}

/** A company a request names, and the tenant it must belong to (O66, O88). */
export interface CompanyOwnershipQuery {
  readonly legalEntityId: LegalEntityId;
  readonly tenantId: TenantId;
}

/** The freshly read connection of an agent: consent revisions are never cached. */
export interface ResolvedAgentConnection {
  /** The one agent this consent was granted to; a connection never authorizes another agent. */
  readonly agentId: AgentId;
  readonly ceiling: ConsentCeiling;
  readonly connectionId: AgentConnectionId;
  readonly consentRevision: number;
  readonly deadline: Date;
  readonly principalId: PrincipalId;
  /** The one scope the consent and its ceiling were granted in (guarantee 3, O51(5)). */
  readonly scopeId: AccessScopeId;
  readonly status: LifecycleStatus;
}

export interface ConnectionQuery {
  readonly connectionId: AgentConnectionId;
  readonly tenantId: TenantId;
}

/**
 * One exact grant cell of one holder, as PostgreSQL intent records it. The engine never combines
 * cells across grants; a cell is usable only within its own limits and record scope (guarantee 9).
 *
 * `deadline` is the earliest applicable end of this exact cell: the assignment end, the delegation
 * end and `limits.until` of a delegated cell, whichever comes first (D6, M2). The engine never
 * invents an end date of its own.
 */
export interface AuthorityCell {
  readonly amountCeiling?: AmountCeiling;
  readonly assignedAt: Date;
  readonly assignedBy: PrincipalId;
  readonly assignmentIncarnationId: AssignmentIncarnationId;
  readonly capabilityKey: CapabilityKey;
  readonly deadline?: Date;
  readonly grantIncarnationId: GrantIncarnationId;
  readonly holder: Holder;
  readonly mode: AccessMode;
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
  readonly selector: CellSelector;
}

export interface AuthorityCellQuery {
  readonly capabilityKey: CapabilityKey;
  readonly holder: Holder;
  readonly mode: AccessMode;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

export interface TeamMembershipQuery {
  readonly holder: Holder;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

/**
 * Read-only view of Core's source of intent. It is owner-local and transaction-scoped in the
 * runtime; the decision engine only consumes it. A read failure is UNAVAILABLE, never a deny.
 */
export interface DecisionAuthorityPort {
  readonly readCells: (query: AuthorityCellQuery) => Effect.Effect<readonly AuthorityCell[], AccessDecisionUnavailable>;
  /**
   * `readCells` for every query of one batch in one read, answered in the asked order. A batch decision reads its
   * cell sets here when the port offers it, so its intent cost does not grow with the capabilities it asks.
   */
  readonly readCellsMany?: (
    queries: readonly AuthorityCellQuery[],
  ) => Effect.Effect<readonly (readonly AuthorityCell[])[], AccessDecisionUnavailable>;
  /**
   * Whether the company a request names is one of the asked tenant's own: the one company-of-tenant read every gate
   * path asks before deciding (O66, O88). It reads no membership.
   */
  readonly readCompanyOwnership: (query: CompanyOwnershipQuery) => Effect.Effect<boolean, AccessDecisionUnavailable>;
  /** Fresh Core configure authority for a structural admin decision (O81). An absent port is unavailable. */
  readonly readConfigureBases?: (query: {
    readonly actor: PrincipalId;
    readonly at: Date;
    readonly tenantId: TenantId;
  }) => Effect.Effect<readonly AccessConfigureBasis[], AccessDecisionUnavailable>;
  readonly readConnection: (
    query: ConnectionQuery,
  ) => Effect.Effect<Option.Option<ResolvedAgentConnection>, AccessDecisionUnavailable>;
  readonly readScope: (
    query: ScopeQuery,
  ) => Effect.Effect<Option.Option<ResolvedAccessScope>, AccessDecisionUnavailable>;
  /**
   * The reads run in a transaction a caller owns (O75). Each one installs its scope with its own statement on that
   * one connection, so they must never overlap: the engine reads through such a port one read at a time.
   */
  readonly readsThroughCallerTransaction?: true;
  readonly readTeamIds: (
    query: TeamMembershipQuery,
  ) => Effect.Effect<readonly AccessTeamId[], AccessDecisionUnavailable>;
}

/**
 * The runtime binds the source of every request's `DecisionAuthorityPort` through this service tag;
 * `AccessIntentLive` answers it from Core's intent loader.
 */
export class AccessIntent extends Context.Service<
  AccessIntent,
  {
    /** One decision port per request scope: the engine's queries never carry one (O66). */
    readonly authorityFor: (scope: OperationalScope) => DecisionAuthorityPort;
    /**
     * The same source over a transaction the caller already owns (O75): the loader's own `joined`
     * factory answers, so a decision taken inside an owner Action's transaction reads that
     * transaction's intent instead of opening a second connection. A loader that cannot join leaves
     * this absent, and the caller keeps the request source it already has.
     */
    readonly joined?: (transaction: CoreTransaction) => {
      readonly authorityFor: (scope: OperationalScope) => DecisionAuthorityPort;
    };
  }
>()('@app/core-runtime/access/decision/authority/AccessIntent') {}

/** The decision side of Core's access intent, as the runtime binds it. */
export type AccessIntentSource = (typeof AccessIntent)['Service'];

export interface ActorContextInput {
  /** The authenticated principal, or the agent together with its connection and consent revision. */
  readonly actor: ActorContext;
  /** The trusted legal-entity context from the request; omitted for tenant-context capabilities (O28). */
  readonly legalEntityId?: LegalEntityId;
  readonly tenantId: TenantId;
}

export interface ResolvedActor {
  readonly actor: ActorContext;
  /** The agent's own holder, present exactly for an agent actor. */
  readonly agentHolder?: Holder;
  readonly consentCeiling?: ConsentCeiling;
  readonly deadlines: readonly AuthorityDeadline[];
  readonly principalHolder: Holder;
  readonly scope: ResolvedAccessScope;
}

/**
 * Either the resolved actor, a refusal (denial), or unavailable intent. Plain optional fields keep
 * callers off tag inspection while still making every outcome explicit.
 */
export interface ActorResolution {
  readonly refusal?: Arr.NonEmptyReadonlyArray<DecisionReason>;
  readonly resolved?: ResolvedActor;
  readonly unavailable?: readonly DecisionReason[];
}

const refused = (reasons: Arr.NonEmptyReadonlyArray<DecisionReason>): ActorResolution => ({ refusal: reasons });
const unreadable = (): ActorResolution => ({ unavailable: [decisionReason('unavailable.intent')] });

const hasPassed = (deadline: Date, now: Date): boolean => deadline <= now;

const agentIdentityOf = (actor: ActorContext) =>
  Match.value(actor).pipe(
    Match.tag('Agent', (agentActor) => agentActor),
    Match.option,
  );

const scopeQueryOf = (input: ActorContextInput): ScopeQuery => {
  const { legalEntityId, tenantId } = input;
  const principalHolder = holderOf('principal', input.actor);
  const agentHolder = Option.getOrUndefined(agentIdentityOf(input.actor));
  const holders: readonly Holder[] =
    agentHolder === undefined ? [principalHolder] : [principalHolder, holderOf('agent', input.actor)];
  return legalEntityId === undefined ? { holders, tenantId } : { holders, legalEntityId, tenantId };
};

/**
 * The end dates that belong to one holder of the scope. A holder the scope does not list carries no
 * membership deadline; the graph's `scope->access` check is what proves the membership itself. The
 * entry is matched by holder identity, never by side, so another person's (or another agent's) end
 * date is never read as this holder's own (D6, M2, R4-L5).
 */
const deadlinesOfHolder = (scope: ResolvedAccessScope, holder: Holder): readonly AuthorityDeadline[] =>
  scope.holderDeadlines.find((candidate) => sameHolder(candidate.holder, holder))?.deadlines ?? [];

const resolvePrincipal = (input: ActorContextInput, scope: ResolvedAccessScope, now: Date): ActorResolution => {
  const principalHolder = holderOf('principal', input.actor);
  const principalDeadlines = deadlinesOfHolder(scope, principalHolder);
  if (principalDeadlines.some(({ until }) => hasPassed(until, now))) {
    return refused([decisionReason('deny.deadline_passed')]);
  }
  return {
    resolved: {
      actor: input.actor,
      deadlines: [...principalDeadlines],
      principalHolder,
      scope,
    },
  };
};

/**
 * Resolves the authenticated actor against trusted context: exactly one scope, fresh connection
 * and consent revision, and every applicable end date. A stale consent revision is a denial, never
 * a reason to fall back to an older ceiling (D13, guarantee 6). A connection consented for another
 * agent, another person or another scope is never reused: the ceiling it carries has no scope of
 * its own, so the connection must name the one agent and the one scope it was granted in (H2).
 */
export const resolveActorContext: (
  authority: DecisionAuthorityPort,
  input: ActorContextInput,
  now: Date,
) => Effect.Effect<ActorResolution> = Effect.fn('AccessDecision.resolveActorContext')(
  function* resolveActorContextEffect(authority: DecisionAuthorityPort, input: ActorContextInput, now: Date) {
    const scopeRead = yield* Effect.option(authority.readScope(scopeQueryOf(input)));
    if (Option.isNone(scopeRead)) {
      return unreadable();
    }
    const scope = Option.getOrUndefined(scopeRead.value);
    if (scope === undefined) {
      return refused([decisionReason('deny.scope_mismatch')]);
    }
    const principalResolution = resolvePrincipal(input, scope, now);
    if (principalResolution.refusal !== undefined || principalResolution.resolved === undefined) {
      return principalResolution;
    }
    const agentActor = Option.getOrUndefined(agentIdentityOf(input.actor));
    if (agentActor === undefined) {
      return principalResolution;
    }
    const connectionRead = yield* Effect.option(
      authority.readConnection({ connectionId: agentActor.connectionId, tenantId: input.tenantId }),
    );
    if (Option.isNone(connectionRead)) {
      return unreadable();
    }
    const connection = Option.getOrUndefined(connectionRead.value);
    if (connection === undefined) {
      return refused([decisionReason('deny.connection_inactive')]);
    }
    if (
      connection.status !== 'active' ||
      connection.principalId !== agentActor.principalId ||
      connection.agentId !== agentActor.agentId ||
      connection.scopeId !== scope.scopeId ||
      hasPassed(connection.deadline, now)
    ) {
      return refused([decisionReason('deny.connection_inactive')]);
    }
    if (connection.consentRevision !== agentActor.consentRevision) {
      return refused([decisionReason('deny.consent_stale')]);
    }
    const agentHolder = holderOf('agent', input.actor);
    const agentDeadlines = deadlinesOfHolder(scope, agentHolder);
    if (agentDeadlines.some(({ until }) => hasPassed(until, now))) {
      // The agent itself is no longer a member of this scope, so no agent path can carry authority.
      return refused([decisionReason('deny.deadline_passed')]);
    }
    return {
      resolved: {
        ...principalResolution.resolved,
        agentHolder,
        consentCeiling: connection.ceiling,
        deadlines: [
          ...principalResolution.resolved.deadlines,
          ...agentDeadlines,
          { source: 'connection', until: connection.deadline },
        ],
      },
    };
  },
);

/** Reads the cells of one side for the policy under evaluation. */
export const readAuthorityCells = (
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  request: AccessDecisionRequest,
  mode: AccessMode,
  side: HolderSide,
): Effect.Effect<readonly AuthorityCell[], AccessDecisionUnavailable> => {
  const holder = side === 'agent' ? resolved.agentHolder : resolved.principalHolder;
  if (holder === undefined) {
    return Effect.succeed([]);
  }
  return authority.readCells({
    capabilityKey: request.capability.capabilityKey,
    holder,
    mode,
    scopeId: resolved.scope.scopeId,
    tenantId: resolved.scope.tenantId,
  });
};

export const readParentReadCells = (
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  capabilityKey: CapabilityKey,
  side: HolderSide,
  mode: AccessMode = 'run',
): Effect.Effect<readonly AuthorityCell[], AccessDecisionUnavailable> => {
  const holder = side === 'agent' ? resolved.agentHolder : resolved.principalHolder;
  if (holder === undefined) {
    return Effect.succeed([]);
  }
  return authority.readCells({
    capabilityKey,
    holder,
    mode,
    scopeId: resolved.scope.scopeId,
    tenantId: resolved.scope.tenantId,
  });
};
