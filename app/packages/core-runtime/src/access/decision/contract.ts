import type { Array as Arr } from 'effect';

import type {
  AccessScopeId,
  CapabilityKey,
  DelegationId,
  ModuleKey,
  PrincipalId,
  RecordKey,
  RoleId,
  RoleRevisionId,
} from '../ids.ts';
import type {
  AccessKind,
  AccessMode,
  AccessRisk,
  AuthorityWitness,
  CellSelector,
  DecisionOutcome,
  DecisionReason,
  RecordSelector,
} from '../model.ts';

/**
 * Reason vocabulary of the single decision function. Every code is stable and machine-readable;
 * product wording lives in the UI, never here.
 */
export const DECISION_REASON_CODES = [
  'allow.granted',
  'approval.required',
  'deny.agent_forbidden',
  'deny.agent_sensitive_read',
  'deny.amount_exceeds_ceiling',
  'deny.amount_required',
  'deny.caveat_indeterminate',
  'deny.connection_ceiling',
  'deny.connection_inactive',
  'deny.consent_stale',
  'deny.deadline_passed',
  'deny.declaration_missing',
  'deny.insufficient_grant',
  'deny.mode_unsupported',
  'deny.parent_read_required',
  'deny.principal_kind_forbidden',
  'deny.scope_mismatch',
  'deny.target_required',
  'deny.workload_forbidden',
  'deny.workload_only',
  'structural.owner',
  'structural.access_admin',
  'structural.access_admin_any',
  'structural.delegation',
  'structural.member_baseline',
  'unavailable.engine',
  'unavailable.evidence',
  'unavailable.indeterminate',
  'unavailable.intent',
] as const;
export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

/**
 * The declaration half the decision function needs. It is derived from a published or unpublished
 * `accessDeclaration` and never grants anything by itself (art. guarantee 2).
 */
export interface DecisionCapabilityPolicy {
  /**
   * The declaration of an administration SURFACE (O88), carried only by an admin page: in the tenant
   * context it admits a person who administers access in at least one company of this tenant, and it
   * admits nothing else. Absent on every operation, so no mutation, tenant role or owner command can
   * inherit the admission.
   */
  readonly admitsAdminSurface?: true;
  /**
   * Baseline access (the Shell frame, `AccessDeclaration.baseline`): a person whose Roles do not grant it still gets it
   * as a member of the asked scope, which the graph proves. It is never a role cell and never admits anything else.
   */
  readonly baseline?: true;
  readonly capabilityKey: CapabilityKey;
  /** `ephemeral` actions cannot wait for approval and are never proposable (O22). */
  readonly ephemeral?: boolean;
  readonly fieldClass?: string;
  readonly kind: AccessKind;
  readonly modes: readonly AccessMode[];
  readonly risk: AccessRisk;
  /** Record scopes the owner supports; `[]` means the capability is not record-scoped. */
  readonly selectors: readonly RecordSelector[];
}

/** One scalar money value of the governed command, in minor units (O18). */
export interface AccessAmount {
  readonly currency: string;
  readonly minor: number;
}

/**
 * One business record of the request, named inside the scope the decision was resolved in.
 *
 * The owner contract is that the target is loaded inside the resolved scope: the engine names the
 * record as the projection does (`recordObjectId(tenantId, scopeId, moduleKey, recordKey)`), so a
 * raw record key can never point a target check at another tenant's, scope's or module's record
 * (guarantee 3, D29, D32, O9). The module key is the record's own owning module, never derived
 * from the capability key text (O27).
 */
export interface AccessRecordTarget {
  readonly moduleKey: ModuleKey;
  readonly recordKey: RecordKey;
}

/** Two record targets are the same record only when tenant scope, module and key all agree. */
export const sameRecord = (left: AccessRecordTarget, right: AccessRecordTarget): boolean =>
  left.moduleKey === right.moduleKey && left.recordKey === right.recordKey;

/**
 * Field classes require the parent read as well (D14, O74). The parent read is the capability of the
 * declaration the field group belongs to: on a record-scoped entrypoint that is one record, and on a
 * scope-wide entrypoint (`selectors: []`) it is the same capability decided scope-wide in the same
 * scope, in the same engine snapshot.
 */
