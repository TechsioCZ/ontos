import type { PrivacyDispatchLiveness } from './privacy-dispatch-liveness.ts';
import { Context } from 'effect';
import type { Effect } from 'effect';

import type { DeclaredAccessCarrier } from '../../authorization/access-declaration.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityScope } from '../../operations/legal-entity-scope.ts';
import type { DecisionAuthorityPort } from '../decision/authority.ts';
import type { AccessAmount, AccessDecision, AccessRecordTarget, ParentReadRequirement } from '../decision/contract.ts';
import type { DecisionCheckPort, ListAccessResolution } from '../decision/engine.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import type { LegalEntityId, PrincipalId } from '../ids.ts';
import type { AccessPrincipalKinds } from './actor.ts';
import type { AccessDecisionLogWriter } from './decision-log.ts';
import type { AccessDecisionLogBatchWriter } from './decision-log-batch.ts';
import type { AccessLegalEntityCandidates } from './legal-entities.ts';
import type { AccessWorkloadBindings } from './workload-port.ts';

/**
 * The enforcement seam is the one place a protected entrypoint asks whether this request may run.
 * It is deliberately narrow: every caller hands it trusted context, the entrypoint's own access
 * carrier and the facts of the request, and it answers with the same `AccessDecision` the engine
 * returns for every other path (single check, list, field, export, explain).
 */

/** `approve` exists only for executing a mandate; every other path runs (O56, O63). */
export const GATE_MODES = ['approve', 'propose', 'run'] as const;
export type GateMode = (typeof GATE_MODES)[number];

/**
 * The seam's own refusals: the cases where no v2 question can be asked at all. They are denials,
 * never an allow, and they are decided before the engine is read (O29, O59, O62, O67-Q5).
 */
export const GATE_REFUSAL_CODES = [
  /** A protected descriptor reached the gate without any carrier: never an implicit allow (O62). */
  'deny.declaration_missing',
  /** The acting principal has no `core.principals` kind, so it is not a verified human (O46). */
  'deny.principal_kind_forbidden',
  /** An agent reached a capability no agent may use, or a workload reached an admin declaration (O81). */
  'deny.agent_forbidden',
  /** A trusted workload reached a declaration carrier: workloads are never granted (O29, O59). */
  'deny.workload_forbidden',
  /** A workload kind reached a workload carrier with no active binding for one of its keys (O73). */
  'deny.workload_unbound',
  /** A human or agent reached a workload carrier: a v2 decision never admits one (O59, O67-Q4). */
  'deny.workload_only',
  /** A calling module reached a carrier that declares no `accessActor`: no module call is admitted (D6). */
  'deny.actor_forbidden',
  /** The calling module is not one of the `accessActor.callers` of this carrier (D6). */
  'deny.actor_unbound',
  /** The subject a module call is done for is not a verified human: no module call is admitted (D6). */
  'deny.actor_subject_invalid',
] as const;
export type GateRefusalCode = (typeof GATE_REFUSAL_CODES)[number];

/**
 * The access carrier of the entrypoint under enforcement: the decoded declaration or the workload
 * marker, exactly as the descriptor was validated at definition time (O5, O58, O59).
 */
export interface GateCarrier {
  readonly accessActor?: DeclaredAccessCarrier['accessActor'];
  readonly accessDeclaration?: DeclaredAccessCarrier['accessDeclaration'];
  readonly accessWorkload?: DeclaredAccessCarrier['accessWorkload'];
  readonly entrypoint?: { readonly entrypointKey: string };
  readonly schemaVersion?: string;
}

