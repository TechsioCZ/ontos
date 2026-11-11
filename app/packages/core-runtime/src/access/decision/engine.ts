import { Context, DateTime, Effect, Exit, Match, Option, Schema } from 'effect';
import type { Array as Arr } from 'effect';

import type { AccessScopeId, CapabilityKey, LegalEntityId, PrincipalId, RecordKey } from '../ids.ts';
import { LegalEntityIdSchema } from '../ids.ts';
import { configureBasisFor } from '../changes/authority.ts';
import type { AccessConfigureBasis } from '../changes/authority.ts';
import type {
  AccessKind,
  AccessMode,
  AccessScope,
  ActorContext,
  AmountCeiling,
  Cell,
  CellSelector,
  ConsentCeiling,
  DecisionReason,
  Holder,
  WitnessPurpose,
} from '../model.ts';
import { readAuthorityCells, readParentReadCells, resolveActorContext } from './authority.ts';
import type {
  AccessTeamId,
  ActorContextInput,
  ActorResolution,
  AuthorityCell,
  AuthorityCellQuery,
  DecisionAuthorityPort,
  ResolvedActor,
} from './authority.ts';
import { decisionReason, earliestDeadline, sameRecord } from './contract.ts';
import type {
  AccessAmount,
  AccessDecision,
  AccessDecisionRequest,
  AccessRecordTarget,
  DecisionCapabilityPolicy,
  GrantedAuthorityEvidence,
  ResolvedRecordSelector,
  StructuralAuthorityEvidence,
} from './contract.ts';
import { accessDecisionUnavailable } from './errors.ts';
import type { AccessDecisionUnavailable } from './errors.ts';
import { buildListAccessPredicate } from './list-access.ts';
import type { ListAccessPredicate, ListAuthorityCell, ListAuthoritySide } from './list-access.ts';
import { withOptional } from './optional.ts';
import { capabilitySlotRelation } from '../compiler/object-id.ts';
import {
  assignmentObjectIdOf,
  capabilityObjectIdOf,
  grantObjectIdOf,
  projectionScopeOf,
  recordObjectIdOf,
  roleBindingObjectIdOf,
} from './projection.ts';
import type { ProjectionScope } from './projection.ts';
import {
  holderIdOf,
  holderSubjectOf,
  isTargetSelection,
  recordSelectorOf,
  selectorTagOf,
  sideOfHolder,
  targetKeysOf,
} from './selector.ts';
import type { HolderSide } from './selector.ts';

const ACCESS_ASSIGNMENT = 'access_assignment';
const ACCESS_GRANT = 'access_grant';
const ACCESS_ROLE_BINDING = 'access_role_binding';
const ACCESS_CAPABILITY = 'access_capability';
const ACCESS_RECORD = 'access_record';
const AGENT_SIDE: HolderSide = 'agent';
const APPROVE_MODE = 'approve';
const CAVEAT_INDETERMINATE = decisionReason('deny.caveat_indeterminate');
const PROPOSE_MODE = 'propose';
const PRINCIPAL_SIDE: HolderSide = 'principal';
const PURPOSE_REQUESTER: WitnessPurpose = 'requester';
const PURPOSE_PARENT: WitnessPurpose = 'parent_record_read';
const RUN_MODE: AccessMode = 'run';
const AGENT_FORBIDDEN = decisionReason('deny.agent_forbidden');
const INSUFFICIENT_GRANT = decisionReason('deny.insufficient_grant');
const MODE_UNSUPPORTED = decisionReason('deny.mode_unsupported');
const PARENT_READ_REQUIRED = decisionReason('deny.parent_read_required');
const UNAVAILABLE_INTENT = decisionReason('unavailable.intent');
const TARGET_REQUIRED = decisionReason('deny.target_required');

export interface AccessCheckResource {
  readonly id: string;
  readonly type: string;
}

/**
 * The subject types a v2 check names: the two holders (a verified human and an agent, O48) and the
 * two projection objects a relation check correlates with (one exact grant and one exact assignment
 * incarnation). Every other principal kind stays outside v2.
 */
export const AccessCheckSubjectTypeSchema = Schema.Literals([
  'access_assignment',
  'access_grant',
  'agent',
  'principal',
]);
export type AccessCheckSubjectType = typeof AccessCheckSubjectTypeSchema.Type;

export interface AccessCheckSubject {
  readonly id: string;
  readonly relation?: string;
  readonly type: AccessCheckSubjectType;
}

export type AccessCheckContextValue = number | readonly string[] | string;
export type AccessCheckContext = Readonly<Record<string, AccessCheckContextValue>>;

export interface AccessCheckItem {
  readonly context?: AccessCheckContext;
  readonly permission: string;
  readonly resource: AccessCheckResource;
  readonly subject: AccessCheckSubject;
}

/**
 * One item's answer. `conditional` is a caveat the engine could not evaluate with the context it
 * was given (fail closed), and `error` is a per-item engine error, which is an unavailable engine
 * rather than a denial (O48b, L1).
 */
export const AccessCheckPermissionshipSchema = Schema.Literals(['conditional', 'error', 'has', 'none']);
export type AccessCheckPermissionship = typeof AccessCheckPermissionshipSchema.Type;
export interface AccessCheckResult {
  readonly permissionship: AccessCheckPermissionship;
}

/**
 * The one engine port. A whole decision is exactly one `CheckBulkPermissions` snapshot, so a
 * capability slot and the exact grant that fills it are never evaluated independently (D22).
 */
export interface DecisionCheckPort {
  readonly checkBulk: (
    items: readonly AccessCheckItem[],
  ) => Effect.Effect<readonly AccessCheckResult[], AccessDecisionUnavailable>;
}

/** The runtime binds the SpiceDB check transport through this service tag. */
export class DecisionCheck extends Context.Service<DecisionCheck, DecisionCheckPort>()(
  '@app/core-runtime/access/decision/engine/DecisionCheck',
) {}

const subjectOf = (holder: Holder): AccessCheckSubject => holderSubjectOf(holder);

/**
 * The request-side values of one caveat call. Only what the request supplies travels: the grant's
 * own limits (`limit_minor`, `limit_currency`, `resource_keys`) are already stored in the
 * relationship, SpiceDB always uses the stored value, and re-sending them both wastes the 4096-byte
 * request context and invites a disagreement with the projection (L5).
 */
const checkContext = (params: {
  readonly amount?: AccessAmount;
  readonly ceiling?: AmountCeiling;
  readonly selector: CellSelector;
  readonly target?: RecordKey;
}): AccessCheckContext | undefined => {
  const context: Record<string, AccessCheckContextValue> = {};
  if (params.ceiling !== undefined && params.amount !== undefined) {
    context['amount_minor'] = params.amount.minor;
    context['currency'] = params.amount.currency;
  }
  if (isTargetSelection(params.selector) && params.target !== undefined) {
    context['resource_key'] = params.target;
  }
  return Object.keys(context).length === 0 ? undefined : context;
};

interface PlannedCell {
  readonly cell: AuthorityCell;
  readonly items: readonly AccessCheckItem[];
  readonly purpose: WitnessPurpose;
  readonly side: HolderSide;
}

interface PlannedSide {
  readonly cells: readonly PlannedCell[];
  readonly holder: Holder;
  readonly side: HolderSide;
}

interface CapabilityPlan {
  readonly blockers: readonly DecisionReason[];
  readonly capabilityKey: CapabilityKey;
  readonly mode: AccessMode;
  readonly purpose: WitnessPurpose;
  readonly sides: readonly PlannedSide[];
}

interface SideCells {
  readonly cells: readonly AuthorityCell[];
  readonly holder: Holder;
  readonly side: HolderSide;
}

interface PlanCapabilityInput {
  readonly amount?: AccessAmount;
  readonly capabilityKey: CapabilityKey;
  readonly ceiling?: ConsentCeiling;
  readonly mode: AccessMode;
  readonly now: Date;
  readonly policy: DecisionCapabilityPolicy;
  readonly purpose: WitnessPurpose;
  readonly scope: ProjectionScope;
  readonly sides: readonly SideCells[];
  readonly target?: AccessRecordTarget;
}

const uniqueReasons = (reasons: readonly DecisionReason[]): readonly DecisionReason[] => {
  const seen = new Map<string, DecisionReason>();
  for (const reason of reasons) {
    if (!seen.has(reason.code)) {
      seen.set(reason.code, reason);
    }
  }
  return [...seen.values()];
};

const amountWithin = (ceiling: AmountCeiling, amount: AccessAmount): boolean =>
  amount.currency === ceiling.currency && amount.minor >= 0 && amount.minor <= ceiling.limitMinor;

/** A ceiling cell that may cover the grant cell; explicit-target ceilings narrow, never widen. */
const ceilingCoversSelector = (ceiling: CellSelector, cell: CellSelector, target?: RecordKey): boolean => {
  const ceilingRecord = recordSelectorOf(ceiling);
  const cellRecord = recordSelectorOf(cell);
  if (ceilingRecord === 'all') {
    return true;
  }
  if (ceilingRecord === undefined) {
    return target !== undefined && targetKeysOf(ceiling).includes(target);
  }
  if (cellRecord === undefined) {
    return false;
  }
  return cellRecord !== 'all' && cellRecord === ceilingRecord;
};

/**
 * A connection ceiling may narrow a list (explicit targets) but never widen it. A targets ceiling
 * is therefore compatible with any grant, while a targets grant requires an all/targets ceiling.
 */
const listCeilingCompatible = (ceilingSelector: CellSelector, grantSelector: CellSelector): boolean => {
  const ceilingRecord = recordSelectorOf(ceilingSelector);
  const grantRecord = recordSelectorOf(grantSelector);
  if (ceilingRecord === 'all') {
    return true;
  }
  if (grantRecord === undefined) {
    return ceilingRecord === undefined;
  }
  if (ceilingRecord === undefined) {
    return true;
  }
  return grantRecord !== 'all' && grantRecord === ceilingRecord;
};

const ceilingCandidates = (ceiling: ConsentCeiling | undefined, cell: AuthorityCell): readonly Cell[] => {
  if (ceiling === undefined) {
    return [];
  }
  return ceiling.cells.filter(
    (candidate) =>
      candidate.capabilityKey === cell.capabilityKey &&
      candidate.mode === cell.mode &&
      listCeilingCompatible(candidate.selector, cell.selector),
  );
};