export interface ParentReadRequirement {
  /**
   * The amount the parent capability's own decision was evaluated against, such as an Action's
   * governed purchase value. An amount-capped parent grant is held to it here exactly as there;
   * absent, a capped parent grant is refused as `deny.amount_required`.
   */
  readonly amount?: AccessAmount;
  readonly capability: DecisionCapabilityPolicy;
  /**
   * The one record whose read justifies this field access. Absent exactly when the parent capability
   * is itself scope-wide (O74); an entrypoint that names a record must name it here too.
   */
  readonly target?: AccessRecordTarget;
}

export interface AccessDecisionRequest {
  readonly amount?: AccessAmount;
  readonly capability: DecisionCapabilityPolicy;
  readonly mode: AccessMode;
  readonly parentRead?: ParentReadRequirement;
  readonly target?: AccessRecordTarget;
}

/** The exact authority that justified one part of a decision, for reasons and "Proč?". */
export interface GrantedAuthorityEvidence {
  readonly assignedAt: Date;
  readonly assignedBy: PrincipalId;
  readonly deadline?: Date;
  readonly mode: AccessMode;
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
  readonly selector: CellSelector['_tag'];
  /** Whose cell this is: the person's own authority or the agent's own authority. */
  readonly side: 'agent' | 'principal';
  /** The exact assignment incarnation and grant cell, reusable by a proposal or mandate (D30). */
  readonly witness: AuthorityWitness;
}

export interface StructuralAuthorityEvidence {
  /**
   * The exact management path. `access_admin_any` is O88's surface admission: live access-admin power
   * in at least one company, used to enter the administration surface in the tenant context and
   * never to reach a company's data or roles, which are decided in that company's own scope.
   */
  readonly basis: 'owner' | 'access_admin' | 'access_admin_any' | 'delegation' | 'member_baseline';
  readonly deadline?: Date;
  readonly delegationId?: DelegationId;
  readonly scopeId: AccessScopeId;
}

export interface ResolvedRecordSelector {
  readonly recordKeys?: Arr.NonEmptyReadonlyArray<RecordKey>;
  readonly selector: CellSelector['_tag'];
  /**
   * Whose cell proved this selector. Selectors of different sides are a conjunction: an agent acts
   * only within the intersection of the person's and the agent's authority (D22), so a caller must
   * apply every side's selector, never merge the list into one wider filter (L3).
   */
  readonly side: 'agent' | 'principal';
}

/**
 * The one result every decision path returns: single checks, lists, fields, exports, explain and
 * the agent's tool list all ask the same question and read the same answer (D13, D22).
 */
export interface AccessDecision {
  /** Minimum over every end date on the path actually used; Core enforces it independently (D6). */
  readonly admissionDeadline?: Date;
  readonly evidence: readonly GrantedAuthorityEvidence[];
  readonly outcome: DecisionOutcome;
  readonly reasons: Arr.NonEmptyReadonlyArray<DecisionReason>;
  readonly selectors: readonly ResolvedRecordSelector[];
  /** A live configure basis admitted this admin key independently of role cells (O81). */
  readonly structuralEvidence?: StructuralAuthorityEvidence;
}

export const decisionReason = (code: DecisionReasonCode, extra?: Omit<DecisionReason, 'code'>): DecisionReason => ({
  ...extra,
  code,
});

/** UNAVAILABLE is a retryable 503 and never a denial; both denial outcomes answer 403. */
export const decisionHttpStatus = (outcome: DecisionOutcome): 200 | 403 | 503 => {
  if (outcome === 'ALLOWED') {
    return 200;
  }
  return outcome === 'UNAVAILABLE' ? 503 : 403;
};

/** True exactly when the outcome carries authority; UNAVAILABLE is not a denial but grants nothing. */
export const allowsExecution = (outcome: DecisionOutcome): boolean => outcome === 'ALLOWED';

export const earliestDeadline = (dates: readonly (Date | undefined)[]): Date | undefined => {
  let earliest: Date | undefined;
  for (const date of dates) {
    if (date !== undefined && (earliest === undefined || date < earliest)) {
      earliest = date;
    }
  }
  return earliest;
};
