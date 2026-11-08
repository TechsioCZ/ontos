import { Effect, Layer, Option } from 'effect';

import type { AccessActor } from '../../authorization/access-declaration.ts';
import { readVerifiedGatewayActor } from '../../auth/system-principal-context-provenance.ts';
import type { VerifiedGatewayActor } from '../../auth/system-principal-context-provenance.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { legalEntityObjectId, objectTypeOf } from '../compiler/object-id.ts';
import { AccessIntent } from '../decision/authority.ts';
import type { ActorContextInput } from '../decision/authority.ts';
import type { AccessDecision, AccessDecisionRequest, DecisionCapabilityPolicy } from '../decision/contract.ts';
import { DecisionCheck, decideAccess, decideAccessMany, resolveListAccess } from '../decision/engine.ts';
import type { ListAccessResolution } from '../decision/engine.ts';
import type { ListAccessPredicate } from '../decision/list-access.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import { withOptional } from '../decision/optional.ts';
import { AccessScopeIdSchema, CapabilityKeySchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import type { AccessScopeId, LegalEntityId, PrincipalId } from '../ids.ts';
import type { ActorContext, DecisionReason, Holder } from '../model.ts';
import { AccessPrincipalKindSource, isWorkloadPrincipalKind, resolveGateActor } from './actor.ts';
import type { GateActor } from './actor.ts';
import { capabilityPolicyOf, gateScopeOf } from './capability.ts';
import type {
  AccessDecisionPorts,
  AccessDecisionService,
  GateCarrier,
  GateInput,
  GateMode,
  ListGateInput,
  SelectableLegalEntitiesInput,
} from './contract.ts';
import { AccessDecisionGate } from './contract.ts';
import { AccessWorkloadBindingSource } from './workload-port.ts';
import { seamAdmission, seamDenial, seamRefusal, seamUnavailable } from './decisions.ts';
import type { AccessDecisionDelegation } from './decision-log.ts';
import { AccessDecisionLog, shouldRecordDecision, shouldRecordDelegatedDecision } from './decision-log.ts';
import { LegalEntityCandidates } from './legal-entities.ts';
import type { AccessWorkloadBindings } from './workload-port.ts';

export type { AccessDecisionPorts } from './contract.ts';

const HUMAN_SUBJECT = 'principal';
const SELECT_PERMISSION = 'select';
const IDENTITY_UNAVAILABLE = 'unavailable.intent';
const EVIDENCE_UNAVAILABLE = 'unavailable.evidence';
const DEFAULT_MODE = 'run';
const INSUFFICIENT_GRANT = 'deny.insufficient_grant';
const DECLARATION_MISSING = 'deny.declaration_missing';
const WORKLOAD_FORBIDDEN = 'deny.workload_forbidden';
const WORKLOAD_UNBOUND = 'deny.workload_unbound';
const WORKLOAD_ONLY = 'deny.workload_only';
const AGENT_FORBIDDEN = 'deny.agent_forbidden';
const ACTOR_FORBIDDEN = 'deny.actor_forbidden';
const ACTOR_UNBOUND = 'deny.actor_unbound';
const ACTOR_SUBJECT_INVALID = 'deny.actor_subject_invalid';
const ALLOW_ACTOR_IDENTITY = 'allow.actor_identity';

/**
 * The evidence capability of an `identity` admission whose carrier declares no `accessDeclaration`
 * (D5, D6). Such a carrier has no capability of its own, so its evidence row names this one.
 */
const IDENTITY_CAPABILITY: DecisionCapabilityPolicy = {
  capabilityKey: CapabilityKeySchema.make('core.access.actor-identity'),
  kind: 'action',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
};

/** The capability a delegated decision is evidenced under: the declaration's own, or the identity one. */
const evidenceCapabilityOf = (declaration: GateCarrier['accessDeclaration']): DecisionCapabilityPolicy =>
  declaration === undefined ? IDENTITY_CAPABILITY : capabilityPolicyOf(declaration);

/** The calling module of a verified delegated call, as the evidence row names it (D6). */
const delegationOf = (calledBy: VerifiedGatewayActor): AccessDecisionDelegation => ({
  appId: calledBy.appId,
  principalId: calledBy.principalId,
});

/**
 * D6 steps 1-2, decided before anything about the subject is read: the carrier must declare `accessActor`,
 * and the calling module must be one of its callers.
 */
const delegatedCarrierOf = (
  carrier: GateCarrier,
  calledBy: VerifiedGatewayActor,
): { readonly declared: AccessActor } | { readonly refusal: AccessDecision } => {
  const declared = carrier.accessActor;
  if (declared === undefined) {
    return { refusal: seamRefusal(ACTOR_FORBIDDEN) };
  }
  return declared.callers.some((caller) => caller === calledBy.appId)
    ? { declared }
    : { refusal: seamRefusal(ACTOR_UNBOUND) };
};

/**
 * The refusal of a trusted workload that reached a declaration carrier. An `admin` declaration is
 * structural admission for people only (O81): a workload or agent is refused exactly as an agent is
 * anywhere else, `deny.agent_forbidden`, so the admin path never widens to a machine. Every other
 * declaration keeps the O71 vocabulary, `deny.workload_forbidden`.
 */
const workloadOnDeclarationCode = (declaration: GateInput['carrier']['accessDeclaration']): string =>
  declaration?.kind === 'admin' ? AGENT_FORBIDDEN : WORKLOAD_FORBIDDEN;

/**
 * A composition that bound no workload registry admits no workload: the gate answers UNAVAILABLE
 * instead of inventing a binding, which is the same fail-closed answer an unreadable registry gives
 * (O48, O73).
 */
const FAIL_CLOSED_WORKLOADS: AccessWorkloadBindings = {
  readActiveWorkloadKeys: () => Effect.fail(accessDecisionUnavailable('This composition bound no workload registry')),
};
const ALLOW_WORKLOAD = 'allow.workload';

/** The subject an evidence row names: a refused subject may have no kind, so only its principal is carried. */
type EvidenceSubject = Pick<GateActor, 'principalId'>;

/** The human actor of a request; v2 has exactly one actor kind in this wave (O46, O67-Q5). */
const actorContextOf = (actor: EvidenceSubject): ActorContext => ({
  _tag: 'Principal',
  principalId: actor.principalId,
});

const holderOf = (actor: EvidenceSubject): Holder => ({ _tag: 'Principal', principalId: actor.principalId });

/** No registered workloads: the set a person or an agent always has, and a denied workload gets. */
const NO_WORKLOADS: ReadonlySet<string> = new Set();

/**
 * The registry question of one actor in one scope. The scope is the trusted request scope, so the
 * reader answers only this tenant's rows and never a tenant named in a command (O66).
 */
const workloadQueryOf = (scope: OperationalScope, actor: GateActor) => ({
  principalId: actor.principalId,
  scope,
  tenantId: TenantIdSchema.make(scope.tenantId),
});

/**
 * Whether a workload actor may run this carrier: the registry must hold an active binding for one of
 * the carrier's declared keys (O73). A missing intersection is a denial, never a missing grant.
 */
const admitsWorkload = (
  declared: NonNullable<GateInput['carrier']['accessWorkload']>,
  bound: ReadonlySet<string>,
): boolean => declared.workloads.some((key) => bound.has(key));

/**
 * Whether a workload subject may stand for a module call (D6 step 3, workload subject): the carrier's
 * `accessActor` names the workload keys allowed as subject, and the registry holds an active binding for one
 * of them in this scope. A carrier that names none admits no workload subject.
 */
const admitsSubjectWorkload = (declared: AccessActor, bound: ReadonlySet<string>): boolean =>
  declared.subjectWorkloads?.some((key) => bound.has(key)) === true;

const denialOf = (reasons: readonly DecisionReason[]): AccessDecision => {
  const [first, ...rest] = reasons;
  return seamDenial(first ?? { code: INSUFFICIENT_GRANT }, ...rest);
};

/**
 * The refusal of a workload subject of a module call on an `admin` declaration. The direct path refuses a
 * machine there (O81), so the delegated path does too, whatever the registry holds: a carrier's
 * `subjectWorkloads` never turns structural administration into something a machine runs.
 */
const workloadSubjectOnAdmin = (declaration: GateInput['carrier']['accessDeclaration']): AccessDecision | undefined =>
  declaration?.kind === 'admin' ? denialOf([{ code: AGENT_FORBIDDEN }]) : undefined;

/** The same carrier and mode checks precede the registry read in single and batched module calls. */
const delegatedWorkloadCarrierOf = (
  input: Pick<GateInput, 'carrier' | 'mode'>,
  calledBy: VerifiedGatewayActor,
): { readonly declared: AccessActor } | { readonly refusal: AccessDecision } => {
  const onAdmin = workloadSubjectOnAdmin(input.carrier.accessDeclaration);
  if (onAdmin !== undefined) {
    return { refusal: onAdmin };
  }
  const carrier = delegatedCarrierOf(input.carrier, calledBy);
  if ('refusal' in carrier) {
    return carrier;
  }
  if (carrier.declared.subject === 'workload' && (input.mode ?? DEFAULT_MODE) !== DEFAULT_MODE) {
    return { refusal: seamRefusal('deny.mode_unsupported') };
  }
  return carrier.declared.subjectWorkloads === undefined ? { refusal: seamRefusal(ACTOR_SUBJECT_INVALID) } : carrier;
};

/** The scope query names the holders whose membership it proves, in the one context this request resolved (O66). */
const scopeQueryOf = (
  scope: OperationalScope,
  legalEntityId: LegalEntityId | undefined,
  holders: readonly Holder[],
) => {
  const base = { holders, tenantId: TenantIdSchema.make(scope.tenantId) };
  return legalEntityId === undefined ? base : { ...base, legalEntityId };
};

/** A person's scope read proves the person's own membership. */
const memberHoldersOf = (actor: EvidenceSubject): readonly Holder[] => [holderOf(actor)];

/** The engine's actor input: a verified human in the scope this request resolved. */
const actorInputOf = (
  scope: OperationalScope,
  legalEntityId: LegalEntityId | undefined,
  actor: GateActor,
): ActorContextInput => {
  const base = { actor: actorContextOf(actor), tenantId: TenantIdSchema.make(scope.tenantId) };
  return legalEntityId === undefined ? base : { ...base, legalEntityId };
};

/**
 * A delegated call the seam decided with its subject and scope known: a refusal, or an identity admission.
 * Its evidence row names the subject and the calling module (D6 step 5).
 */
interface DelegatedAnswer {
  readonly actor: EvidenceSubject;
  readonly decision: AccessDecision;
  readonly delegation: AccessDecisionDelegation;
  /** An identity admission lists the whole scope, because the owner filters by the subject it acts for (D6). */
  readonly identityAdmitted?: true;
  readonly scopeId: AccessScopeId;
}

/** One seam answer before the engine: the actor, its scope and the carrier are all checkable here. */
interface GatePreamble {
  readonly actor?: GateActor | undefined;
  /** A delegated call the seam decided with its subject and scope known; its evidence row still follows (D6). */
  readonly answer?: DelegatedAnswer | undefined;
  readonly decision?: AccessDecision | undefined;
  /** The verified calling module of a delegated call; its subject is `actor` (D6). */
  readonly delegation?: AccessDecisionDelegation | undefined;
  readonly legalEntityId?: LegalEntityId | undefined;
  readonly scopeId?: AccessScopeId | undefined;
  /** The actor is an admitted workload: its carrier declared `accessWorkload` and Core bound it (O73). */
  readonly workloadAdmitted?: true | undefined;
}

/**
 * A workload admitted on a workload-only carrier reaches the whole scope: it holds no v2 cell, so
 * there is no predicate to build and the owner reads every row of the scope. This is the explicit
 * all-in-scope predicate a row-scoped list read requires, never an absent one (O25, O73).
 */
const ALL_IN_SCOPE: ListAccessPredicate = Object.freeze({ groups: Object.freeze([]) });

/**
 * The identity of one trusted request scope for batching. The intent port and the row-level scope
 * are properties of the scope itself (O66), so one batch never mixes two of them in one read; the
 * per-call correlation and trace ids are not part of it, because they do not reach the intent.
 */
const scopeKeyOf = (scope: OperationalScope): string =>
  [
    scope.tenantId,
    scope.principalId,
    scope.legalEntityId ?? '',
    scope.authMethod,
    scope.authBindingId ?? '',
    scope.authContextRef ?? '',
    scope.impersonatedByPrincipalId ?? '',
    scope.authenticationNamespaceId ?? '',
    scope.trustedStorefrontId ?? '',
    // A batch never mixes two calling modules: each one is admitted by its own carriers (D6).
    readVerifiedGatewayActor(scope)?.appId ?? '',
  ].join('\u0000');

/** One batched request that reached the engine, with everything its evidence row needs afterwards. */
interface BatchedGate {
  readonly actor: GateActor;
  readonly capability: DecisionCapabilityPolicy;
  readonly delegation?: AccessDecisionDelegation | undefined;
  readonly gate: GateInput;
  readonly index: number;
  readonly legalEntityId?: LegalEntityId | undefined;
  readonly mode: GateMode;
  readonly scopeId: AccessScopeId;
}

/** One batch: the inputs of one trusted request scope, in the order they were asked. */
interface GateGroup {
  /** Built once, before any decision is taken, and only read afterwards. */
  readonly indexes: number[];
  readonly scope: OperationalScope;
}

/** One batch per trusted request scope (O66): a batch never mixes two intent scopes in one read. */
const gateGroupsOf = (input: readonly GateInput[]): readonly GateGroup[] => {
  const groups = new Map<string, GateGroup>();
  for (const [index, one] of input.entries()) {
    const key = scopeKeyOf(one.scope);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { indexes: [index], scope: one.scope });
    } else {
      existing.indexes.push(index);
    }
  }
  return [...groups.values()];
};