interface CeilingCoverage {
  readonly covered: boolean;
  readonly reason?: 'amount_missing' | 'amount_exceeded' | 'not_covered';
}

const ceilingCoverage = (
  ceiling: ConsentCeiling | undefined,
  cell: AuthorityCell,
  target: RecordKey | undefined,
  amount: AccessAmount | undefined,
): CeilingCoverage => {
  if (ceiling === undefined) {
    return { covered: true };
  }
  const compatible = ceiling.cells.filter(
    (candidate) =>
      candidate.capabilityKey === cell.capabilityKey &&
      candidate.mode === cell.mode &&
      ceilingCoversSelector(candidate.selector, cell.selector, target),
  );
  if (compatible.length === 0) {
    return { covered: false, reason: 'not_covered' };
  }
  if (amount === undefined && compatible.some((candidate) => candidate.amountCeiling !== undefined)) {
    return { covered: false, reason: 'amount_missing' };
  }
  const covered = compatible.some(
    (candidate) =>
      candidate.amountCeiling === undefined || (amount !== undefined && amountWithin(candidate.amountCeiling, amount)),
  );
  return covered ? { covered: true } : { covered: false, reason: 'amount_exceeded' };
};

const cellPlan = (params: {
  readonly cell: AuthorityCell;
  readonly context: AccessCheckContext | undefined;
  readonly mode: AccessMode;
  readonly purpose: WitnessPurpose;
  readonly scope: ProjectionScope;
  readonly side: HolderSide;
  readonly target?: AccessRecordTarget;
}): PlannedCell => {
  const { cell, context, scope } = params;
  const subject = subjectOf(cell.holder);
  const permission = params.mode === APPROVE_MODE ? 'human_use' : 'use';
  const grantId = grantObjectIdOf(scope, cell);
  const assignmentId = assignmentObjectIdOf(scope, cell);
  const agentSide = params.side === AGENT_SIDE;
  const items: AccessCheckItem[] = [
    // The grant cell itself: its caveat and the role binding it hangs from (with the request context).
    withOptional({ permission, resource: { id: grantId, type: ACCESS_GRANT }, subject }, 'context', context),
    // The exact capability slot carries this exact grant. A relation check, not the slot permission:
    // a permission would aggregate every sibling grant's caveat into one answer and a sibling that
    // cannot be evaluated would decide this cell's outcome instead (M1, md2).
    {
      permission: capabilitySlotRelation(cell),
      resource: { id: capabilityObjectIdOf(scope, cell.capabilityKey), type: ACCESS_CAPABILITY },
      subject: { id: grantId, type: ACCESS_GRANT },
    },
    // The immutable assignment incarnation the witness names is live in this scope.
    { permission: 'eligible', resource: { id: assignmentId, type: ACCESS_ASSIGNMENT }, subject },
    // ... and that exact incarnation is the member of the binding the grant hangs from (O49, D30).
    {
      permission: agentSide ? 'agent_member' : 'member',
      resource: { id: roleBindingObjectIdOf(scope, cell), type: ACCESS_ROLE_BINDING },
      subject: { id: assignmentId, relation: agentSide ? 'agent_holder' : 'holder', type: ACCESS_ASSIGNMENT },
    },
  ];
  // The record object is the owner's projection of that record inside this exact tenant, scope and
  // module (H3, O9, D32). A raw record key never becomes an object ID.
  const recordSelector = recordSelectorOf(cell.selector);
  if (params.target !== undefined && recordSelector !== undefined && recordSelector !== 'all') {
    items.push({
      permission: `${recordSelector}_match`,
      resource: { id: recordObjectIdOf(scope, params.target), type: ACCESS_RECORD },
      subject,
    });
  }
  return { cell, items, purpose: params.purpose, side: params.side };
};

/**
 * `all` is the scope-wide selector and needs no declaration entry; `targets` narrows an explicit
 * set and therefore needs a record-scoped capability; the named selectors must be declared.
 */
const selectorSupported = (policy: DecisionCapabilityPolicy, selector: CellSelector): boolean => {
  const recordSelector = recordSelectorOf(selector);
  return recordSelector === undefined
    ? policy.selectors.length > 0
    : recordSelector === 'all' || policy.selectors.includes(recordSelector);
};

const ceilingReasonOf = (reason: CeilingCoverage['reason']): DecisionReason => {
  if (reason === 'amount_missing') {
    return decisionReason('deny.amount_required');
  }
  return reason === 'amount_exceeded'
    ? decisionReason('deny.amount_exceeds_ceiling')
    : decisionReason('deny.connection_ceiling');
};

interface PlannedCellResult {
  readonly blocker?: DecisionReason;
  readonly planned?: PlannedCell;
}

const planOneCell = (params: {
  readonly amount?: AccessAmount;
  readonly ceiling?: ConsentCeiling;
  readonly cell: AuthorityCell;
  readonly mode: AccessMode;
  readonly now: Date;
  readonly policy: DecisionCapabilityPolicy;
  readonly purpose: WitnessPurpose;
  readonly scope: ProjectionScope;
  readonly side: HolderSide;
  readonly target?: AccessRecordTarget;
}): PlannedCellResult => {
  const { cell } = params;
  if (!selectorSupported(params.policy, cell.selector)) {
    return { blocker: INSUFFICIENT_GRANT };
  }
  if (cell.deadline !== undefined && cell.deadline <= params.now) {
    return { blocker: decisionReason('deny.deadline_passed') };
  }
  const recordSelector = recordSelectorOf(cell.selector);
  if (recordSelector === undefined) {
    if (params.target === undefined) {
      return { blocker: TARGET_REQUIRED };
    }
    if (!new Set(targetKeysOf(cell.selector)).has(params.target.recordKey)) {
      return {};
    }
  } else if (recordSelector !== 'all' && params.target === undefined) {
    return { blocker: TARGET_REQUIRED };
  }
  if (cell.amountCeiling !== undefined && params.amount === undefined) {
    return { blocker: decisionReason('deny.amount_required') };
  }
  if (
    cell.amountCeiling !== undefined &&
    params.amount !== undefined &&
    !amountWithin(cell.amountCeiling, params.amount)
  ) {
    return { blocker: decisionReason('deny.amount_exceeds_ceiling') };
  }
  if (params.side === AGENT_SIDE) {
    const coverage = ceilingCoverage(params.ceiling, cell, params.target?.recordKey, params.amount);
    if (!coverage.covered) {
      return { blocker: ceilingReasonOf(coverage.reason) };
    }
  }
  return {
    planned: cellPlan({
      ...withOptional({}, 'target', params.target),
      cell,
      context: checkContext({
        ...withOptional({}, 'amount', params.amount),
        ...withOptional({}, 'ceiling', cell.amountCeiling),
        selector: cell.selector,
        ...withOptional({}, 'target', params.target?.recordKey),
      }),
      mode: params.mode,
      purpose: params.purpose,
      scope: params.scope,
      side: params.side,
    }),
  };
};

/** Shapes one capability request into requirement items for every side; it never calls the engine. */
const planCapability = (input: PlanCapabilityInput): CapabilityPlan => {
  const blockers: DecisionReason[] = [];
  const sides = input.sides.map(({ cells, holder, side }): PlannedSide => {
    const planned: PlannedCell[] = [];
    for (const cell of cells) {
      const result = planOneCell({
        ...withOptional({}, 'amount', input.amount),
        ...withOptional({}, 'ceiling', input.ceiling),
        cell,
        mode: input.mode,
        now: input.now,
        policy: input.policy,
        purpose: input.purpose,
        scope: input.scope,
        side,
        ...withOptional({}, 'target', input.target),
      });
      if (result.blocker !== undefined) {
        blockers.push(result.blocker);
      }
      if (result.planned !== undefined) {
        planned.push(result.planned);
      }
    }
    return { cells: planned, holder, side };
  });
  return {
    blockers: uniqueReasons(blockers),
    capabilityKey: input.capabilityKey,
    mode: input.mode,
    purpose: input.purpose,
    sides,
  };
};

interface PlanOutcome {
  /** The one cell per side that proves authority; present exactly when the whole plan resolved. */
  readonly cells: readonly PlannedCell[];
  /** The plan needed a side that could not be evaluated, so no safe answer exists (fail closed). */
  readonly indeterminate: boolean;
  readonly plan: CapabilityPlan;
  readonly resolved: boolean;
}

interface PlanEvaluation {
  readonly engineFailed: boolean;
  readonly outcomes: readonly PlanOutcome[];
}

/**
 * One cell's answer. A definitive `none` on any item is `none`: the cell's items are one
 * intersection, and a false item decides it whatever a conditional sibling says. Otherwise a
 * conditional item leaves the cell unknown, and a per-item engine error is an engine failure. Only
 * a cell that answered `has` on every item grants anything (L1, O48b).
 */
const cellVerdict = (
  results: readonly AccessCheckResult[],
  start: number,
  count: number,
): 'error' | 'has' | 'indeterminate' | 'none' => {
  let falseSeen = false;
  let conditionalSeen = false;
  for (let offset = 0; offset < count; offset += 1) {
    const result = results[start + offset];
    if (result === undefined || result.permissionship === 'error') {
      return 'error';
    }
    if (result.permissionship === 'none') {
      falseSeen = true;
    }
    if (result.permissionship === 'conditional') {
      conditionalSeen = true;
    }
  }
  if (falseSeen) {
    return 'none';
  }
  return conditionalSeen ? 'indeterminate' : 'has';
};

const sideVerdictOf = (cells: readonly PlannedCell[], verdicts: ReadonlyMap<PlannedCell, string>) => {
  const answers = new Set(cells.map((cell) => verdicts.get(cell) ?? 'none'));
  if (answers.has('has')) {
    return 'has' as const;
  }
  return answers.has('indeterminate') ? ('indeterminate' as const) : ('none' as const);
};