/** One enforcement question about one protected entrypoint. */
export interface GateInput {
  /** The governed money value, already read from `amountInput` or an owner resolver (O18). */
  readonly amount?: AccessAmount;
  readonly carrier: GateCarrier;
  /** The entrypoint's own declared scope, used to pick the v2 scope (O7, O12, O28). */
  readonly legalEntityScope: LegalEntityScope;
  /** Defaults to `run`; explicit proposal proofs use `propose`, approved execution uses `approve`. */
  readonly mode?: GateMode;
  /** Core-minted transaction time; no decision path reads the clock on its own (D6). */
  readonly now: Date;
  /**
   * The person who asked for this decision when it is not the evaluated actor (O86): the "Proč?"
   * administrator explaining somebody else's decision passes its own id here, so the recorded
   * evidence separates "explained about X" from "X acted".
   */
  readonly onBehalfOfPrincipalId?: PrincipalId;
  /** The parent record read a field capability requires (D14). */
  readonly parentRead?: ParentReadRequirement;
  /** The trusted principal, tenant and optional legal entity of this request (O66). */
  readonly scope: OperationalScope;
  /** Required exactly when the declaration names record selectors (O9, O27). */
  readonly target?: AccessRecordTarget;
}

/** The same question for a list, search or history page: the owner filters rows itself (D16, O25). */
export interface ListGateInput {
  readonly carrier: GateCarrier;
  readonly legalEntityScope: LegalEntityScope;
  readonly now: Date;
  readonly scope: OperationalScope;
}

export interface SelectableLegalEntitiesInput {
  readonly now: Date;
  readonly scope: OperationalScope;
}

/**
 * The ports one gate instance is built from; the composition resolves them and the binding may rebind
 * them to a caller's transaction (O75).
 */
export interface AccessDecisionPorts {
  /** Core's source of access intent, built for the request scope a decision runs in (O66). */
  readonly authorityFor: (scope: OperationalScope) => DecisionAuthorityPort;
  /** The one engine port: one `CheckBulkPermissions` snapshot per decision. */
  readonly check: DecisionCheckPort;
  /** "Proč?" evidence for denials, approvals and allowed sensitive or critical work. */
  readonly decisionLog: AccessDecisionLogWriter;
  /**
   * The same evidence rows of one `decideMany`, written in one transaction per request scope. A composition that
   * omits it, such as a binding that writes into a caller's own transaction, writes each row through `decisionLog`.
   */
  readonly decisionLogBatch?: AccessDecisionLogBatchWriter;
  /** The tenant's companies, before the `select` check narrows them. */
  readonly legalEntities: AccessLegalEntityCandidates;
  /** The acting principal's `core.principals.kind`. */
  readonly principalKinds: AccessPrincipalKinds;
  readonly privacyDispatchLiveness?: PrivacyDispatchLiveness;
  /**
   * The registered workload identities of the acting principal (O73). A composition that omits the
   * registry admits no workload at all: the seam answers UNAVAILABLE rather than guessing a binding.
   */
  readonly workloadBindings?: AccessWorkloadBindings;
}

/**
 * The one enforcement surface every protected entrypoint uses (CUTOVER-PLAN §3.1).
 *
 * `decideMany` answers many declarations for one actor: navigation and search providers ask it in
 * one call so a page composition does not become a request per button.
 */
export interface AccessDecisionService {
  readonly decide: (input: GateInput) => Effect.Effect<AccessDecision>;
  readonly decideMany: (input: readonly GateInput[]) => Effect.Effect<readonly AccessDecision[]>;
  readonly list: (input: ListGateInput) => Effect.Effect<ListAccessResolution>;
  /**
   * The same seam over other ports (O75): a transaction-aware binding rebinds the gate to ports that
   * join the caller's transaction instead of opening a second connection. A gate that carries no ports
   * of its own (a scripted double) leaves it out, and the binding keeps the gate it was given.
   */
  readonly rebind?: (ports: AccessDecisionPorts) => AccessDecisionService;
  /**
   * The companies whose context this actor may select (`access_legal_entity#select`, O28). An
   * unreadable authority is a typed failure so the caller answers a retryable 503, never "none".
   */
  readonly selectableLegalEntities: (
    input: SelectableLegalEntitiesInput,
  ) => Effect.Effect<readonly LegalEntityId[], AccessDecisionUnavailable>;
}

/** The runtime binds the seam through this service tag and `AccessDecisionLive`. */
export class AccessDecisionGate extends Context.Service<AccessDecisionGate, AccessDecisionService>()(
  '@app/core-runtime/access/enforcement/contract/AccessDecisionGate',
) {}