/** The seam's answer for one batch's subject: the actor, or the delegated subject refusal. */
interface GroupGate {
  readonly actor?: GateActor | undefined;
  readonly calledBy?: VerifiedGatewayActor | undefined;
  readonly decision?: AccessDecision | undefined;
  readonly subjectDecision?: AccessDecision | undefined;
  readonly workloadKeys?: ReadonlySet<string> | undefined;
  readonly workloadRegistryUnavailable?: boolean | undefined;
}

/** One entry before the engine: a refusal the seam already answers, or the request it must plan. */
interface GatePrepared {
  readonly decision?: AccessDecision;
  readonly entry?: BatchedGate;
  /** A delegated decision the seam took without the engine: its evidence row still follows (D6). */
  readonly evidenced?: BatchedGate;
}

/** The subject of one batch whose calls are delegated: the admitted person or workload, or why it is neither. */
interface DelegatedGroup {
  readonly actor?: GateActor | undefined;
  readonly calledBy: VerifiedGatewayActor;
  readonly subjectDecision?: AccessDecision | undefined;
  /** The active workload keys of a workload subject, read once for the group when an entry names some. */
  readonly workloadKeys?: ReadonlySet<string> | undefined;
  readonly workloadRegistryUnavailable?: boolean | undefined;
}