const evaluatePlans = (plans: readonly CapabilityPlan[], results: readonly AccessCheckResult[]): PlanEvaluation => {
  const cells = plans.flatMap((plan) => plan.sides.flatMap((side) => side.cells));
  const itemCount = cells.reduce((total, cell) => total + cell.items.length, 0);
  if (itemCount !== results.length) {
    // A missing or extra answer is an engine failure, never a denial (L1).
    return { engineFailed: true, outcomes: [] };
  }
  const verdicts = new Map<PlannedCell, string>();
  let cursor = 0;
  for (const cell of cells) {
    const verdict = cellVerdict(results, cursor, cell.items.length);
    if (verdict === 'error') {
      return { engineFailed: true, outcomes: [] };
    }
    verdicts.set(cell, verdict);
    cursor += cell.items.length;
  }
  return {
    engineFailed: false,
    outcomes: plans.map((plan) => {
      const sideVerdicts = plan.sides.map((side) => sideVerdictOf(side.cells, verdicts));
      const chosen = plan.sides.map((side, index) =>
        sideVerdicts[index] === 'has' ? side.cells.find((cell) => verdicts.get(cell) === 'has') : undefined,
      );
      const resolved = sideVerdicts.length > 0 && sideVerdicts.every((verdict) => verdict === 'has');
      return {
        cells: chosen.filter((cell): cell is PlannedCell => cell !== undefined),
        indeterminate: !resolved && sideVerdicts.includes('indeterminate'),
        plan,
        resolved,
      };
    }),
  };
};

const outcomeOf = (evaluation: PlanEvaluation, plan: CapabilityPlan): PlanOutcome | undefined =>
  evaluation.outcomes.find((outcome) => outcome.plan === plan);

const evidenceOf = (cells: readonly PlannedCell[], scopeId: AccessScopeId): readonly GrantedAuthorityEvidence[] =>
  cells.map(({ cell, purpose, side }) =>
    withOptional(
      {
        assignedAt: cell.assignedAt,
        assignedBy: cell.assignedBy,
        mode: cell.mode,
        roleId: cell.roleId,
        roleRevisionId: cell.roleRevisionId,
        selector: selectorTagOf(cell.selector),
        side,
        witness: {
          assignmentIncarnationId: cell.assignmentIncarnationId,
          capabilityKey: cell.capabilityKey,
          grantIncarnationId: cell.grantIncarnationId,
          holderId: cell.holder,
          mode: cell.mode,
          purpose,
          scopeId,
        },
      },
      'deadline',
      cell.deadline,
    ),
  );

/**
 * The record selectors that justified the decision, one per side and selector. They are kept apart
 * per side on purpose: a person's `assigned` and an agent's `all` intersect to `assigned`, so a
 * merged list would let a consumer widen the filter past the intersection (L3, D22).
 */
const selectorsOf = (evidence: readonly GrantedAuthorityEvidence[]): readonly ResolvedRecordSelector[] => {
  const selectors = new Map<string, ResolvedRecordSelector>();
  for (const item of evidence) {
    if (item.witness.purpose === PURPOSE_REQUESTER) {
      selectors.set(`${item.side}:${item.selector}`, { selector: item.selector, side: item.side });
    }
  }
  return [...selectors.values()];
};

const grantedReasons = (evidence: readonly GrantedAuthorityEvidence[]): readonly DecisionReason[] =>
  evidence.map((item) =>
    decisionReason('allow.granted', {
      assignmentIncarnationId: item.witness.assignmentIncarnationId,
      capabilityKey: item.witness.capabilityKey,
      grantIncarnationId: item.witness.grantIncarnationId,
    }),
  );

const actorDeadlines = (resolved: ResolvedActor): readonly Date[] => resolved.deadlines.map(({ until }) => until);

const makeDecision = (params: {
  readonly admissionDeadline?: Date | undefined;
  readonly evidence: readonly GrantedAuthorityEvidence[];
  readonly outcome: AccessDecision['outcome'];
  readonly reasons: readonly DecisionReason[];
  readonly structuralEvidence?: StructuralAuthorityEvidence;
}): AccessDecision => {
  const [first, ...rest] = params.reasons;
  const reasons: Arr.NonEmptyReadonlyArray<DecisionReason> = [first ?? INSUFFICIENT_GRANT, ...rest];
  return withOptional(
    withOptional(
      {
        evidence: params.evidence,
        outcome: params.outcome,
        reasons,
        selectors: params.outcome === 'UNAVAILABLE' ? [] : selectorsOf(params.evidence),
      },
      'structuralEvidence',
      params.structuralEvidence,
    ),
    'admissionDeadline',
    params.admissionDeadline,
  );
};

const deniedDecision = (reasons: readonly DecisionReason[]): AccessDecision =>
  makeDecision({ evidence: [], outcome: 'DENIED', reasons });

const unavailableDecision = (): AccessDecision =>
  makeDecision({
    evidence: [],
    outcome: 'UNAVAILABLE',
    reasons: [decisionReason('unavailable.engine')],
  });

const SENSITIVE_READ_KINDS: ReadonlySet<AccessKind> = new Set(['export', 'field_read', 'read'] as const);

const agentTier = (
  policy: DecisionCapabilityPolicy,
  requestedMode: AccessMode,
): { readonly approvalRequired: boolean } | { readonly reason: DecisionReason } => {
  if (policy.kind === 'admin' || requestedMode === APPROVE_MODE) {
    return { reason: AGENT_FORBIDDEN };
  }
  if (requestedMode === RUN_MODE && policy.risk !== 'routine' && SENSITIVE_READ_KINDS.has(policy.kind)) {
    return { reason: decisionReason('deny.agent_sensitive_read') };
  }
  if (requestedMode === RUN_MODE && policy.risk !== 'routine') {
    if (policy.ephemeral === true) {
      return { reason: AGENT_FORBIDDEN };
    }
    if (!policy.modes.includes(PROPOSE_MODE) || !policy.modes.includes(APPROVE_MODE)) {
      return { reason: MODE_UNSUPPORTED };
    }
    return { approvalRequired: true };
  }
  return { approvalRequired: false };
};

interface EvaluationModes {
  /** The mode whose cells grant the best reachable outcome (run, or propose for an agent). */
  readonly effectiveMode: AccessMode;
  readonly needsApproval: boolean;
  readonly requestedMode: AccessMode;
}

const evaluationModes = (
  resolved: ResolvedActor,
  policy: DecisionCapabilityPolicy,
  requestedMode: AccessMode,
): EvaluationModes | { readonly reason: DecisionReason } => {
  if (!policy.modes.includes(requestedMode)) {
    return { reason: MODE_UNSUPPORTED };
  }
  if (sideOfHolder(resolved.actor) === PRINCIPAL_SIDE) {
    return { effectiveMode: requestedMode, needsApproval: false, requestedMode };
  }
  const tier = agentTier(policy, requestedMode);
  if ('reason' in tier) {
    return tier;
  }
  return {
    effectiveMode: tier.approvalRequired ? 'propose' : requestedMode,
    needsApproval: tier.approvalRequired,
    requestedMode,
  };
};

/**
 * A human running a capability that can also be proposed asks the proposal cells as well, so one
 * snapshot answers both "may this run" and "may this be proposed instead" (O22, O67-Q9).
 */
const offersProposal = (resolved: ResolvedActor, modes: EvaluationModes, request: AccessDecisionRequest): boolean =>
  sideOfHolder(resolved.actor) === PRINCIPAL_SIDE &&
  modes.requestedMode === RUN_MODE &&
  request.capability.modes.includes(PROPOSE_MODE) &&
  request.capability.modes.includes(APPROVE_MODE);

const sidesOf = (resolved: ResolvedActor): readonly HolderSide[] =>
  sideOfHolder(resolved.actor) === PRINCIPAL_SIDE ? [PRINCIPAL_SIDE] : [PRINCIPAL_SIDE, AGENT_SIDE];

const holderFor = (resolved: ResolvedActor, side: HolderSide): Holder =>
  side === AGENT_SIDE ? (resolved.agentHolder ?? resolved.principalHolder) : resolved.principalHolder;

const readRequestCells = (
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  request: AccessDecisionRequest,
  mode: AccessMode,
): Effect.Effect<Option.Option<readonly SideCells[]>> =>
  Effect.option(
    Effect.all(
      sidesOf(resolved).map((side) =>
        readAuthorityCells(authority, resolved, request, mode, side).pipe(
          Effect.map((cells): SideCells => ({ cells, holder: holderFor(resolved, side), side })),
        ),
      ),
      { concurrency: 2 },
    ),
  );

const readParentCells = (
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  parentRead: NonNullable<AccessDecisionRequest['parentRead']>,
  mode: AccessMode,
): Effect.Effect<Option.Option<readonly SideCells[]>> =>
  Effect.option(
    Effect.all(
      sidesOf(resolved).map((side) =>
        readParentReadCells(authority, resolved, parentRead.capability.capabilityKey, side, mode).pipe(
          Effect.map((cells): SideCells => ({ cells, holder: holderFor(resolved, side), side })),
        ),
      ),
      { concurrency: 2 },
    ),
  );

const checkItems = (plans: readonly CapabilityPlan[]): readonly AccessCheckItem[] =>
  plans.flatMap((plan) => plan.sides.flatMap((side) => side.cells.flatMap(({ items }) => items)));

interface SnapshotResult {
  readonly engineFailed: boolean;
  readonly evaluation?: PlanEvaluation;
}

const runSnapshot = (check: DecisionCheckPort, plans: readonly CapabilityPlan[]): Effect.Effect<SnapshotResult> => {
  const items = checkItems(plans);
  if (items.length === 0) {
    return Effect.succeed({ engineFailed: false, evaluation: evaluatePlans(plans, []) });
  }
  return check.checkBulk(items).pipe(
    Effect.option,
    Effect.map((response): SnapshotResult => {
      if (Option.isNone(response)) {
        return { engineFailed: true };
      }
      const evaluation = evaluatePlans(plans, response.value);
      return evaluation.engineFailed ? { engineFailed: true } : { engineFailed: false, evaluation };
    }),
  );
};

export interface DecisionInput {
  readonly actor: ActorContextInput;
  readonly now: Date;
  readonly request: AccessDecisionRequest;
}

const unavailableIntentDecision = (): AccessDecision =>
  makeDecision({ evidence: [], outcome: 'UNAVAILABLE', reasons: [UNAVAILABLE_INTENT] });

/** The person behind a resolved actor, or none for an agent, which never administers (D2). */
const principalIdOf = (actor: ActorContext): Option.Option<PrincipalId> =>
  Match.value(actor).pipe(
    Match.tags({ Agent: () => Option.none<PrincipalId>(), Principal: ({ principalId }) => Option.some(principalId) }),
    Match.exhaustive,
  );

