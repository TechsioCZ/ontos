import { DateTime, Effect, Match, Option, Schema } from 'effect';

import type { RecordKey } from '../../src/access/ids.ts';
import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import type { AccessMode, AccessScope, AmountCeiling, CellSelector, Holder } from '../../src/access/model.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CurrencyCodeSchema,
  GrantIncarnationIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RecordKeySchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { AccessTeamIdSchema } from '../../src/access/decision/authority.ts';
import type {
  AccessTeamId,
  AuthorityCell,
  AuthorityCellQuery,
  AuthorityDeadline,
  DecisionAuthorityPort,
  ResolvedAgentConnection,
  ScopeQuery,
} from '../../src/access/decision/authority.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type {
  AccessCheckItem,
  AccessCheckPermissionship,
  AccessCheckResult,
  DecisionCheckPort,
} from '../../src/access/decision/engine.ts';
import {
  holderEquals,
  holderIdOf,
  sideOfHolder as sideOfHolderOf,
  slotTagOf as slotTagOfSelector,
  targetKeysOf,
} from '../../src/access/decision/selector.ts';
import {
  assignmentObjectId,
  capabilityObjectId,
  grantObjectId,
  recordObjectId,
  roleBindingObjectId,
} from '../../src/access/compiler/object-id.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import type { AccessRecordTarget } from '../../src/access/decision/contract.ts';
import type { ListRowProjection } from '../../src/access/decision/list-access.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const at = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

export const tenant = TenantIdSchema.make(uuid(1));
export const person = PrincipalIdSchema.make(uuid(2));
export const otherPerson = PrincipalIdSchema.make(uuid(3));
export const agent = AgentIdSchema.make(uuid(4));
export const scopeId = AccessScopeIdSchema.make(uuid(5));
export const connectionId = AgentConnectionIdSchema.make(uuid(6));
export const scope: AccessScope = { _tag: 'TenantContext', tenantId: tenant };
export const amount = (minor: number, currency = 'CZK') => ({ currency, minor });
export const record = (n: number) => RecordKeySchema.make(`record-${n}`);
/** The module that owns the records of these suites; real module keys are dotted (O27). */
export const RECORD_MODULE = ModuleKeySchema.make('party.registry');
export const recordTargetOf = (recordKey: RecordKey): AccessRecordTarget => ({ moduleKey: RECORD_MODULE, recordKey });
export const recordTarget = (n: number): AccessRecordTarget => recordTargetOf(record(n));
export const team = (n: number): AccessTeamId =>
  AccessTeamIdSchema.make(`00000000-0000-4000-9000-${n.toString().padStart(12, '0')}`);
export const capability = (key: string) => CapabilityKeySchema.make(key);

export const principalHolder = (principalId = person): Holder => ({ _tag: 'Principal', principalId });
export const agentHolder = (agentId = agent): Holder => ({ _tag: 'Agent', agentId });

export interface CellSpec {
  readonly amountCeiling?: { readonly currency: string; readonly limitMinor: number };
  readonly assignment?: number;
  readonly capability?: string;
  readonly deadline?: Date;
  readonly grant?: number;
  readonly holder?: Holder;
  readonly mode?: AccessMode;
  readonly role?: number;
  readonly selector?: CellSelector;
}

let cellSequence = 100;

export const cell = (spec: CellSpec = {}): AuthorityCell => {
  cellSequence += 1;
  const ceiling: AmountCeiling | undefined =
    spec.amountCeiling === undefined
      ? undefined
      : {
          currency: CurrencyCodeSchema.make(spec.amountCeiling.currency),
          limitMinor: spec.amountCeiling.limitMinor,
        };
  const base = {
    assignedAt: at('2026-10-01T00:00:00Z'),
    assignedBy: PrincipalIdSchema.make(uuid(99)),
    assignmentIncarnationId: AssignmentIncarnationIdSchema.make(uuid(spec.assignment ?? cellSequence)),
    capabilityKey: capability(spec.capability ?? 'finance.invoice.void'),
    grantIncarnationId: GrantIncarnationIdSchema.make(uuid(spec.grant ?? cellSequence + 5000)),
    holder: spec.holder ?? principalHolder(),
    mode: spec.mode ?? 'run',
    roleId: RoleIdSchema.make(uuid(spec.role ?? 50)),
    roleRevisionId: RoleRevisionIdSchema.make(uuid((spec.role ?? 50) + 1000)),
    selector: spec.selector ?? { _tag: 'all' as const },
  };
  return withOptional(withOptional(base, 'amountCeiling', ceiling), 'deadline', spec.deadline);
};