/**
 * The same workload subject rule as the single call: never an `admin` declaration (O81), then its carrier's
 * callers and named keys, a readable registry and one active binding, with no membership read and no v2
 * evidence row (O29, O73).
 */
const delegatedWorkloadDecision = (gate: GateInput, group: DelegatedGroup): AccessDecision => {
  const workloadCarrier = delegatedWorkloadCarrierOf(gate, group.calledBy);
  if ('refusal' in workloadCarrier) {
    return workloadCarrier.refusal;
  }
  if (group.workloadRegistryUnavailable === true) {
    return seamUnavailable(IDENTITY_UNAVAILABLE);
  }
  return admitsSubjectWorkload(workloadCarrier.declared, group.workloadKeys ?? NO_WORKLOADS)
    ? seamAdmission(workloadCarrier.declared.subject === 'workload' ? ALLOW_WORKLOAD : ALLOW_ACTOR_IDENTITY)
    : seamRefusal(ACTOR_SUBJECT_INVALID);
};

/** One delegated entry of a batch, decided exactly as `preambleOf` decides a single delegated request. */
const prepareDelegatedEntry = (params: {
  readonly gate: GateInput;
  readonly group: DelegatedGroup;
  readonly index: number;
  readonly preambles: ReadonlyMap<string, GatePreamble>;
  readonly scope: OperationalScope;
}): GatePrepared => {
  if (params.group.subjectDecision !== undefined) {
    return { decision: params.group.subjectDecision };
  }
  const { actor } = params.group;
  if (actor === undefined) {
    return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
  }
  const gateScope = gateScopeOf(params.gate.legalEntityScope, params.scope);
  if (gateScope.refusal !== undefined) {
    return { decision: denialOf([gateScope.refusal]) };
  }
  if (isWorkloadPrincipalKind(actor.kind)) {
    return { decision: delegatedWorkloadDecision(params.gate, params.group) };
  }
  const preamble = params.preambles.get(gateScope.legalEntityId ?? '');
  if (preamble?.decision !== undefined) {
    return { decision: preamble.decision };
  }
  if (preamble?.scopeId === undefined) {
    return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
  }
  const { accessDeclaration } = params.gate.carrier;
  const entry: BatchedGate = {
    actor,
    capability: evidenceCapabilityOf(accessDeclaration),
    delegation: delegationOf(params.group.calledBy),
    gate: params.gate,
    index: params.index,
    legalEntityId: gateScope.legalEntityId,
    mode: params.gate.mode ?? DEFAULT_MODE,
    scopeId: preamble.scopeId,
  };
  // The subject and its scope are known, so every answer from here on leaves its row (D6 step 5).
  const carrier = delegatedCarrierOf(params.gate.carrier, params.group.calledBy);
  if ('refusal' in carrier) {
    return { decision: carrier.refusal, evidenced: entry };
  }
  if (carrier.declared.subject === 'workload') {
    return { decision: seamRefusal(WORKLOAD_ONLY), evidenced: entry };
  }
  if (accessDeclaration === undefined && carrier.declared.subject === 'rights') {
    return { decision: seamRefusal(DECLARATION_MISSING), evidenced: entry };
  }
  if (carrier.declared.subject === 'identity') {
    return { decision: seamAdmission(ALLOW_ACTOR_IDENTITY), evidenced: entry };
  }
  return { entry };
};

/**
 * The seam half of one batched entry. Every rule is the rule `decide` applies to a single request,
 * in the same order: the carrier, the workload classification, the entrypoint's own scope, then the
 * scope read of that scope.
 */