/** The access-admin membership expiry of the company this decision names, if it has one. */
const accessAdminDeadlineOf = (
  deadlines: readonly { readonly legalEntityId: LegalEntityId; readonly until: Date }[] | undefined,
  scope: AccessScope,
): Option.Option<Date> =>
  Match.value(scope).pipe(
    Match.tags({
      LegalEntity: ({ legalEntityId }) =>
        Option.fromNullishOr(
          deadlines?.find((one) => one.legalEntityId === LegalEntityIdSchema.make(legalEntityId))?.until,
        ),
      TenantContext: () => Option.none<Date>(),
    }),
    Match.exhaustive,
  );

/** The exact management path that justified an admin key, for reasons and "Proč?" (O81). */
const structuralEvidenceOf = (
  basis: AccessConfigureBasis,
  resolvedScope: { readonly scope: AccessScope; readonly scopeId: AccessScopeId },
): StructuralAuthorityEvidence =>
  Match.value(basis).pipe(
    Match.tags({
      DelegatedManager: ({ delegation }) => ({
        basis: 'delegation' as const,
        deadline: delegation.validUntil,
        delegationId: delegation.id,
        scopeId: resolvedScope.scopeId,
      }),
      Owner: () => ({ basis: 'owner' as const, scopeId: resolvedScope.scopeId }),
      ScopeAdmin: ({ deadlines }) =>
        withOptional(
          { basis: 'access_admin' as const, scopeId: resolvedScope.scopeId },
          'deadline',
          Option.getOrUndefined(accessAdminDeadlineOf(deadlines, resolvedScope.scope)),
        ),
    }),
    Match.exhaustive,
  );

/** Whether this decision runs in the tenant context, the one context a surface is entered from (O88). */
const isTenantContextScope = (scope: AccessScope): boolean =>
  Match.value(scope).pipe(Match.tags({ LegalEntity: () => false, TenantContext: () => true }), Match.exhaustive);

/** One company an access administrator administers, with the end of that exact membership. */
interface SurfaceAdminCompany {
  readonly deadline?: Date;
  readonly legalEntityId: LegalEntityId;
}

/** The companies of one access-admin membership whose own end date has not arrived yet. */
const liveAdminCompanies = (
  legalEntityIds: readonly LegalEntityId[],
  deadlines: readonly { readonly legalEntityId: LegalEntityId; readonly until: Date }[] | undefined,
  at: Date,
): readonly SurfaceAdminCompany[] => {
  const ends = new Map((deadlines ?? []).map((one) => [one.legalEntityId, one.until] as const));
  const live: SurfaceAdminCompany[] = [];
  for (const legalEntityId of legalEntityIds) {
    const deadline = ends.get(legalEntityId);
    if (deadline === undefined || at < deadline) {
      live.push(withOptional({ legalEntityId }, 'deadline', deadline));
    }
  }
  return live;
};

/** Only a company access-admin basis names companies; an owner or a delegation is a wider path. */
const companiesOfBasis = (basis: AccessConfigureBasis, at: Date): readonly SurfaceAdminCompany[] =>
  Match.value(basis).pipe(
    Match.tags({
      DelegatedManager: (): readonly SurfaceAdminCompany[] => [],
      Owner: (): readonly SurfaceAdminCompany[] => [],
      ScopeAdmin: ({ deadlines, legalEntityIds }) => liveAdminCompanies(legalEntityIds, deadlines, at),
    }),
    Match.exhaustive,
  );

/**
 * The companies whose live `access_admin` membership lets a person enter the administration SURFACE
 * (O88), or none when this question is not a surface question at all.
 *
 * The admission is deliberately narrower than a management basis: it needs the declaration's own
 * surface marker (so no caller flag, key prefix, display name or selected company can stand in for
 * it), the tenant context (a company's data and roles are decided in that company's scope, never
 * here), and at least one company whose access-admin membership is still live at this instant.
 */
const surfaceAdminCompaniesOf = (
  bases: readonly AccessConfigureBasis[],
  capability: DecisionCapabilityPolicy,
  scope: AccessScope,
  at: Date,
): readonly SurfaceAdminCompany[] =>
  capability.admitsAdminSurface === true && isTenantContextScope(scope)
    ? bases.flatMap((basis) => companiesOfBasis(basis, at))
    : [];

/**
 * The surface admission itself: a live company administrator entering the administration surface in
 * the tenant context, with no tenant-wide power of any kind (O88). The end date is the earliest end
 * among the memberships that make the person eligible, so the answer is never valid longer than the
 * narrowest path behind it.
 */
const adminSurfaceAnyDecision = (
  bases: readonly AccessConfigureBasis[],
  resolved: ResolvedActor,
  request: AccessDecisionRequest,
  now: Date,
): Option.Option<AccessDecision> => {
  const companies = surfaceAdminCompaniesOf(bases, request.capability, resolved.scope.scope, now);
  if (companies.length === 0) {
    return Option.none<AccessDecision>();
  }
  const structuralEvidence: StructuralAuthorityEvidence = withOptional(
    { basis: 'access_admin_any' as const, scopeId: resolved.scope.scopeId },
    'deadline',
    earliestDeadline(companies.map(({ deadline }) => deadline)),
  );
  return Option.some(
    makeDecision({
      admissionDeadline: earliestDeadline([...actorDeadlines(resolved), structuralEvidence.deadline]),
      evidence: [],
      outcome: 'ALLOWED',
      reasons: [decisionReason('structural.access_admin_any')],
      structuralEvidence,
    }),
  );
};

/** A structural admin path is an independent branch of this same gate, never a role cell (O81). */
const structuralAdminDecision = Effect.fn('AccessDecision.structuralAdmin')(function* structuralAdminProgram(
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  request: AccessDecisionRequest,
  now: Date,
) {
  const actor = principalIdOf(resolved.actor);
  if (request.capability.kind !== 'admin' || Option.isNone(actor)) {
    return Option.none<AccessDecision>();
  }
  // A missing or failed source of configure intent is UNAVAILABLE, not an empty set of bases. Even
  // a role cell cannot turn an unreadable authority source into a positive answer.
  if (authority.readConfigureBases === undefined) {
    return Option.some(unavailableIntentDecision());
  }
  const bases = yield* Effect.option(
    authority.readConfigureBases({ actor: actor.value, at: now, tenantId: resolved.scope.tenantId }),
  );
  if (Option.isNone(bases)) {
    return Option.some(unavailableIntentDecision());
  }
  const basis = configureBasisFor(
    bases.value,
    { id: resolved.scope.scopeId, scope: resolved.scope.scope },
    request.capability.capabilityKey,
    now,
  );
  if (basis === undefined) {
    // Nothing in this scope manages this key. Only a marked administration SURFACE still admits here,
    // and only through the narrow `access_admin_any` path; every operation keeps the exact basis (O88).
    return adminSurfaceAnyDecision(bases.value, resolved, request, now);
  }
  const structuralEvidence = structuralEvidenceOf(basis, resolved.scope);
  const code = `structural.${structuralEvidence.basis}` as const;
  return Option.some(
    makeDecision({
      admissionDeadline: earliestDeadline([...actorDeadlines(resolved), structuralEvidence.deadline]),
      evidence: [],
      outcome: 'ALLOWED',
      reasons: [decisionReason(code)],
      structuralEvidence,
    }),
  );
});

interface DecisionGuard {
  readonly decision?: AccessDecision;
  readonly modes?: EvaluationModes;
  readonly parentRead?: NonNullable<AccessDecisionRequest['parentRead']>;
}

/**
 * Field access rides the parent record it belongs to: a field read or write, and anything that names
 * a field class, is decided only together with the parent read (D7a-e, §C step 6). The parent read is
 * the containing declaration's own capability: one record on a record-scoped entrypoint, and the same
 * scope-wide capability when the entrypoint is not record-scoped (O74).
 */
const needsParentRead = (capability: DecisionCapabilityPolicy): boolean =>
  capability.fieldClass !== undefined || capability.kind === 'field_read' || capability.kind === 'field_write';

/** A written field is part of the owning command in its effective mode, never a second RUN. */
const parentModeOf = (request: AccessDecisionRequest, modes: EvaluationModes): AccessMode =>
  request.capability.kind === 'field_write' ? modes.effectiveMode : RUN_MODE;

const guardRequest = (resolved: ResolvedActor, request: AccessDecisionRequest): DecisionGuard => {
  const modes = evaluationModes(resolved, request.capability, request.mode);
  if ('reason' in modes) {
    return { decision: deniedDecision([modes.reason]) };
  }
  const { capability, parentRead, target } = request;
  if (capability.selectors.length > 0 && target === undefined) {
    return { decision: deniedDecision([TARGET_REQUIRED]) };
  }
  if (needsParentRead(capability) && parentRead === undefined) {
    return { decision: deniedDecision([PARENT_READ_REQUIRED]) };
  }
  // The parent read is the request's own record; a parent read of some other record proves nothing.
  // A scope-wide parent capability names no record (O74): it is decided scope-wide in this same
  // scope, and a record-scoped parent capability that names none proves nothing either.
  if (
    parentRead !== undefined &&
    (parentRead.target === undefined
      ? parentRead.capability.selectors.length > 0
      : target === undefined || !sameRecord(parentRead.target, target))
  ) {
    return { decision: deniedDecision([PARENT_READ_REQUIRED]) };
  }
  if (parentRead === undefined) {
    return { modes };
  }
  const parentMode = parentModeOf(request, modes);
  if (!parentRead.capability.modes.includes(parentMode)) {
    return { decision: deniedDecision([MODE_UNSUPPORTED]) };
  }
  if (sideOfHolder(resolved.actor) === AGENT_SIDE) {
    const parentTier = agentTier(parentRead.capability, parentMode);
    if ('reason' in parentTier) {
      return { decision: deniedDecision([parentTier.reason]) };
    }
  }
  return { modes, parentRead };
};

interface ReadInputs {
  readonly approvalSides?: readonly SideCells[];
  readonly capabilitySides: readonly SideCells[];
  readonly parentSides: readonly SideCells[];
}