export const connect = (overrides: Partial<ResolvedAgentConnection> = {}): ResolvedAgentConnection => ({
  agentId: agent,
  ceiling: { cells: [] },
  connectionId,
  consentRevision: 1,
  deadline: at('2027-01-01T00:00:00Z'),
  principalId: person,
  scopeId,
  status: 'active',
  ...overrides,
});

export interface AuthoritySpec {
  /** The agent's own membership end dates; they default to the person's, as in a real scope. */
  readonly agentMembershipDeadlines?: readonly AuthorityDeadline[];
  /** The port also offers the batched cell read, answering each query exactly as `readCells` does. */
  readonly batchReads?: boolean;
  readonly cells: readonly AuthorityCell[];
  readonly configureBases?: readonly AccessConfigureBasis[];
  readonly configureUnavailable?: boolean;
  readonly connection?: ResolvedAgentConnection;
  readonly legalEntityScope?: AccessScope;
  readonly membershipDeadlines?: readonly AuthorityDeadline[];
  /**
   * Holders without a live membership in the scope: a query naming any of them resolves to none, so
   * the engine itself answers DENIED `deny.scope_mismatch`, as the real intent loader does.
   */
  readonly nonMembers?: readonly Holder[];
  readonly resolvedScopeId?: typeof scopeId;
  readonly teamMembers?: ReadonlyMap<string, readonly AccessTeamId[]>;
}

export interface AuthorityCalls {
  readCells: number;
  readCellsMany: number;
  readCompanyOwnership: number;
  readConfigureBases: number;
  readConnection: number;
  readScope: number;
  readTeamIds: number;
}

export const holderId = (holder: Holder): string => holderIdOf(holder);

export const makeAuthority = (spec: AuthoritySpec) => {
  const calls: AuthorityCalls = {
    readCells: 0,
    readCellsMany: 0,
    readCompanyOwnership: 0,
    readConfigureBases: 0,
    readConnection: 0,
    readScope: 0,
    readTeamIds: 0,
  };
  const cellsOf = (query: AuthorityCellQuery) =>
    spec.cells.filter(
      (candidate) =>
        holderId(candidate.holder) === holderId(query.holder) &&
        candidate.capabilityKey === query.capabilityKey &&
        candidate.mode === query.mode,
    );
  const single: DecisionAuthorityPort = {
    readCells: (query: AuthorityCellQuery) => {
      calls.readCells += 1;
      return Effect.succeed(cellsOf(query));
    },
    // The fixture models one tenant whose every named company is its own.
    readCompanyOwnership: () => {
      calls.readCompanyOwnership += 1;
      return Effect.succeed(true);
    },
    readConfigureBases: () => {
      calls.readConfigureBases += 1;
      return spec.configureUnavailable === true
        ? Effect.fail(accessDecisionUnavailable('configure intent unavailable'))
        : Effect.succeed(spec.configureBases ?? []);
    },
    readConnection: () => {
      calls.readConnection += 1;
      return Effect.succeed(spec.connection === undefined ? Option.none() : Option.some(spec.connection));
    },
    readScope: (query: ScopeQuery) => {
      calls.readScope += 1;
      if (query.holders.some((holder) => spec.nonMembers?.some((absent) => holderEquals(absent, holder)) === true)) {
        return Effect.succeed(Option.none());
      }
      const resolvedScope =
        spec.legalEntityScope === undefined || query.legalEntityId === undefined ? scope : spec.legalEntityScope;
      const principalDeadlines = spec.membershipDeadlines ?? [
        { source: 'membership' as const, until: at('2027-06-01T00:00:00Z') },
      ];
      const holderDeadlines = query.holders.map((holder) => ({
        deadlines:
          sideOfHolderOf(holder) === 'agent'
            ? (spec.agentMembershipDeadlines ?? principalDeadlines)
            : principalDeadlines,
        holder,
      }));
      return Effect.succeed(
        Option.some({
          deadlines: holderDeadlines.flatMap(({ deadlines }) => deadlines),
          holderDeadlines,
          scope: resolvedScope,
          scopeId: spec.resolvedScopeId ?? scopeId,
          tenantId: tenant,
        }),
      );
    },
    readTeamIds: (query) => {
      calls.readTeamIds += 1;
      return Effect.succeed(spec.teamMembers?.get(holderId(query.holder)) ?? []);
    },
  };
  const port: DecisionAuthorityPort =
    spec.batchReads === true
      ? {
          ...single,
          readCellsMany: (queries) => {
            calls.readCellsMany += 1;
            return Effect.succeed(queries.map(cellsOf));
          },
        }
      : single;
  return { calls, port };
};

export interface RecordRow {
  readonly assigned?: Holder;
  readonly entrusted?: Holder;
  readonly recordKey: string;
  readonly teamIds?: readonly AccessTeamId[];
}