const prepareEntry = (params: {
  readonly actor: GateActor;
  readonly gate: GateInput;
  readonly index: number;
  readonly preambles: ReadonlyMap<string, GatePreamble>;
  readonly scope: OperationalScope;
  /** The active workload keys of this actor in this scope, read once for the whole batch (O73). */
  readonly workloadKeys: ReadonlySet<string>;
  /** The registry could not be read; only a workload-marked entry is then UNAVAILABLE (O48, O73). */
  readonly workloadRegistryUnavailable: boolean;
}): GatePrepared => {
  const { accessDeclaration, accessWorkload } = params.gate.carrier;
  if (isWorkloadPrincipalKind(params.actor.kind)) {
    // The workload path admits only a carrier that declares it, and only when the registry holds an
    // active binding for one of its keys; a declaration never admits a workload (O67-Q4, O73).
    if (accessWorkload === undefined) {
      // A declaration-only entry refuses a workload by its carrier alone, so an unreadable registry
      // never turns it into 503 where a single `decide` answers the same refusal (R5a-5). An `admin`
      // declaration is structural admission for people only, so a workload is refused as an agent (O81).
      return { decision: denialOf([{ code: workloadOnDeclarationCode(accessDeclaration) }]) };
    }
    if (params.workloadRegistryUnavailable) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    return admitsWorkload(accessWorkload, params.workloadKeys)
      ? { decision: seamAdmission(ALLOW_WORKLOAD) }
      : { decision: denialOf([{ code: WORKLOAD_UNBOUND }]) };
  }
  if (accessDeclaration === undefined) {
    // A human or agent reached a workload carrier: a v2 decision never admits one (O59, O67-Q4).
    return { decision: seamRefusal(WORKLOAD_ONLY) };
  }
  const gateScope = gateScopeOf(params.gate.legalEntityScope, params.scope);
  if (gateScope.refusal !== undefined) {
    return { decision: denialOf([gateScope.refusal]) };
  }
  const preamble = params.preambles.get(gateScope.legalEntityId ?? '');
  if (preamble?.decision !== undefined) {
    return { decision: preamble.decision };
  }
  if (preamble?.scopeId === undefined) {
    return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
  }
  return {
    entry: {
      actor: params.actor,
      capability: capabilityPolicyOf(accessDeclaration),
      gate: params.gate,
      index: params.index,
      legalEntityId: gateScope.legalEntityId,
      mode: params.gate.mode ?? DEFAULT_MODE,
      scopeId: preamble.scopeId,
    },
  };
};

/**
 * One instance per process, built once from its ports: every call carries its own trusted
 * `OperationalScope` (O66), and no method asks the caller for a collaborator.
 */