const readInputs: (
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  request: AccessDecisionRequest,
  modes: EvaluationModes,
  parentRead: NonNullable<AccessDecisionRequest['parentRead']> | undefined,
) => Effect.Effect<Option.Option<ReadInputs>> = Effect.fn('AccessDecision.readInputs')(function* readInputsProgram(
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  request: AccessDecisionRequest,
  modes: EvaluationModes,
  parentRead: NonNullable<AccessDecisionRequest['parentRead']> | undefined,
) {
  const capabilitySides = Option.getOrUndefined(
    yield* readRequestCells(authority, resolved, request, modes.effectiveMode),
  );
  if (capabilitySides === undefined) {
    return Option.none<ReadInputs>();
  }
  const parentSides =
    parentRead === undefined
      ? []
      : Option.getOrUndefined(yield* readParentCells(authority, resolved, parentRead, parentModeOf(request, modes)));
  if (parentSides === undefined) {
    return Option.none<ReadInputs>();
  }
  const offerProposal = offersProposal(resolved, modes, request);
  const approvalSides = offerProposal
    ? Option.getOrUndefined(yield* readRequestCells(authority, resolved, request, PROPOSE_MODE))
    : undefined;
  if (offerProposal && approvalSides === undefined) {
    return Option.none<ReadInputs>();
  }
  return Option.some(withOptional({ capabilitySides, parentSides }, 'approvalSides', approvalSides));
});

interface RequestPlans {
  readonly approval?: CapabilityPlan;
  readonly capability: CapabilityPlan;
  readonly parent?: CapabilityPlan;
}

const plansOf = (params: {
  readonly inputs: ReadInputs;
  readonly modes: EvaluationModes;
  readonly now: Date;
  readonly parentRead: NonNullable<AccessDecisionRequest['parentRead']> | undefined;
  readonly request: AccessDecisionRequest;
  readonly resolved: ResolvedActor;
}): RequestPlans => {
  const { inputs, modes, now, parentRead, request, resolved } = params;
  const scope = projectionScopeOf(resolved.scope);
  const basePlan = {
    ...withOptional({}, 'amount', request.amount),
    capabilityKey: request.capability.capabilityKey,
    ...withOptional({}, 'ceiling', resolved.consentCeiling),
    now,
    policy: request.capability,
    purpose: PURPOSE_REQUESTER,
    scope,
    ...withOptional({}, 'target', request.target),
  };
  const capability = planCapability({ ...basePlan, mode: modes.effectiveMode, sides: inputs.capabilitySides });
  const approval =
    inputs.approvalSides === undefined
      ? undefined
      : planCapability({ ...basePlan, mode: PROPOSE_MODE, sides: inputs.approvalSides });
  const parent =
    parentRead === undefined
      ? undefined
      : planCapability({
          ...withOptional({}, 'amount', parentRead.amount),
          ...withOptional(withOptional({}, 'ceiling', resolved.consentCeiling), 'target', parentRead.target),
          capabilityKey: parentRead.capability.capabilityKey,
          mode: parentModeOf(request, modes),
          now,
          policy: parentRead.capability,
          purpose: PURPOSE_PARENT,
          scope,
          sides: inputs.parentSides,
        });
  return withOptional(withOptional({ capability }, 'approval', approval), 'parent', parent);
};

const planList = (plans: RequestPlans): readonly CapabilityPlan[] => [
  plans.capability,
  ...(plans.approval === undefined ? [] : [plans.approval]),
  ...(plans.parent === undefined ? [] : [plans.parent]),
];

const parentEvidenceOf = (evaluation: PlanEvaluation, plans: RequestPlans): readonly PlannedCell[] | undefined => {
  if (plans.parent === undefined) {
    return [];
  }
  const outcome = outcomeOf(evaluation, plans.parent);
  return outcome?.resolved === true ? outcome.cells : undefined;
};

/** A refused parent read reports why it was refused, not only that the record read is unproven. */
const parentRefusalReasons = (evaluation: PlanEvaluation, plans: RequestPlans): readonly DecisionReason[] => {
  const indeterminate = plans.parent !== undefined && outcomeOf(evaluation, plans.parent)?.indeterminate === true;
  return indeterminate ? [CAVEAT_INDETERMINATE] : [...(plans.parent?.blockers ?? []), PARENT_READ_REQUIRED];
};

/** Fail closed when a side that would have decided the answer could not be evaluated (O48b). */
const indeterminateReasons = (outcomes: readonly (PlanOutcome | undefined)[]): readonly DecisionReason[] | undefined =>
  outcomes.some((outcome) => outcome?.indeterminate === true) ? [CAVEAT_INDETERMINATE] : undefined;

const decisionFromSnapshot = (params: {
  readonly evaluation: PlanEvaluation;
  readonly modes: EvaluationModes;
  readonly plans: RequestPlans;
  readonly request: AccessDecisionRequest;
  readonly resolved: ResolvedActor;
}): AccessDecision => {
  const { evaluation, modes, plans, request, resolved } = params;
  const parentEvidence = parentEvidenceOf(evaluation, plans);
  if (parentEvidence === undefined) {
    return deniedDecision(uniqueReasons(parentRefusalReasons(evaluation, plans)));
  }
  const capabilityOutcome = outcomeOf(evaluation, plans.capability);
  const approvalOutcome = plans.approval === undefined ? undefined : outcomeOf(evaluation, plans.approval);
  const succeeded = [capabilityOutcome, approvalOutcome].find((outcome) => outcome?.resolved === true);
  if (succeeded === undefined) {
    const indeterminate = indeterminateReasons([capabilityOutcome, approvalOutcome]);
    return indeterminate === undefined
      ? deniedDecision(
          uniqueReasons([...plans.capability.blockers, ...(plans.approval?.blockers ?? []), INSUFFICIENT_GRANT]),
        )
      : deniedDecision(indeterminate);
  }
  const agentSensitiveRun =
    sideOfHolder(resolved.actor) === AGENT_SIDE &&
    modes.requestedMode === RUN_MODE &&
    request.capability.risk !== 'routine';
  const needsApproval = succeeded !== capabilityOutcome || modes.needsApproval || agentSensitiveRun;
  const evidence = [...succeeded.cells, ...parentEvidence];
  return makeDecision({
    admissionDeadline: earliestDeadline([...actorDeadlines(resolved), ...evidence.map(({ cell }) => cell.deadline)]),
    evidence: evidenceOf(evidence, resolved.scope.scopeId),
    outcome: needsApproval ? 'NEEDS_APPROVAL' : 'ALLOWED',
    reasons: needsApproval
      ? [decisionReason('approval.required'), ...grantedReasons(evidenceOf(succeeded.cells, resolved.scope.scopeId))]
      : grantedReasons(evidenceOf(succeeded.cells, resolved.scope.scopeId)),
  });
};

const decideAccessEffect: (
  authority: DecisionAuthorityPort,
  check: DecisionCheckPort,
  input: DecisionInput,
) => Effect.Effect<AccessDecision> = Effect.fn('AccessDecision.decide')(function* decideAccessProgram(
  authority: DecisionAuthorityPort,
  check: DecisionCheckPort,
  input: DecisionInput,
) {
  const { actor, now, request } = input;
  const resolution = yield* resolveActorContext(authority, actor, now);
  if (resolution.unavailable !== undefined || resolution.resolved === undefined) {
    if (resolution.refusal !== undefined) {
      return deniedDecision(resolution.refusal);
    }
    return unavailableIntentDecision();
  }
  const { resolved } = resolution;
  const guard = guardRequest(resolved, request);
  if (guard.decision !== undefined) {
    return guard.decision;
  }
  if (guard.modes === undefined) {
    return deniedDecision([INSUFFICIENT_GRANT]);
  }
  const structural = yield* structuralAdminDecision(authority, resolved, request, now);
  if (Option.isSome(structural)) {
    return structural.value;
  }
  const inputs = Option.getOrUndefined(yield* readInputs(authority, resolved, request, guard.modes, guard.parentRead));
  if (inputs === undefined) {
    return unavailableIntentDecision();
  }
  const plans = plansOf({
    inputs,
    modes: guard.modes,
    now,
    parentRead: guard.parentRead,
    request,
    resolved,
  });
  const { engineFailed, evaluation } = yield* runSnapshot(check, planList(plans));
  // A per-item engine error or a missing answer is an unavailable engine, never a denial (L1).
  if (engineFailed || evaluation === undefined) {
    return unavailableDecision();
  }
  return decisionFromSnapshot({ evaluation, modes: guard.modes, plans, request, resolved });
});

/**
 * The single decision function (D22). Every path asks the same question: the person's authority
 * intersected with the agent's authority and the connection ceiling, resolved from one
 * `CheckBulkPermissions` snapshot. Only an engine/transport failure is UNAVAILABLE, never a denial.
 */
export const decideAccess = decideAccessEffect;

/**
 * Many decisions against one engine snapshot (CUTOVER-PLAN §5.3 risk 6). A navigation page asks
 * about dozens of declarations for one actor: the intent of each distinct holder and scope is
 * resolved once, the cells of each distinct capability, mode and side are read once, and every
 * request's requirement items travel in ONE `CheckBulkPermissions` request. Each answer is exactly
 * the answer `decideAccess` gives for that request on its own — the batch plans the same items and
 * applies the same verdict rules, it only shares the reads and the snapshot.
 */
export interface DecisionBatchGroup {
  /** The intent port of one trusted request scope; the engine never carries one itself (O66). */
  readonly authority: DecisionAuthorityPort;
  readonly inputs: readonly DecisionInput[];
}

/** One request that still needs the snapshot, with everything the verdict needs afterwards. */
interface SnapshotRequest {
  readonly modes: EvaluationModes;
  readonly plans: RequestPlans;
  readonly request: AccessDecisionRequest;
  readonly resolved: ResolvedActor;
}

interface PlannedGroupEntry {
  /** The answer that needed no engine item: a guard refusal or unreadable intent. */
  readonly decision?: AccessDecision;
  readonly snapshot?: SnapshotRequest;
}

const actorIdentityOf = (actor: ActorContext): string =>
  Match.value(actor).pipe(
    Match.tags({
      Agent: ({ agentId, connectionId, consentRevision, principalId }): string =>
        ['agent', agentId, connectionId, String(consentRevision), principalId].join('\u0000'),
      Principal: ({ principalId }): string => ['principal', principalId].join('\u0000'),
    }),
    Match.exhaustive,
  );