export interface CheckSpec {
  readonly authority: AuthoritySpec;
  /** Answers every item with a per-item engine error, which is an unavailable engine (L1). */
  readonly engineError?: boolean;
  readonly failure?: boolean;
  readonly indeterminate?: boolean;
  /** Grant incarnations whose items answer `conditional`: a caveat without usable context. */
  readonly indeterminateGrants?: readonly string[];
  readonly liveGrants?: readonly string[];
  /** Answers fewer items than asked, like a truncated bulk response. */
  readonly missingResults?: number;
  readonly records?: readonly RecordRow[];
}

export interface CheckState {
  readonly calls: { checkBulk: number; items: number };
  readonly port: DecisionCheckPort;
  /** Every item the engine sent, in request order, so a suite can name the witness chain. */
  readonly sent: readonly AccessCheckItem[];
  /** Every subject type the engine asked about, for the "only principal and agent" rule (O48). */
  readonly subjects: readonly string[];
}

/**
 * Only the request-side values may travel in a check: the stored relationship carries the grant's
 * own limits, so a request that re-sends `limit_*` or `resource_keys` is exercising a value SpiceDB
 * ignores (L5). The fake therefore reads the limits from the cell, never from the item context.
 */
const CaveatContextSchema = Schema.Struct({
  amount_minor: Schema.optionalKey(Schema.Number),
  currency: Schema.optionalKey(Schema.String),
  resource_key: Schema.optionalKey(Schema.String),
});

const caveatSatisfied = (item: AccessCheckItem, candidate: AuthorityCell): boolean => {
  const context = Schema.decodeUnknownOption(CaveatContextSchema)(item.context ?? {});
  if (Option.isNone(context)) {
    return false;
  }
  const { amount_minor: amountMinor, currency, resource_key: resourceKey } = context.value;
  const targetKeys = targetKeysOf(candidate.selector);
  if (targetKeys.length > 0 && (resourceKey === undefined || !targetKeys.some((key) => key === resourceKey))) {
    return false;
  }
  const ceiling = candidate.amountCeiling;
  if (ceiling !== undefined) {
    if (amountMinor === undefined || currency === undefined) {
      return false;
    }
    if (currency !== ceiling.currency || amountMinor > ceiling.limitMinor) {
      return false;
    }
  }
  return true;
};

const subjectHolder = (item: AccessCheckItem): Holder =>
  item.subject.type === 'agent'
    ? { _tag: 'Agent', agentId: AgentIdSchema.make(item.subject.id) }
    : { _tag: 'Principal', principalId: PrincipalIdSchema.make(item.subject.id) };

const capabilityObjectOf = (capabilityKey: string): string => capabilityObjectId(tenant, scopeId, capabilityKey);
const grantObjectOf = (candidate: AuthorityCell): string => grantObjectId(tenant, scopeId, candidate.roleId, candidate);
const assignmentObjectOf = (candidate: AuthorityCell): string =>
  assignmentObjectId(tenant, scopeId, candidate.assignmentIncarnationId);
const bindingObjectOf = (candidate: AuthorityCell): string => roleBindingObjectId(tenant, scopeId, candidate.roleId);

/**
 * One live cell of the plan, found by the object the engine named. The suites model the v2 graph,
 * not the engine: every item is answered from the cells themselves, so a witness chain that names
 * the wrong incarnation, binding or slot resolves to `none` (M1).
 */
const liveCell = (spec: CheckSpec, objectId: string, of: (cell: AuthorityCell) => string, live: ReadonlySet<string>) =>
  spec.authority.cells.find((candidate) => of(candidate) === objectId && live.has(candidate.grantIncarnationId));

/** The grant cell itself: the exact grant object, with the request context for its caveat. */
const grantAnswer = (spec: CheckSpec, live: ReadonlySet<string>, item: AccessCheckItem) => {
  const grant = liveCell(spec, item.resource.id, grantObjectOf, live);
  return grant !== undefined && caveatSatisfied(item, grant) ? 'has' : 'none';
};

/** The capability slot relation names the exact grant object; no caveat takes part in this answer. */
const slotAnswer = (spec: CheckSpec, live: ReadonlySet<string>, item: AccessCheckItem) => {
  const { subject } = item;
  return subject.type === 'access_grant' &&
    spec.authority.cells.some(
      (candidate) =>
        capabilityObjectOf(candidate.capabilityKey) === item.resource.id &&
        `${candidate.mode}_${slotTagOfSelector(candidate.selector)}_grant` === item.permission &&
        grantObjectOf(candidate) === subject.id &&
        live.has(candidate.grantIncarnationId),
    )
    ? 'has'
    : 'none';
};