export const makeAccessDecisionService = (ports: AccessDecisionPorts): AccessDecisionService => {
  const resolveGateScope = Effect.fn('AccessDecisionGate.resolveScope')(function* resolveGateScopeEffect(
    scope: OperationalScope,
    legalEntityId: LegalEntityId | undefined,
    holders: readonly Holder[],
  ) {
    const read = yield* Effect.option(ports.authorityFor(scope).readScope(scopeQueryOf(scope, legalEntityId, holders)));
    if (Option.isNone(read)) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    const resolved = Option.getOrUndefined(read.value);
    return resolved === undefined
      ? { decision: seamRefusal('deny.scope_mismatch') }
      : { scopeId: AccessScopeIdSchema.make(resolved.scopeId) };
  });

  /**
   * The tenant scope a refusal's evidence row is written in. It only names the row's scope: when the subject
   * holds no resolvable tenant scope, or the read is unavailable, the refusal stands and writes no row.
   */
  const refusalScopeOf = (scope: OperationalScope, holders: readonly Holder[]) =>
    resolveGateScope(scope, undefined, holders).pipe(Effect.map((read) => read.scopeId));

  /**
   * A call made by a verified calling module (D6). The subject and its scope are resolved first, so the
   * carrier's refusals are decided for a known subject and leave an evidence row (D6 step 5). Then the
   * carrier's `subject` says whether the subject's rights are decided (`rights`) or the subject is
   * admitted on its identity alone (`identity`).
   */
  const delegatedPreambleOf = Effect.fn('AccessDecisionGate.delegatedPreamble')(function* delegatedPreambleEffect(
    input: {
      readonly carrier: GateInput['carrier'];
      readonly legalEntityScope: GateInput['legalEntityScope'];
      readonly mode?: GateMode;
      readonly scope: OperationalScope;
    },
    calledBy: VerifiedGatewayActor,
  ) {
    const delegation = delegationOf(calledBy);
    const subject = yield* resolveGateActor(ports.principalKinds, input.scope, { admitWorkloads: true });
    if (subject.unavailable === true) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    const { actor } = subject;
    if (actor === undefined) {
      // An agent, or a principal with no kind, is never the subject of a module call. Its refusal is evidence
      // naming the delegate (D6 step 5), recorded under the subject's principal when its tenant scope resolves.
      const principalId = PrincipalIdSchema.make(input.scope.principalId);
      const decision = seamRefusal(ACTOR_SUBJECT_INVALID);
      const scopeId = yield* refusalScopeOf(input.scope, memberHoldersOf({ principalId }));
      return scopeId === undefined
        ? { decision }
        : { answer: { actor: { principalId }, decision, delegation, scopeId } };
    }
    const gateScope = gateScopeOf(input.legalEntityScope, input.scope);
    if (isWorkloadPrincipalKind(actor.kind)) {
      // A workload subject is decided exactly as a direct workload call is: by its registered binding, never by a
      // membership or a v2 grant, and it leaves no v2 evidence row, because a workload is never a v2 subject (O29,
      // O73). The company check still holds, so a company carrier never runs without one, and an `admin`
      // declaration refuses a machine here exactly as the direct path does (O81).
      if (gateScope.refusal !== undefined) {
        return { decision: denialOf([gateScope.refusal]) };
      }
      const carrier = delegatedWorkloadCarrierOf(input, calledBy);
      if ('refusal' in carrier) {
        return { decision: carrier.refusal };
      }
      const bound = yield* Effect.option(
        (ports.workloadBindings ?? FAIL_CLOSED_WORKLOADS).readActiveWorkloadKeys(workloadQueryOf(input.scope, actor)),
      );
      if (Option.isNone(bound)) {
        return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
      }
      return admitsSubjectWorkload(carrier.declared, bound.value)
        ? {
            decision: seamAdmission(carrier.declared.subject === 'workload' ? ALLOW_WORKLOAD : ALLOW_ACTOR_IDENTITY),
            workloadAdmitted: true as const,
          }
        : { decision: seamRefusal(ACTOR_SUBJECT_INVALID) };
    }
    if (gateScope.refusal !== undefined) {
      // A refused company is evidenced in the tenant scope, the one scope a company-less request is decided in.
      const decision = denialOf([gateScope.refusal]);
      const scopeId = yield* refusalScopeOf(input.scope, memberHoldersOf(actor));
      return scopeId === undefined ? { decision } : { answer: { actor, decision, delegation, scopeId } };
    }
    const resolved = yield* resolveGateScope(input.scope, gateScope.legalEntityId, memberHoldersOf(actor));
    if (resolved.decision !== undefined) {
      return { decision: resolved.decision };
    }
    const { scopeId } = resolved;
    if (scopeId === undefined) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    const carrier = delegatedCarrierOf(input.carrier, calledBy);
    if ('refusal' in carrier) {
      return { answer: { actor, decision: carrier.refusal, delegation, scopeId } };
    }
    if (carrier.declared.subject === 'workload') {
      return { answer: { actor, decision: seamRefusal(WORKLOAD_ONLY), delegation, scopeId } };
    }
    if (input.carrier.accessDeclaration === undefined && carrier.declared.subject === 'rights') {
      return { answer: { actor, decision: seamRefusal(DECLARATION_MISSING), delegation, scopeId } };
    }
    if (carrier.declared.subject === 'identity') {
      return {
        answer: {
          actor,
          decision: seamAdmission(ALLOW_ACTOR_IDENTITY),
          delegation,
          identityAdmitted: true as const,
          scopeId,
        },
      };
    }
    return { actor, delegation, legalEntityId: gateScope.legalEntityId, scopeId };
  });

  const preambleOf = Effect.fn('AccessDecisionGate.preamble')(function* preambleEffect(input: {
    readonly carrier: GateInput['carrier'];
    readonly legalEntityScope: GateInput['legalEntityScope'];
    readonly mode?: GateMode;
    readonly scope: OperationalScope;
  }) {
    const calledBy = readVerifiedGatewayActor(input.scope);
    if (calledBy !== undefined) {
      return yield* delegatedPreambleOf(input, calledBy);
    }
    const { accessDeclaration, accessWorkload } = input.carrier;
    if (accessDeclaration === undefined && accessWorkload === undefined) {
      // A protected entrypoint without any carrier never becomes an implicit allow (O62).
      return { decision: seamRefusal(DECLARATION_MISSING) };
    }
    const actorResolution = yield* resolveGateActor(ports.principalKinds, input.scope, {
      // A carrier is under enforcement here, so the seam resolves the actor's real kind and decides
      // the path itself: a workload is refused on a declaration carrier with the code that carrier
      // deserves (an `admin` declaration refuses it as an agent, O81), never before the seam sees it.
      admitWorkloads: true,
    });
    if (actorResolution.unavailable === true) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    if (actorResolution.refusal !== undefined) {
      return { decision: denialOf(actorResolution.refusal) };
    }
    const { actor } = actorResolution;
    if (actor === undefined) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    if (actorResolution.workload === true) {
      // A trusted workload is admitted by the owner of the capability it runs, never by a v2 grant
      // (O29, O59): the dual carrier routes by actor kind, so this branch is the workload path
      // (O67-Q4). The kind is not enough: Core must hold an active binding for one of the carrier's
      // declared workload keys, otherwise the workload is refused and never granted (O73).
      if (accessWorkload === undefined) {
        // An `admin` declaration admits people only (O81); every other declaration keeps O71's code.
        return { decision: denialOf([{ code: workloadOnDeclarationCode(accessDeclaration) }]) };
      }
      const bound = yield* Effect.option(
        (ports.workloadBindings ?? FAIL_CLOSED_WORKLOADS).readActiveWorkloadKeys(workloadQueryOf(input.scope, actor)),
      );
      if (Option.isNone(bound)) {
        return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
      }
      return admitsWorkload(accessWorkload, bound.value)
        ? { decision: seamAdmission(ALLOW_WORKLOAD), workloadAdmitted: true as const }
        : { decision: denialOf([{ code: WORKLOAD_UNBOUND }]) };
    }
    if (accessDeclaration === undefined) {
      // A human or agent reached a workload carrier: a v2 decision never admits one (O59, O67-Q4).
      return { decision: seamRefusal(WORKLOAD_ONLY) };
    }
    const gateScope = gateScopeOf(input.legalEntityScope, input.scope);
    if (gateScope.refusal !== undefined) {
      return { decision: denialOf([gateScope.refusal]) };
    }
    const resolved = yield* resolveGateScope(input.scope, gateScope.legalEntityId, memberHoldersOf(actor));
    if (resolved.decision !== undefined) {
      return { decision: resolved.decision };
    }
    return resolved.scopeId === undefined
      ? { decision: seamUnavailable(IDENTITY_UNAVAILABLE) }
      : { actor, legalEntityId: gateScope.legalEntityId, scopeId: resolved.scopeId };
  });

  /**
   * Records the evidence this decision must leave behind. A decision that cannot be recorded is not
   * taken: the caller gets a retryable UNAVAILABLE instead of an unrecorded sensitive act.
   */
  const recordDecision = Effect.fn('AccessDecisionGate.recordDecision')(function* recordDecisionEffect(params: {
    readonly actor: EvidenceSubject;
    readonly capability: ReturnType<typeof capabilityPolicyOf>;
    readonly decision: AccessDecision;
    /** The calling module of a delegated request; its evidence is always recorded (D6). */
    readonly delegation?: AccessDecisionDelegation | undefined;
    readonly entry: {
      readonly mode: AccessDecisionRequest['mode'];
      readonly onBehalfOfPrincipalId?: PrincipalId;
      readonly scope: OperationalScope;
      readonly scopeId: AccessScopeId;
      readonly target?: GateInput['target'];
    };
    readonly now: Date;
  }) {
    const { actor, capability, decision, delegation, entry, now } = params;
    const evidence =
      delegation === undefined ? shouldRecordDecision(decision, capability) : shouldRecordDelegatedDecision(decision);
    if (!evidence) {
      return decision;
    }
    const recorded = yield* Effect.option(
      ports.decisionLog.record(
        withOptional(
          withOptional(
            withOptional(
              withOptional(
                {
                  actor: actorContextOf(actor),
                  capability,
                  decidedAt: now,
                  mode: entry.mode,
                  outcome: decision.outcome,
                  reasons: decision.reasons,
                  scope: entry.scope,
                  scopeId: entry.scopeId,
                },
                'admissionDeadline',
                decision.admissionDeadline,
              ),
              'delegation',
              delegation,
            ),
            'onBehalfOfPrincipalId',
            entry.onBehalfOfPrincipalId,
          ),
          'target',
          entry.target?.recordKey,
        ),
      ),
    );
    return Option.isNone(recorded) ? seamUnavailable(EVIDENCE_UNAVAILABLE) : decision;
  });

  /**
   * One protected request: the carrier, the acting principal, the scope, then the one decision
   * function. Every seam refusal happens before the engine is asked and names its own reason.
   */
  const decide = Effect.fn('AccessDecisionGate.decide')(function* decideGate(input: GateInput) {
    const preamble: GatePreamble = yield* preambleOf(input);
    const declaration = input.carrier.accessDeclaration;
    const mode = input.mode ?? DEFAULT_MODE;
    if (preamble.answer !== undefined) {
      // A delegated answer the seam already took, a refusal or an identity admission, is evidence too: its
      // row names the subject and the calling module (D6 step 5).
      const { answer } = preamble;
      return yield* recordDecision({
        actor: answer.actor,
        capability: evidenceCapabilityOf(declaration),
        decision: answer.decision,
        delegation: answer.delegation,
        entry: withOptional(
          withOptional(
            { mode, scope: input.scope, scopeId: answer.scopeId },
            'onBehalfOfPrincipalId',
            input.onBehalfOfPrincipalId,
          ),
          'target',
          input.target,
        ),
        now: input.now,
      });
    }
    if (preamble.decision !== undefined || declaration === undefined) {
      return preamble.decision ?? seamRefusal(DECLARATION_MISSING);
    }
    const { actor, legalEntityId, scopeId } = preamble;
    if (actor === undefined || scopeId === undefined) {
      return seamUnavailable(IDENTITY_UNAVAILABLE);
    }
    const capability = capabilityPolicyOf(declaration);
    const request: AccessDecisionRequest = withOptional(
      withOptional(
        withOptional(withOptional({ capability, mode }, 'amount', input.amount), 'target', input.target),
        'parentRead',
        input.parentRead,
      ),
      'mode',
      mode,
    );
    const decision = yield* decideAccess(ports.authorityFor(input.scope), ports.check, {
      actor: actorInputOf(input.scope, legalEntityId, actor),
      now: input.now,
      request,
    });
    return yield* recordDecision({
      actor,
      capability,
      decision,
      delegation: preamble.delegation,
      entry: withOptional(
        withOptional({ mode, scope: input.scope, scopeId }, 'onBehalfOfPrincipalId', input.onBehalfOfPrincipalId),
        'target',
        input.target,
      ),
      now: input.now,
    });
  });

  /** A list, search or history page: the same authority question, answered as an owner predicate. */
  const list = Effect.fn('AccessDecisionGate.list')(function* listGate(input: ListGateInput) {
    const preamble: GatePreamble = yield* preambleOf(input);
    const declaration = input.carrier.accessDeclaration;
    if (preamble.workloadAdmitted === true) {
      // A bound workload on a workload-only list read sees the whole scope: it holds no v2 cell, so
      // the answer carries the explicit all-in-scope predicate a row-scoped read requires (O25, O73).
      return { decision: preamble.decision ?? seamAdmission(ALLOW_WORKLOAD), predicate: ALL_IN_SCOPE };
    }
    if (preamble.answer !== undefined) {
      // A delegated answer the seam already took is recorded as its own answer. An identity admission lists the
      // whole scope: the owner filters by the subject it acts for (D6).
      const { answer } = preamble;
      const decision = yield* recordDecision({
        actor: answer.actor,
        capability: evidenceCapabilityOf(declaration),
        decision: answer.decision,
        delegation: answer.delegation,
        entry: { mode: DEFAULT_MODE, scope: input.scope, scopeId: answer.scopeId },
        now: input.now,
      });
      return answer.identityAdmitted === true && decision === answer.decision
        ? { decision, predicate: ALL_IN_SCOPE }
        : { decision };
    }
    if (preamble.decision !== undefined || declaration === undefined) {
      return { decision: preamble.decision ?? seamRefusal(DECLARATION_MISSING) };
    }
    const { actor, legalEntityId, scopeId } = preamble;
    if (actor === undefined || scopeId === undefined) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    const capability = capabilityPolicyOf(declaration);
    const listing: ListAccessResolution = yield* resolveListAccess(ports.authorityFor(input.scope), ports.check, {
      actor: actorInputOf(input.scope, legalEntityId, actor),
      capability,
      mode: DEFAULT_MODE,
      now: input.now,
    });
    const decision = yield* recordDecision({
      actor,
      capability,
      decision: listing.decision,
      delegation: preamble.delegation,
      entry: { mode: DEFAULT_MODE, scope: input.scope, scopeId },
      now: input.now,
    });
    return decision === listing.decision ? listing : { decision };
  });

  /** The companies whose context this actor may select, proved in one engine snapshot (O28). */
  const selectableLegalEntities = Effect.fn('AccessDecisionGate.selectableLegalEntities')(
    function* selectableLegalEntitiesGate(input: SelectableLegalEntitiesInput) {
      const actorResolution = yield* resolveGateActor(ports.principalKinds, input.scope, {
        // A workload selects a company only as the subject of a verified module call (D6); on its own request it
        // keeps no company at all (O29).
        admitWorkloads: readVerifiedGatewayActor(input.scope) !== undefined,
      });
      if (actorResolution.unavailable === true) {
        return yield* accessDecisionUnavailable('The acting principal could not be read');
      }
      const { actor } = actorResolution;
      if (actorResolution.refusal !== undefined || actor === undefined) {
        // A refusal names a principal kind that never selects a company: it sees none, not an error.
        return [];
      }
      if (actorResolution.workload === true) {
        // A workload holds no v2 tuple. Its registered binding is tenant-wide, so the subject of a module call may
        // act in every company of the tenant it is bound in, and in none while it holds no active binding (O73).
        const bound = yield* Effect.option(
          (ports.workloadBindings ?? FAIL_CLOSED_WORKLOADS).readActiveWorkloadKeys(workloadQueryOf(input.scope, actor)),
        );
        if (Option.isNone(bound)) {
          return yield* accessDecisionUnavailable('The workload registry could not be read');
        }
        if (bound.value.size === 0) {
          return [];
        }
      }
      const candidates = yield* Effect.option(ports.legalEntities.listCandidateIds(input.scope));
      if (Option.isNone(candidates)) {
        return yield* accessDecisionUnavailable('The companies of this tenant could not be read');
      }
      if (candidates.value.length === 0 || actorResolution.workload === true) {
        return candidates.value;
      }
      const answers = yield* Effect.option(
        ports.check.checkBulk(
          candidates.value.map((legalEntityId) => ({
            permission: SELECT_PERMISSION,
            resource: {
              id: legalEntityObjectId(input.scope.tenantId, legalEntityId),
              type: objectTypeOf('legal_entity'),
            },
            subject: { id: actor.principalId, type: HUMAN_SUBJECT },
          })),
        ),
      );
      if (Option.isNone(answers) || answers.value.length !== candidates.value.length) {
        return yield* accessDecisionUnavailable('The authorization engine did not answer for every company');
      }
      const selectable: LegalEntityId[] = [];
      for (const [index, candidate] of candidates.value.entries()) {
        const answer = answers.value[index];
        if (answer === undefined || answer.permissionship === 'error') {
          return yield* accessDecisionUnavailable('The authorization engine could not answer for a company');
        }
        if (answer.permissionship === 'has') {
          selectable.push(candidate);
        }
      }
      return selectable;
    },
  );

  /**
   * The actor gate of one group: one identity read answers every entry of the scope, so a page
   * never reads the same principal kind once per entry. The seam resolves the actor's real kind
   * whenever the group carries a carrier, and one registry read then answers every workload-marked
   * entry of the group; each entry then decides its own path and refusal code (O67-Q4, O73, O81).
   */
  const actorGateOf = Effect.fn('AccessDecisionGate.actorGate')(function* actorGateEffect(params: {
    readonly group: GateGroup;
    readonly input: readonly GateInput[];
    readonly scope: OperationalScope;
  }): Effect.fn.Return<GroupGate> {
    const calledBy = readVerifiedGatewayActor(params.scope);
    if (calledBy !== undefined) {
      // One subject for the whole batch; each entry then decides its own calling-module carrier (D6).
      const subject = yield* resolveGateActor(ports.principalKinds, params.scope, { admitWorkloads: true });
      if (subject.unavailable === true) {
        return { calledBy, subjectDecision: seamUnavailable(IDENTITY_UNAVAILABLE) };
      }
      const { actor } = subject;
      if (actor === undefined) {
        return { calledBy, subjectDecision: seamRefusal(ACTOR_SUBJECT_INVALID) };
      }
      if (!isWorkloadPrincipalKind(actor.kind)) {
        return { actor, calledBy };
      }
      // A workload subject reads the registry once for the whole group, and only when an entry names workload keys.
      const namesWorkloads = params.group.indexes.some(
        (index) => params.input[index]?.carrier.accessActor?.subjectWorkloads !== undefined,
      );
      if (!namesWorkloads) {
        return { actor, calledBy, workloadKeys: NO_WORKLOADS, workloadRegistryUnavailable: false };
      }
      const bound = yield* Effect.option(
        (ports.workloadBindings ?? FAIL_CLOSED_WORKLOADS).readActiveWorkloadKeys(workloadQueryOf(params.scope, actor)),
      );
      return Option.isNone(bound)
        ? { actor, calledBy, workloadKeys: NO_WORKLOADS, workloadRegistryUnavailable: true }
        : { actor, calledBy, workloadKeys: bound.value, workloadRegistryUnavailable: false };
    }
    // A carrier that declares only `accessActor` never admits a module-less call, so it reads no identity (D6).
    const declared = params.group.indexes.some((index) => {
      const carrier = params.input[index]?.carrier;
      return carrier !== undefined && (carrier.accessDeclaration !== undefined || carrier.accessWorkload !== undefined);
    });
    if (!declared) {
      // Every entry is refused by its own carrier, so no identity question is asked at all.
      return {};
    }
    const hasWorkloadMarker = params.group.indexes.some(
      (index) => params.input[index]?.carrier.accessWorkload !== undefined,
    );
    const resolution = yield* resolveGateActor(ports.principalKinds, params.scope, {
      // A carrier is under enforcement, so the seam resolves the kind and decides the path itself: a
      // workload on a declaration carrier is refused with that carrier's own code (O81).
      admitWorkloads: true,
    });
    if (resolution.unavailable === true) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    if (resolution.refusal !== undefined) {
      return { decision: denialOf(resolution.refusal) };
    }
    const { actor } = resolution;
    if (actor === undefined) {
      return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
    }
    if (resolution.workload !== true || !hasWorkloadMarker) {
      // A person or agent has no registered workloads, and a group without a workload-marked entry
      // never consults the keys: the carrier routing refuses every workload entry by itself, so no
      // registry read is spent here (R5a-5).
      return { actor, workloadKeys: NO_WORKLOADS, workloadRegistryUnavailable: false };
    }
    const bound = yield* Effect.option(
      (ports.workloadBindings ?? FAIL_CLOSED_WORKLOADS).readActiveWorkloadKeys(workloadQueryOf(params.scope, actor)),
    );
    // An unreadable registry is UNAVAILABLE for the workload-marked entries of this group only; a
    // declaration-only entry still refuses a workload by its carrier (R5a-5, O48, O73).
    return Option.isNone(bound)
      ? { actor, workloadKeys: NO_WORKLOADS, workloadRegistryUnavailable: true }
      : { actor, workloadKeys: bound.value, workloadRegistryUnavailable: false };
  });

  /** One scope read per distinct company context of a group, never one per entry (O66). */
  const scopeReadsOf = Effect.fn('AccessDecisionGate.scopeReads')(function* scopeReadsEffect(params: {
    readonly actor: GateActor | undefined;
    readonly gateScopes: readonly (LegalEntityId | undefined)[];
    readonly scope: OperationalScope;
  }) {
    const { actor, scope } = params;
    // A workload holds no membership to read: its own path decides it by its binding alone (O73).
    if (actor === undefined || isWorkloadPrincipalKind(actor.kind)) {
      return new Map<string, GatePreamble>();
    }
    const holders = memberHoldersOf(actor);
    const distinct = new Map<string, LegalEntityId | undefined>();
    for (const legalEntityId of params.gateScopes) {
      distinct.set(legalEntityId ?? '', legalEntityId);
    }
    const entries = [...distinct.entries()];
    const reads = yield* Effect.forEach(
      entries,
      ([, legalEntityId]) => resolveGateScope(scope, legalEntityId, holders),
      { concurrency: 4 },
    );
    const preambles = new Map<string, GatePreamble>();
    for (const [index, [key]] of entries.entries()) {
      const read = reads[index];
      if (read !== undefined) {
        preambles.set(key, read);
      }
    }
    return preambles;
  });

  /** One group's seam answers: the actor, the scope reads, then each entry's own refusal or batch. */
  const prepareGroup = Effect.fn('AccessDecisionGate.prepareGroup')(function* prepareGroupEffect(params: {
    readonly group: GateGroup;
    readonly input: readonly GateInput[];
  }) {
    const { group, input } = params;
    const { scope } = group;
    const gate = yield* actorGateOf({ group, input, scope });
    const gateScopes = group.indexes.flatMap((index) => {
      const one = input[index];
      if (one === undefined) {
        return [];
      }
      if (gate.calledBy !== undefined) {
        return [gateScopeOf(one.legalEntityScope, scope).legalEntityId];
      }
      return one.carrier.accessDeclaration === undefined
        ? []
        : [gateScopeOf(one.legalEntityScope, scope).legalEntityId];
    });
    const preambles = yield* scopeReadsOf({ actor: gate.actor, gateScopes, scope });
    const prepared = group.indexes.map((index): GatePrepared => {
      const one = input[index];
      if (one === undefined) {
        return { decision: seamUnavailable(IDENTITY_UNAVAILABLE) };
      }
      if (gate.calledBy !== undefined) {
        return prepareDelegatedEntry({
          gate: one,
          group: {
            actor: gate.actor,
            calledBy: gate.calledBy,
            subjectDecision: gate.subjectDecision,
            workloadKeys: gate.workloadKeys,
            workloadRegistryUnavailable: gate.workloadRegistryUnavailable,
          },
          index,
          preambles,
          scope,
        });
      }
      if (one.carrier.accessDeclaration === undefined && one.carrier.accessWorkload === undefined) {
        // A protected entrypoint without a non-delegated carrier never becomes an implicit allow (O62). It is
        // refused before any identity answer, exactly as `preambleOf` refuses it.
        return { decision: seamRefusal(DECLARATION_MISSING) };
      }
      return gate.actor === undefined
        ? { decision: gate.decision ?? seamUnavailable(IDENTITY_UNAVAILABLE) }
        : prepareEntry({
            actor: gate.actor,
            gate: one,
            index,
            preambles,
            scope,
            workloadKeys: gate.workloadKeys ?? NO_WORKLOADS,
            workloadRegistryUnavailable: gate.workloadRegistryUnavailable ?? false,
          });
    });
    const entries = prepared.flatMap(({ entry }) => (entry === undefined ? [] : [entry]));
    const evidence = prepared.flatMap(({ evidenced }) => (evidenced === undefined ? [] : [evidenced]));
    const decisions = new Map<number, AccessDecision>();
    for (const [position, item] of prepared.entries()) {
      const index = group.indexes[position];
      if (index !== undefined && item.decision !== undefined) {
        decisions.set(index, item.decision);
      }
    }
    return entries.length === 0 ? { decisions, evidence } : { batch: { entries, scope }, decisions, evidence };
  });

  /** The evidence row of one batched request; a refusal decided before the engine writes none. */
  const recordOne = (params: {
    readonly answers: ReadonlyMap<number, AccessDecision>;
    readonly index: number;
    readonly one: GateInput;
    readonly reached: ReadonlyMap<number, BatchedGate>;
  }): Effect.Effect<AccessDecision> => {
    const decision = params.answers.get(params.index) ?? seamUnavailable(IDENTITY_UNAVAILABLE);
    const entry = params.reached.get(params.index);
    return entry === undefined
      ? Effect.succeed(decision)
      : recordDecision({
          actor: entry.actor,
          capability: entry.capability,
          decision,
          delegation: entry.delegation,
          entry: withOptional(
            withOptional(
              { mode: entry.mode, scope: params.one.scope, scopeId: entry.scopeId },
              'onBehalfOfPrincipalId',
              params.one.onBehalfOfPrincipalId,
            ),
            'target',
            params.one.target,
          ),
          now: params.one.now,
        });
  };

  /**
   * Many protected requests, one answer each: navigation and search providers ask this once per
   * page. The actor, the scope and the intent are resolved once per distinct scope, and every
   * request's items travel in ONE engine snapshot (CUTOVER-PLAN §5.3 risk 6).
   */
  const decideMany = Effect.fn('AccessDecisionGate.decideMany')(function* decideManyGate(input: readonly GateInput[]) {
    const groups = gateGroupsOf(input);
    const prepared = yield* Effect.forEach(groups, (group) => prepareGroup({ group, input }), { concurrency: 4 });
    const batches = prepared.flatMap(({ batch }) => (batch === undefined ? [] : [batch]));
    const decided = yield* decideAccessMany(
      ports.check,
      batches.map(({ entries, scope }) => ({
        authority: ports.authorityFor(scope),
        inputs: entries.map(({ actor, capability, gate, legalEntityId, mode }) => ({
          actor: actorInputOf(scope, legalEntityId, actor),
          now: gate.now,
          request: withOptional(
            withOptional(withOptional({ capability, mode }, 'amount', gate.amount), 'target', gate.target),
            'parentRead',
            gate.parentRead,
          ),
        })),
      })),
    );
    const answers = new Map<number, AccessDecision>(prepared.flatMap(({ decisions }) => [...decisions.entries()]));
    const reached = new Map<number, BatchedGate>([
      ...batches.flatMap(({ entries }) => entries.map((entry) => [entry.index, entry] as const)),
      ...prepared.flatMap(({ evidence }) => evidence.map((entry) => [entry.index, entry] as const)),
    ]);
    for (const [groupIndex, batch] of batches.entries()) {
      const groupAnswers = decided[groupIndex] ?? [];
      for (const [entryIndex, entry] of batch.entries.entries()) {
        const decision = groupAnswers[entryIndex];
        if (decision !== undefined) {
          answers.set(entry.index, decision);
        }
      }
    }
    return yield* Effect.forEach(input, (_one, index) => recordOne({ answers, index, one: _one, reached }), {
      concurrency: 1,
    });
  });

  return {
    decide,
    decideMany,
    list,
    // The same seam over other ports (O75): a transaction-aware binding rebinds the gate to ports
    // that join the caller's transaction instead of opening a second connection.
    rebind: (nextPorts: AccessDecisionPorts) => makeAccessDecisionService(nextPorts),
    selectableLegalEntities,
  };
};