/** Total identity of one actor in one scope at one decision time; a different one is another read. */
const actorResolutionKey = (input: DecisionInput): string =>
  [
    actorIdentityOf(input.actor.actor),
    input.actor.tenantId,
    input.actor.legalEntityId ?? '',
    DateTime.toEpochMillis(DateTime.makeUnsafe(input.now)),
  ].join('\u0000');

/** The one intent query a side needs for one capability and mode. */
const cellQueryOf = (params: {
  readonly capabilityKey: CapabilityKey;
  readonly mode: AccessMode;
  readonly resolved: ResolvedActor;
  readonly side: HolderSide;
}): AuthorityCellQuery | undefined => {
  const holder = params.side === AGENT_SIDE ? params.resolved.agentHolder : params.resolved.principalHolder;
  return holder === undefined
    ? undefined
    : {
        capabilityKey: params.capabilityKey,
        holder,
        mode: params.mode,
        scopeId: params.resolved.scope.scopeId,
        tenantId: params.resolved.scope.tenantId,
      };
};

/** One cell set per holder, capability and mode, whatever request or side asked for it. */
const cellQueryKey = (query: AuthorityCellQuery): string =>
  [holderIdOf(query.holder), query.capabilityKey, query.mode].join('\u0000');

/** The cell sets one request needs, so the whole batch reads each of them exactly once. */
const requiredCellQueries = (params: {
  readonly modes: EvaluationModes;
  readonly parentRead: NonNullable<AccessDecisionRequest['parentRead']> | undefined;
  readonly request: AccessDecisionRequest;
  readonly resolved: ResolvedActor;
}): readonly AuthorityCellQuery[] => {
  const { modes, parentRead, request, resolved } = params;
  const queries: AuthorityCellQuery[] = [];
  for (const side of sidesOf(resolved)) {
    const capability = cellQueryOf({
      capabilityKey: request.capability.capabilityKey,
      mode: modes.effectiveMode,
      resolved,
      side,
    });
    if (capability !== undefined) {
      queries.push(capability);
    }
    if (offersProposal(resolved, modes, request)) {
      const approval = cellQueryOf({
        capabilityKey: request.capability.capabilityKey,
        mode: PROPOSE_MODE,
        resolved,
        side,
      });
      if (approval !== undefined) {
        queries.push(approval);
      }
    }
    if (parentRead !== undefined) {
      const parent = cellQueryOf({
        capabilityKey: parentRead.capability.capabilityKey,
        mode: parentModeOf(request, modes),
        resolved,
        side,
      });
      if (parent !== undefined) {
        queries.push(parent);
      }
    }
  }
  return queries;
};

/** The cell sets one guarded request needs. */
const cellQueriesOf = (entry: GuardedRequest): readonly AuthorityCellQuery[] =>
  requiredCellQueries({
    modes: entry.modes,
    parentRead: entry.parentRead,
    request: entry.request,
    resolved: entry.resolved,
  });

/** Pooled reads one batch runs at once; each holds one connection of the request's shared pool. */
const BATCH_READ_CONCURRENCY = 2;

/** A read cell set, or an intent read that failed: the latter is UNAVAILABLE, never empty intent. */
type CellRead = { readonly cells: readonly AuthorityCell[] } | { readonly unreadable: true };

/** Whether a read cell set is there and readable. */
const isReadable = (read: CellRead | undefined): boolean => read !== undefined && 'cells' in read;

const readCellSets = Effect.fn('AccessDecision.readCellSets')(function* readCellSetsProgram(
  authority: DecisionAuthorityPort,
  queries: readonly AuthorityCellQuery[],
) {
  const distinct = new Map<string, AuthorityCellQuery>();
  for (const query of queries) {
    distinct.set(cellQueryKey(query), query);
  }
  const entries = [...distinct.entries()];
  const readMany = authority.readCellsMany;
  // One read for the whole batch when the port offers it; otherwise each read is one pooled transaction, two at a
  // time, so one batch never holds more of a small shared pool. A failed read leaves its sets unreadable.
  let reads: readonly (Option.Option<readonly AuthorityCell[]> | undefined)[] = [];
  if (readMany === undefined) {
    reads = yield* Effect.forEach(entries, ([, query]) => Effect.option(authority.readCells(query)), {
      concurrency: BATCH_READ_CONCURRENCY,
    });
  } else if (entries.length > 0) {
    reads = yield* readMany(entries.map(([, query]) => query)).pipe(
      Effect.map((answers) => (answers.length === entries.length ? answers.map((cells) => Option.some(cells)) : [])),
      Effect.orElseSucceed(() => []),
    );
  }
  const cells = new Map<string, CellRead>();
  for (const [index, [key]] of entries.entries()) {
    const read = reads[index];
    cells.set(key, read === undefined || Option.isNone(read) ? { unreadable: true } : { cells: read.value });
  }
  return cells;
});

/** Keeps a batch's one configure-bases answer for the rest of that batch, then answers with it. */
const rememberedAnswer = <Answer>(answered: Map<string, Answer>, key: string, once: Answer): Answer => {
  answered.set(key, once);
  return once;
};

/**
 * The same port, answering one configure-bases question once per batch: every `admin` entry of one actor asks the
 * same actor, tenant and instant, so the first read is shared with the rest of this batch and never with another.
 */
const sharedConfigureBases = (authority: DecisionAuthorityPort): DecisionAuthorityPort => {
  const read = authority.readConfigureBases;
  if (read === undefined) {
    return authority;
  }
  const answered = new Map<string, ReturnType<typeof read>>();
  return {
    ...authority,
    readConfigureBases: (query) =>
      Effect.suspend(() => {
        const key = [query.tenantId, query.actor, String(DateTime.toEpochMillis(DateTime.makeUnsafe(query.at)))].join(
          '\u0000',
        );
        const known = answered.get(key);
        if (known !== undefined) {
          return known;
        }
        return Effect.cached(read(query)).pipe(Effect.flatMap((once) => rememberedAnswer(answered, key, once)));
      }),
  };
};

/** The same port with every needed cell set already in hand: planning performs no read. */
const preloadedAuthority = (
  authority: DecisionAuthorityPort,
  cells: ReadonlyMap<string, CellRead>,
): DecisionAuthorityPort => ({
  readCells: (query) => {
    const read = cells.get(cellQueryKey(query));
    if (read === undefined) {
      return Effect.fail(accessDecisionUnavailable('The access intent of this request was not read'));
    }
    return 'cells' in read
      ? Effect.succeed(read.cells)
      : Effect.fail(accessDecisionUnavailable('The access intent of this request could not be read'));
  },
  readConnection: authority.readConnection,
  readScope: authority.readScope,
  readTeamIds: authority.readTeamIds,
  ...withOptional({}, 'readConfigureBases', authority.readConfigureBases),
});

interface GuardedRequest {
  readonly index: number;
  readonly modes: EvaluationModes;
  readonly now: Date;
  readonly parentRead: NonNullable<AccessDecisionRequest['parentRead']> | undefined;
  readonly request: AccessDecisionRequest;
  readonly resolved: ResolvedActor;
}

interface PlannedRequest {
  readonly decision?: AccessDecision;
  readonly index: number;
  readonly plans: readonly CapabilityPlan[];
  readonly snapshot?: SnapshotRequest;
}

const planRequest = Effect.fn('AccessDecision.planRequest')(function* planRequestProgram(
  authority: DecisionAuthorityPort,
  entry: GuardedRequest,
) {
  const inputs = Option.getOrUndefined(
    yield* readInputs(authority, entry.resolved, entry.request, entry.modes, entry.parentRead),
  );
  if (inputs === undefined) {
    return { decision: unavailableIntentDecision(), index: entry.index, plans: [] };
  }
  const plans = plansOf({
    inputs,
    modes: entry.modes,
    now: entry.now,
    parentRead: entry.parentRead,
    request: entry.request,
    resolved: entry.resolved,
  });
  return {
    index: entry.index,
    plans: planList(plans),
    snapshot: { modes: entry.modes, plans, request: entry.request, resolved: entry.resolved },
  };
});

/** One request before the engine: either the answer it already has, or what the batch must plan. */
interface PreparedRequest {
  readonly decision?: AccessDecision;
  readonly guarded?: GuardedRequest;
}

/**
 * The guard of one request: a refusal it answers on its own, or the guarded request whose items the
 * batch still has to plan. Every rule here is the rule `decideAccess` applies to a single request.
 */
const guardEntry = (params: {
  readonly index: number;
  readonly input: DecisionInput;
  readonly resolution: ActorResolution | undefined;
}): PreparedRequest => {
  const { index, input, resolution } = params;
  if (resolution === undefined || resolution.unavailable !== undefined || resolution.resolved === undefined) {
    return {
      decision: resolution?.refusal === undefined ? unavailableIntentDecision() : deniedDecision(resolution.refusal),
    };
  }
  const { resolved } = resolution;
  const guard = guardRequest(resolved, input.request);
  if (guard.decision !== undefined) {
    return { decision: guard.decision };
  }
  if (guard.modes === undefined) {
    return { decision: deniedDecision([INSUFFICIENT_GRANT]) };
  }
  return {
    guarded: {
      index,
      modes: guard.modes,
      now: input.now,
      parentRead: guard.parentRead,
      request: input.request,
      resolved,
    },
  };
};

/**
 * One group's requests, planned without the engine: the actor resolution, the guards and every
 * intent read happen here, once per distinct actor, scope, capability, mode and side.
 */