/** The assignment incarnation is live and its holder is the subject. */
const assignmentAnswer = (spec: CheckSpec, live: ReadonlySet<string>, item: AccessCheckItem) => {
  const assignment = liveCell(spec, item.resource.id, assignmentObjectOf, live);
  return assignment !== undefined && holderEquals(assignment.holder, subjectHolder(item)) ? 'has' : 'none';
};

/** Exactly this assignment incarnation is the member userset of this binding. */
const bindingAnswer = (spec: CheckSpec, live: ReadonlySet<string>, item: AccessCheckItem) => {
  const { permission, resource, subject } = item;
  const relation = permission === 'agent_member' ? 'agent_holder' : 'holder';
  if (subject.type !== 'access_assignment' || (subject.relation ?? '') !== relation) {
    return 'none';
  }
  const member = spec.authority.cells.find(
    (candidate) =>
      bindingObjectOf(candidate) === resource.id &&
      assignmentObjectOf(candidate) === subject.id &&
      live.has(candidate.grantIncarnationId),
  );
  return member === undefined ? 'none' : 'has';
};

/** The owner's record projection: only the named relation matches, and a NULL column never does. */
const recordAnswer = (spec: CheckSpec, item: AccessCheckItem) => {
  const row = (spec.records ?? []).find(
    ({ recordKey }) => recordObjectId(tenant, scopeId, RECORD_MODULE, recordKey) === item.resource.id,
  );
  if (row === undefined) {
    return 'none';
  }
  const holder = subjectHolder(item);
  if (item.permission === 'assigned_match') {
    return row.assigned !== undefined && holderEquals(row.assigned, holder) ? 'has' : 'none';
  }
  if (item.permission === 'entrusted_match') {
    return row.entrusted !== undefined && holderEquals(row.entrusted, holder) ? 'has' : 'none';
  }
  const teams = spec.authority.teamMembers?.get(holderId(holder)) ?? [];
  return (row.teamIds ?? []).some((rowTeam) => teams.includes(rowTeam)) ? 'has' : 'none';
};

export const makeCheck = (spec: CheckSpec): CheckState => {
  const calls = { checkBulk: 0, items: 0 };
  const sent: AccessCheckItem[] = [];
  const subjects: string[] = [];
  const live = new Set(spec.liveGrants ?? spec.authority.cells.map(({ grantIncarnationId }) => grantIncarnationId));
  const classify = (item: AccessCheckItem): AccessCheckPermissionship =>
    Match.value(item.resource.type).pipe(
      Match.when('access_grant', () => grantAnswer(spec, live, item)),
      Match.when('access_capability', () => slotAnswer(spec, live, item)),
      Match.when('access_assignment', () => assignmentAnswer(spec, live, item)),
      Match.when('access_role_binding', () => bindingAnswer(spec, live, item)),
      Match.orElse(() => recordAnswer(spec, item)),
    );
  const cellOfItem = (item: AccessCheckItem): AuthorityCell | undefined => {
    const byResource = spec.authority.cells.find(
      (candidate) =>
        grantObjectOf(candidate) === item.resource.id || assignmentObjectOf(candidate) === item.resource.id,
    );
    if (byResource !== undefined) {
      return byResource;
    }
    const { subject } = item;
    return subject.type === 'access_grant'
      ? spec.authority.cells.find((candidate) => grantObjectOf(candidate) === subject.id)
      : spec.authority.cells.find((candidate) => assignmentObjectOf(candidate) === subject.id);
  };
  const permissionshipOfItem = (item: AccessCheckItem): AccessCheckPermissionship => {
    if (spec.engineError === true) {
      return 'error';
    }
    if (spec.indeterminate === true) {
      return 'conditional';
    }
    const incarnation = cellOfItem(item)?.grantIncarnationId;
    if (incarnation !== undefined && spec.indeterminateGrants?.includes(incarnation) === true) {
      return 'conditional';
    }
    return classify(item);
  };
  const port: DecisionCheckPort = {
    checkBulk: (items) => {
      calls.checkBulk += 1;
      calls.items += items.length;
      sent.push(...items);
      subjects.push(...items.map((item) => item.subject.type));
      if (spec.failure === true) {
        return Effect.fail(accessDecisionUnavailable('test engine failure'));
      }
      const answers = items.map((item): AccessCheckResult => ({ permissionship: permissionshipOfItem(item) }));
      return Effect.succeed(spec.missingResults === undefined ? answers : answers.slice(spec.missingResults));
    },
  };
  return { calls, port, sent, subjects };
};

export const row = (
  spec: Omit<Partial<ListRowProjection>, 'recordKey'> & { readonly recordKey: string },
): ListRowProjection => ({
  ...spec,
  recordKey: RecordKeySchema.make(spec.recordKey),
  teamIds: spec.teamIds ?? [],
});