/**
 * The live seam the runtime swaps in for `ActionPermissionLive` + `ContextAccessLive`: the ports are
 * composed once here, so a caller never passes one (CUTOVER-PLAN §3.1 step 8).
 */
export const AccessDecisionLive: Layer.Layer<
  AccessDecisionGate,
  never,
  AccessDecisionLog | AccessIntent | AccessPrincipalKindSource | DecisionCheck | LegalEntityCandidates
> = Layer.effect(
  AccessDecisionGate,
  Effect.gen(function* accessDecisionLive() {
    const [intent, decisionLog, principalKinds, check, legalEntities] = yield* Effect.all(
      [AccessIntent, AccessDecisionLog, AccessPrincipalKindSource, DecisionCheck, LegalEntityCandidates] as const,
      { concurrency: 5 },
    );
    // The registry is resolved where it is provided, never required: a composition that only ever
    // decides human or agent requests is complete without one, and a workload then fails closed (O73).
    const workloadBindings = yield* Effect.serviceOption(AccessWorkloadBindingSource);
    return makeAccessDecisionService(
      withOptional(
        { authorityFor: intent.authorityFor, check, decisionLog, legalEntities, principalKinds },
        'workloadBindings',
        Option.getOrUndefined(workloadBindings),
      ),
    );
  }),
);