const planGroup = Effect.fn('AccessDecision.planGroup')(function* planGroupProgram(group: DecisionBatchGroup) {
  const { authority, inputs } = group;
  const distinctActors = new Map<string, { readonly actor: ActorContextInput; readonly now: Date }>();
  for (const input of inputs) {
    distinctActors.set(actorResolutionKey(input), { actor: input.actor, now: input.now });
  }
  const actorEntries = [...distinctActors.entries()];
  const resolutions = yield* Effect.forEach(
    actorEntries,
    ([, { actor, now }]) => resolveActorContext(authority, actor, now),
    { concurrency: BATCH_READ_CONCURRENCY },
  );
  const resolutionByKey = new Map<string, ActorResolution>();
  for (const [index, [key]] of actorEntries.entries()) {
    const resolution = resolutions[index];
    if (resolution !== undefined) {
      resolutionByKey.set(key, resolution);
    }
  }
  const prepared = inputs.map((input, index) =>
    guardEntry({ index, input, resolution: resolutionByKey.get(actorResolutionKey(input)) }),
  );
  const guarded = prepared.flatMap(({ guarded: entry }) => (entry === undefined ? [] : [entry]));
  // One after another over a shared answer: only the first `admin` entry of an actor reads its configure bases.
  const structuralAuthority = sharedConfigureBases(authority);
  // The structural answers and the cell sets are independent reads, so they overlap. Cell sets are read ahead for
  // every guarded request; a request the structural check decides simply leaves its sets unused (no decision, no
  // row). That read ahead is speculative: its failure or defect is kept, never raised, and decides nothing below.
  const [structural, ahead] = yield* Effect.all(
    [
      Effect.forEach(
        guarded,
        (entry) => structuralAdminDecision(structuralAuthority, entry.resolved, entry.request, entry.now),
        { concurrency: 1 },
      ),
      readCellSets(authority, guarded.flatMap(cellQueriesOf)).pipe(Effect.exit),
    ],
    { concurrency: BATCH_READ_CONCURRENCY },
  );
  const structuralByIndex = new Map<number, AccessDecision>(
    guarded.flatMap((entry, index) =>
      Option.match(structural[index] ?? Option.none<AccessDecision>(), {
        onNone: () => [],
        onSome: (decision) => [[entry.index, decision] as const],
      }),
    ),
  );
  const roleGuarded = guarded.filter((entry) => !structuralByIndex.has(entry.index));
  // The structural answers are authoritative. The cell sets the remaining requests need come from the read ahead
  // when it read every one of them; otherwise exactly those sets are read now, as when nothing was read ahead.
  const needed = roleGuarded.flatMap(cellQueriesOf);
  const cellSets =
    Exit.isSuccess(ahead) && needed.every((query) => isReadable(ahead.value.get(cellQueryKey(query))))
      ? ahead.value
      : yield* readCellSets(authority, needed);
  const preloaded = preloadedAuthority(authority, cellSets);
  const planned = yield* Effect.forEach(roleGuarded, (entry) => planRequest(preloaded, entry), {
    concurrency: BATCH_READ_CONCURRENCY,
  });
  const plannedByIndex = new Map<number, PlannedRequest>();
  for (const result of planned) {
    plannedByIndex.set(result.index, result);
  }
  const entries = prepared.map((entry, index): PlannedGroupEntry => {
    if (entry.decision !== undefined) {
      return { decision: entry.decision };
    }
    const structuralDecision = structuralByIndex.get(index);
    if (structuralDecision !== undefined) {
      return { decision: structuralDecision };
    }
    const snapshot = plannedByIndex.get(index)?.snapshot;
    return snapshot === undefined ? { decision: unavailableIntentDecision() } : { snapshot };
  });
  return { entries, plans: planned.flatMap((result) => result.plans) };
});

const decideAccessManyEffect: (
  check: DecisionCheckPort,
  groups: readonly DecisionBatchGroup[],
) => Effect.Effect<readonly (readonly AccessDecision[])[]> = Effect.fn('AccessDecision.decideMany')(
  function* decideAccessManyProgram(check: DecisionCheckPort, groups: readonly DecisionBatchGroup[]) {
    const plannedGroups = yield* Effect.forEach(groups, (group) => planGroup(group), {
      concurrency: BATCH_READ_CONCURRENCY,
    });
    // ONE snapshot for every request's items: a batch can never be answered from two views.
    const { engineFailed, evaluation } = yield* runSnapshot(
      check,
      plannedGroups.flatMap(({ plans }) => plans),
    );
    return plannedGroups.map(({ entries }) =>
      entries.map((entry): AccessDecision => {
        if (entry.decision !== undefined) {
          return entry.decision;
        }
        if (engineFailed || evaluation === undefined || entry.snapshot === undefined) {
          return unavailableDecision();
        }
        return decisionFromSnapshot({
          evaluation,
          modes: entry.snapshot.modes,
          plans: entry.snapshot.plans,
          request: entry.snapshot.request,
          resolved: entry.snapshot.resolved,
        });
      }),
    );
  },
);

/**
 * Many protected requests, one engine snapshot. The answers are per group, in request order, and
 * each one is the answer `decideAccess` would have given for that request alone.
 */
export const decideAccessMany = decideAccessManyEffect;

export interface ListDecisionInput {
  readonly actor: ActorContextInput;
  readonly capability: DecisionCapabilityPolicy;
  readonly mode: AccessMode;
  readonly now: Date;
}

export interface ListAccessResolution {
  readonly decision: AccessDecision;
  /** Absent exactly when the caller must return no rows; present for ALLOWED and NEEDS_APPROVAL. */
  readonly predicate?: ListAccessPredicate;
}

/** The narrower of two ceilings, or `mismatch` when no amount can satisfy both currencies. */
const narrowerCeiling = (
  first: AmountCeiling | undefined,
  second: AmountCeiling | undefined,
): AmountCeiling | 'mismatch' | undefined => {
  if (first === undefined || second === undefined) {
    return first ?? second;
  }
  if (first.currency !== second.currency) {
    return 'mismatch';
  }
  return first.limitMinor <= second.limitMinor ? first : second;
};

/** The explicit records a consent cell narrows the list to; record selectors narrow by their own clause. */
const consentRecordKeys = (consent: Cell): Arr.NonEmptyReadonlyArray<RecordKey> | undefined =>
  Option.getOrUndefined(
    Match.value(consent.selector).pipe(
      Match.tag('targets', ({ recordKeys }) => recordKeys),
      Match.option,
    ),
  );

/**
 * The amount bounds one consent cell admits a grant cell under. A consent cell keeps its own
 * ceiling: collapsing several cells into the widest amount would pair one cell's amount with
 * another cell's selector. An unbounded consent cell whose compatible sibling carries a ceiling
 * is held to that sibling's ceilings, because the single decision refuses a record with no amount
 * when any covering consent cell is capped; the list may show fewer rows here, never more.
 */
const consentBounds = (
  grantCeiling: AmountCeiling | undefined,
  consent: Cell,
  compatible: readonly Cell[],
): readonly (AmountCeiling | undefined)[] => {
  const own = narrowerCeiling(grantCeiling, consent.amountCeiling);
  if (own === 'mismatch') {
    return [];
  }
  if (own !== undefined) {
    return [own];
  }
  const siblingCeilings = compatible.flatMap(({ amountCeiling }) =>
    amountCeiling === undefined ? [] : [amountCeiling],
  );
  return siblingCeilings.length === 0 ? [undefined] : siblingCeilings;
};

const listCellOf = (params: {
  readonly ceiling: ConsentCeiling | undefined;
  readonly cell: AuthorityCell;
  readonly holder: Holder;
  readonly now: Date;
  readonly policy: DecisionCapabilityPolicy;
  readonly side: HolderSide;
  readonly teamIds: readonly AccessTeamId[];
}): readonly ListAuthorityCell[] => {
  const { cell } = params;
  if (!selectorSupported(params.policy, cell.selector)) {
    return [];
  }
  if (cell.deadline !== undefined && cell.deadline <= params.now) {
    return [];
  }
  // A team cell for a holder in no team can never match a row (B1); drop it instead of letting an
  // empty team set collapse into an unconstrained clause.
  if (recordSelectorOf(cell.selector) === 'team' && params.teamIds.length === 0) {
    return [];
  }
  const base = { cell, holder: params.holder, teamIds: params.teamIds };
  const sideCeiling = params.side === AGENT_SIDE ? params.ceiling : undefined;
  if (sideCeiling === undefined) {
    return [withOptional(base, 'effectiveAmountCeiling', cell.amountCeiling)];
  }
  // One clause per compatible consent cell, each with its own selector and its own ceiling: a
  // record is listed only when one consent cell admits it, exactly as a single decision admits it.
  const compatible = ceilingCandidates(sideCeiling, cell);
  return compatible.flatMap((consent) =>
    consentBounds(cell.amountCeiling, consent, compatible).map((bound) =>
      withOptional(
        withOptional(base, 'connectionRecordKeys', consentRecordKeys(consent)),
        'effectiveAmountCeiling',
        bound,
      ),
    ),
  );
};

const listCellsPlan = (params: {
  readonly ceiling: ConsentCeiling | undefined;
  readonly cells: readonly AuthorityCell[];
  readonly holder: Holder;
  readonly now: Date;
  readonly policy: DecisionCapabilityPolicy;
  readonly side: HolderSide;
  readonly teamIds: readonly AccessTeamId[];
}): readonly ListAuthorityCell[] => {
  const planned: ListAuthorityCell[] = [];
  for (const cell of params.cells) {
    planned.push(...listCellOf({ ...params, cell }));
  }
  return planned;
};

const listTeamIds = (
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  side: HolderSide,
  cells: readonly AuthorityCell[],
): Effect.Effect<readonly AccessTeamId[], AccessDecisionUnavailable> => {
  const holder = holderFor(resolved, side);
  const needsTeams = cells.some((cell) => recordSelectorOf(cell.selector) === 'team');
  if (!needsTeams) {
    return Effect.succeed([]);
  }
  return authority.readTeamIds({ holder, scopeId: resolved.scope.scopeId, tenantId: resolved.scope.tenantId });
};

interface ReadSide {
  readonly cells: readonly AuthorityCell[];
  readonly holder: Holder;
  readonly side: HolderSide;
  readonly teamIds: readonly AccessTeamId[];
}

const readSideWithTeams = (
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  capabilityPolicy: DecisionCapabilityPolicy,
  mode: AccessMode,
  side: HolderSide,
): Effect.Effect<Option.Option<ReadSide>> =>
  Effect.option(
    readAuthorityCells(authority, resolved, { capability: capabilityPolicy, mode }, mode, side).pipe(
      Effect.flatMap((cells) =>
        listTeamIds(authority, resolved, side, cells).pipe(
          Effect.map((teamIds): ReadSide => ({ cells, holder: holderFor(resolved, side), side, teamIds })),
        ),
      ),
    ),
  );

interface ListCellVariant {
  /** Explicit target set key this variant proves, when the cell narrows to explicit records. */
  readonly key?: RecordKey;
  readonly planned: PlannedCell;
}

/**
 * One list cell may need several checks in the same snapshot: an explicit target set is proven per
 * record key, and an amount-capped binding is proven at its own widest permitted amount because the
 * row-level ceiling is enforced by the owner's predicate.
 */
const listCellVariants = (
  listCell: ListAuthorityCell,
  side: HolderSide,
  scope: ProjectionScope,
): readonly ListCellVariant[] => {
  const ceiling = listCell.effectiveAmountCeiling;
  const checkAmount: AccessAmount | undefined =
    ceiling === undefined ? undefined : { currency: ceiling.currency, minor: ceiling.limitMinor };
  const recordSelector = recordSelectorOf(listCell.cell.selector);
  const keys: readonly (RecordKey | undefined)[] =
    recordSelector === undefined ? targetKeysOf(listCell.cell.selector) : [undefined];
  return keys.map((key) =>
    withOptional(
      {
        planned: cellPlan({
          cell: listCell.cell,
          context: checkContext({
            ...withOptional({}, 'amount', checkAmount),
            ...withOptional({}, 'ceiling', ceiling),
            selector: listCell.cell.selector,
            ...withOptional({}, 'target', key),
          }),
          mode: listCell.cell.mode,
          purpose: PURPOSE_REQUESTER,
          scope,
          side,
        }),
      },
      'key',
      key,
    ),
  );
};

const listDeniedDecision = (): AccessDecision => deniedDecision([INSUFFICIENT_GRANT]);

interface ListSidePlan {
  readonly cells: readonly ListAuthorityCell[];
  readonly holder: Holder;
  readonly side: HolderSide;
  readonly teamIds: readonly AccessTeamId[];
}

const readListSides: (
  authority: DecisionAuthorityPort,
  resolved: ResolvedActor,
  capability: DecisionCapabilityPolicy,
  modes: EvaluationModes,
) => Effect.Effect<Option.Option<readonly ReadSide[]>> = Effect.fn('AccessDecision.readListSides')(
  function* readListSidesProgram(
    authority: DecisionAuthorityPort,
    resolved: ResolvedActor,
    capability: DecisionCapabilityPolicy,
    modes: EvaluationModes,
  ) {
    const reads = yield* Effect.all(
      sidesOf(resolved).map((side) => readSideWithTeams(authority, resolved, capability, modes.effectiveMode, side)),
      { concurrency: 2 },
    );
    const readSides: ReadSide[] = [];
    for (const read of reads) {
      const value = Option.getOrUndefined(read);
      if (value === undefined) {
        return Option.none<readonly ReadSide[]>();
      }
      readSides.push(value);
    }
    return Option.some<readonly ReadSide[]>(readSides);
  },
);

const planListSides = (
  readSides: readonly ReadSide[],
  resolved: ResolvedActor,
  input: ListDecisionInput,
): readonly ListSidePlan[] =>
  readSides.map(({ cells, holder, side, teamIds }) => ({
    cells: listCellsPlan({
      ceiling: side === AGENT_SIDE ? resolved.consentCeiling : undefined,
      cells,
      holder,
      now: input.now,
      policy: input.capability,
      side,
      teamIds,
    }),
    holder,
    side,
    teamIds,
  }));

interface ListSnapshot {
  readonly engineFailed: boolean;
  /** Sides with at least one unevaluable cell and no resolved cell: fail closed, return no rows. */
  readonly indeterminateSides: ReadonlySet<HolderSide>;
  readonly resolvedCells: ReadonlyMap<HolderSide, ListAuthorityCell[]>;
}

const listSnapshot: (
  check: DecisionCheckPort,
  plannedSides: readonly ListSidePlan[],
  scope: ProjectionScope,
) => Effect.Effect<ListSnapshot> = Effect.fn('AccessDecision.listSnapshot')(function* listSnapshotProgram(
  check: DecisionCheckPort,
  plannedSides: readonly ListSidePlan[],
  scope: ProjectionScope,
) {
  const plannedCells = plannedSides.flatMap(({ cells, side }) =>
    cells.map((listCell) => ({ listCell, side, variants: listCellVariants(listCell, side, scope) })),
  );
  const listItems = plannedCells.flatMap(({ variants }) => variants.flatMap(({ planned }) => planned.items));
  const resultsOption =
    listItems.length === 0
      ? Option.some<readonly AccessCheckResult[]>([])
      : yield* Effect.option(check.checkBulk(listItems));
  if (Option.isNone(resultsOption)) {
    return { engineFailed: true, indeterminateSides: new Set(), resolvedCells: new Map() };
  }
  const results = resultsOption.value;
  if (results.length !== listItems.length) {
    // Same rule as the single decision: a missing answer is an unavailable engine, never a denial.
    return { engineFailed: true, indeterminateSides: new Set(), resolvedCells: new Map() };
  }
  const resolvedCells = new Map<HolderSide, ListAuthorityCell[]>();
  const indeterminateSides = new Set<HolderSide>();
  let cursor = 0;
  for (const { listCell, side, variants } of plannedCells) {
    const resolvedKeys: RecordKey[] = [];
    let hasAny = false;
    let indeterminate = false;
    for (const variant of variants) {
      const verdict = cellVerdict(results, cursor, variant.planned.items.length);
      cursor += variant.planned.items.length;
      if (verdict === 'error') {
        return { engineFailed: true, indeterminateSides: new Set(), resolvedCells: new Map() };
      }
      if (verdict === 'has') {
        hasAny = true;
        if (variant.key !== undefined) {
          resolvedKeys.push(variant.key);
        }
      }
      if (verdict === 'indeterminate') {
        indeterminate = true;
      }
    }
    if (!hasAny) {
      if (indeterminate) {
        indeterminateSides.add(side);
      }
      continue;
    }
    const [firstResolvedKey, ...restResolvedKeys] = resolvedKeys;
    const predicateCell: ListAuthorityCell =
      firstResolvedKey === undefined
        ? listCell
        : {
            ...listCell,
            cell: {
              ...listCell.cell,
              selector: { _tag: 'targets', recordKeys: [firstResolvedKey, ...restResolvedKeys] },
            },
          };
    const current = resolvedCells.get(side) ?? [];
    current.push(predicateCell);
    resolvedCells.set(side, current);
  }
  return { engineFailed: false, indeterminateSides, resolvedCells };
});

const listResolutionFrom = (params: {
  readonly modes: EvaluationModes;
  readonly plannedSides: readonly ListSidePlan[];
  readonly resolved: ResolvedActor;
  readonly resolvedCells: ReadonlyMap<HolderSide, ListAuthorityCell[]>;
}): ListAccessResolution => {
  const predicateSides: ListAuthoritySide[] = [];
  for (const side of params.plannedSides) {
    const sideCells = params.resolvedCells.get(side.side) ?? [];
    if (sideCells.length > 0) {
      predicateSides.push({ cells: sideCells, holder: side.holder, teamIds: side.teamIds });
    }
  }
  const [firstPredicateSide, ...restPredicateSides] = predicateSides;
  const predicate =
    firstPredicateSide !== undefined && predicateSides.length === params.plannedSides.length
      ? buildListAccessPredicate([firstPredicateSide, ...restPredicateSides])
      : undefined;
  if (predicate === undefined) {
    return { decision: listDeniedDecision() };
  }
  // One grant cell may stand behind several clauses (one per consent cell); it is one witness.
  const evidenceCells = new Map<string, PlannedCell>();
  for (const side of predicateSides) {
    const holderSide = sideOfHolder(side.holder);
    for (const { cell } of side.cells) {
      evidenceCells.set(`${holderSide}:${cell.grantIncarnationId}:${cell.assignmentIncarnationId}`, {
        cell,
        items: [],
        purpose: PURPOSE_REQUESTER,
        side: holderSide,
      });
    }
  }
  const evidence = evidenceOf([...evidenceCells.values()], params.resolved.scope.scopeId);
  return {
    decision: makeDecision({
      admissionDeadline: earliestDeadline([
        ...actorDeadlines(params.resolved),
        ...evidence.map(({ deadline }) => deadline),
      ]),
      evidence,
      outcome: params.modes.needsApproval ? 'NEEDS_APPROVAL' : 'ALLOWED',
      reasons: params.modes.needsApproval ? [decisionReason('approval.required')] : grantedReasons(evidence),
    }),
    predicate,
  };
};

const resolveListAccessEffect: (
  authority: DecisionAuthorityPort,
  check: DecisionCheckPort,
  input: ListDecisionInput,
) => Effect.Effect<ListAccessResolution> = Effect.fn('AccessDecision.list')(function* resolveListAccessProgram(
  authority: DecisionAuthorityPort,
  check: DecisionCheckPort,
  input: ListDecisionInput,
) {
  const { actor, capability, mode, now } = input;
  const resolution = yield* resolveActorContext(authority, actor, now);
  if (resolution.unavailable !== undefined || resolution.resolved === undefined) {
    if (resolution.refusal !== undefined) {
      return { decision: deniedDecision(resolution.refusal) };
    }
    return { decision: unavailableIntentDecision() };
  }
  const { resolved } = resolution;
  const modes = evaluationModes(resolved, capability, mode);
  if ('reason' in modes) {
    return { decision: deniedDecision([modes.reason]) };
  }
  const readSides = Option.getOrUndefined(yield* readListSides(authority, resolved, capability, modes));
  if (readSides === undefined) {
    return { decision: unavailableIntentDecision() };
  }
  const plannedSides = planListSides(readSides, resolved, input);
  const { engineFailed, indeterminateSides, resolvedCells } = yield* listSnapshot(
    check,
    plannedSides,
    projectionScopeOf(resolved.scope),
  );
  if (engineFailed) {
    return { decision: unavailableDecision() };
  }
  // The same rule as one decision: a side that resolved no cell but had an unevaluable caveat
  // fails closed, and a conditional sibling of a resolved cell never narrows or widens the list (L2).
  const indeterminate = plannedSides.some(
    (side) => (resolvedCells.get(side.side)?.length ?? 0) === 0 && indeterminateSides.has(side.side),
  );
  if (indeterminate) {
    return { decision: deniedDecision([CAVEAT_INDETERMINATE]) };
  }
  return listResolutionFrom({ modes, plannedSides, resolved, resolvedCells });
});

/**
 * List path (D16): the same authority question, answered as selectors, then handed to the owner as
 * a SQL predicate. It is not a second decision system: it runs one engine snapshot over the same
 * candidate cells, and a record is visible exactly when `decideAccess` would allow it.
 */
export const resolveListAccess = resolveListAccessEffect;
