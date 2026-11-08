import { DateTime, Match, Predicate, Schema } from 'effect';

import {
  AccessChangeBatchIdSchema,
  AccessChangeDecisionIdSchema,
  AccessChangeItemIdSchema,
  AccessOperationIdSchema,
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  CommandDigestSchema,
  CurrencyCodeSchema,
  DecisionLogIdSchema,
  DelegationIdSchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  RecordKeySchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  RoleTemplateKeySchema,
  TenantIdSchema,
} from './ids.ts';
import type { AccessScopeId, PrincipalId } from './ids.ts';
import { ActionAuthorityProofV2Schema } from './approvals/action-authority-v2-schema.ts';
import type { ActionAuthorityProofV2 } from './approvals/action-authority-v2-schema.ts';

/*
 * PostgreSQL is the source of access intent; SpiceDB is a projection written only by the Core
 * compiler. Decoding checks shape and record-local invariants. It never grants anything: catalog
 * membership, envelope containment and live state are checked by the compiler and decision engine.
 */

/** Rejects unknown keys so an extra holder, scope arm or witness cannot hide in decoded input. */
export const ACCESS_MODEL_PARSE_OPTIONS = { onExcessProperty: 'error' } as const;

export const AccessModeSchema = Schema.Literals(['run', 'propose', 'approve']);
export type AccessMode = typeof AccessModeSchema.Type;
export const AccessRiskSchema = Schema.Literals(['routine', 'sensitive', 'critical']);
export type AccessRisk = typeof AccessRiskSchema.Type;
export const AccessKindSchema = Schema.Literals(['action', 'read', 'field_read', 'field_write', 'export', 'admin']);
export type AccessKind = typeof AccessKindSchema.Type;
export const RecordSelectorSchema = Schema.Literals(['all', 'assigned', 'entrusted', 'team']);
export type RecordSelector = typeof RecordSelectorSchema.Type;
export const PlacementLevelSchema = Schema.Literals(['basic', 'extended', 'manage']);
export type PlacementLevel = typeof PlacementLevelSchema.Type;
/** Assignments, delegations and connections only ever end; none of them is reopened. */
export const LifecycleStatusSchema = Schema.Literals(['active', 'revoked', 'expired']);
export type LifecycleStatus = typeof LifecycleStatusSchema.Type;

const LabelSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const RevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
const ReasonCodeSchema = Schema.String.check(Schema.isMaxLength(120), Schema.isPattern(/^[a-z][a-z0-9_.]*$/u));
/** The request correlation id from `OperationalScope`. */
const CorrelationIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('CorrelationId'),
);
/** Opaque SpiceDB ZedToken of the projection write. */
const ProjectionTokenSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)).pipe(
  Schema.brand('AccessProjectionToken'),
);
const ActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ActionInvocationId'));

const boundedPeriod = Schema.makeFilter<{ readonly validFrom: Date; readonly validUntil: Date }>(
  ({ validFrom, validUntil }) => validFrom < validUntil || 'validUntil must follow validFrom',
);

/** A selector narrows the records a cell reaches; `targets` names explicit records of one scope. */
export const CellSelectorSchema = Schema.Union([
  Schema.TaggedStruct('all', {}),
  Schema.TaggedStruct('assigned', {}),
  Schema.TaggedStruct('entrusted', {}),
  Schema.TaggedStruct('team', {}),
  Schema.TaggedStruct('targets', { recordKeys: Schema.NonEmptyArray(RecordKeySchema).check(Schema.isUnique()) }),
]);
export type CellSelector = typeof CellSelectorSchema.Type;
/** Mirrors the `amount_ceiling` caveat: one currency, inclusive minor-unit limit. */
export const AmountCeilingSchema = Schema.Struct({
  currency: CurrencyCodeSchema,
  limitMinor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AmountCeiling = typeof AmountCeilingSchema.Type;
/** One exact permission cell: capability x mode x selector, optionally capped by an amount. */
export const CellSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(AmountCeilingSchema),
  capabilityKey: CapabilityKeySchema,
  mode: AccessModeSchema,
  selector: CellSelectorSchema,
});
export type Cell = typeof CellSchema.Type;
/** Grant slot identity; explicit targets of one capability and mode share one slot. */
export const cellSlotKey = (cell: Cell): string => `${cell.capabilityKey} ${cell.mode} ${cell.selector._tag}`;
const uniqueCellSlots = Schema.makeFilter<{ readonly cells: readonly Cell[] }>(
  ({ cells }) =>
    new Set(cells.map(cellSlotKey)).size === cells.length || 'Each capability, mode and selector slot occurs once',
);

const FIELD_GROUP_KINDS: ReadonlySet<AccessKind> = new Set(['field_read', 'field_write'] as const);

/**
 * A field group is a capability of its own, but its access rides the read it belongs to (D14, O58,
 * O74). The release therefore names that parent, so a consumer of the catalog — "Proč?", Novinky, the
 * role editor — decides the parent read from the released catalog itself and never from a caller.
 */
const catalogEntryParentIssue = (entry: {
  readonly key: string;
  readonly kind: AccessKind;
  readonly parentKey?: string;
}): string | undefined => {
  if (!FIELD_GROUP_KINDS.has(entry.kind)) {
    return entry.parentKey === undefined ? undefined : `${entry.key} is not a field group and declares no parentKey`;
  }
  if (entry.parentKey === undefined) {
    return `${entry.key} is a field group and must name the parent capability it belongs to (O87)`;
  }
  return entry.parentKey === entry.key ? `${entry.key} cannot be its own parent capability` : undefined;
};

/**
 * The release carries the whole decision half of a capability (CUTOVER-PLAN §3.1 step 3), so a consumer
 * never re-derives a policy input: an ephemeral proof is run-only and Action-only (O22), and a release
 * that says otherwise is refused rather than summarised.
 */
const catalogEntryEphemeralIssue = (entry: {
  readonly ephemeral?: true;
  readonly key: string;
  readonly kind: AccessKind;
  readonly modes: readonly AccessMode[];
}): string | undefined => {
  if (entry.ephemeral !== true) {
    return undefined;
  }
  if (entry.kind !== 'action') {
    return `${entry.key} is not an Action and cannot be ephemeral (O22)`;
  }
  return entry.modes.length === 1 && entry.modes[0] === 'run'
    ? undefined
    : `${entry.key} is ephemeral and supports only run mode (O22)`;
};

export const CatalogSnapshotEntrySchema = Schema.Struct({
  amountInput: Schema.optionalKey(LabelSchema),
  /** Present only for a short-lived proof that cannot wait for an approval (O22). */
  ephemeral: Schema.optionalKey(Schema.Literal(true)),
  fieldClass: Schema.optionalKey(LabelSchema),
  key: CapabilityKeySchema,
  kind: AccessKindSchema,
  lineage: Schema.optionalKey(
    Schema.Struct({
      renamedFrom: Schema.optionalKey(Schema.NonEmptyArray(CapabilityKeySchema).check(Schema.isUnique())),
      splitFrom: Schema.optionalKey(CapabilityKeySchema),
    }),
  ),
  modes: Schema.NonEmptyArray(AccessModeSchema).check(Schema.isUnique()),
  moduleKey: ModuleKeySchema,
  /** The containing declaration of a field group; present exactly for `field_read`/`field_write`. */
  parentKey: Schema.optionalKey(CapabilityKeySchema),
  placement: Schema.Struct({ group: LabelSchema, level: PlacementLevelSchema }),
  risk: AccessRiskSchema,
  selectors: Schema.Array(RecordSelectorSchema).check(Schema.isUnique()),
}).check(Schema.makeFilter(catalogEntryParentIssue), Schema.makeFilter(catalogEntryEphemeralIssue));
export type CatalogSnapshotEntry = typeof CatalogSnapshotEntrySchema.Type;

/** The release is closed: a field group's parent is one of its own entries, never a missing key. */
const catalogParentIssue = ({ entries }: { readonly entries: readonly CatalogSnapshotEntry[] }): string | undefined => {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  for (const entry of entries) {
    const { parentKey } = entry;
    if (parentKey === undefined) {
      continue;
    }
    const parent = byKey.get(parentKey);
    if (parent === undefined) {
      return `${entry.key} names parent capability ${parentKey}, which this release does not contain`;
    }
    if (FIELD_GROUP_KINDS.has(parent.kind)) {
      return `${entry.key} names parent capability ${parentKey}, which is itself a field group`;
    }
  }
  return undefined;
};

/** Immutable release catalog. Role revisions pin one snapshot; new keys never join a level silently. */
export const CatalogSnapshotSchema = Schema.Struct({
  digest: CatalogDigestSchema,
  entries: Schema.Array(CatalogSnapshotEntrySchema),
  id: CatalogSnapshotIdSchema,
  publishedAt: Schema.Date,
}).check(
  Schema.makeFilter(
    (snapshot: { readonly entries: readonly CatalogSnapshotEntry[] }) =>
      new Set(snapshot.entries.map(({ key }) => key)).size === snapshot.entries.length || 'Catalog keys are unique',
  ),
  Schema.makeFilter(catalogParentIssue),
);
export type CatalogSnapshot = typeof CatalogSnapshotSchema.Type;

/** Exactly one context. A tenant context is explicit, never a missing legal entity. */
export const AccessScopeSchema = Schema.Union([
  Schema.TaggedStruct('TenantContext', { tenantId: TenantIdSchema }),
  Schema.TaggedStruct('LegalEntity', { legalEntityId: LegalEntityIdSchema, tenantId: TenantIdSchema }),
]);
export type AccessScope = typeof AccessScopeSchema.Type;
export const AccessScopeRecordSchema = Schema.Struct({ id: AccessScopeIdSchema, scope: AccessScopeSchema });
export type AccessScopeRecord = typeof AccessScopeRecordSchema.Type;
export const HolderSchema = Schema.Union([
  Schema.TaggedStruct('Principal', { principalId: PrincipalIdSchema }),
  Schema.TaggedStruct('Agent', { agentId: AgentIdSchema }),
]);
export type Holder = typeof HolderSchema.Type;
/** An agent always acts for one person through one connection at one consent revision. */
export const ActorContextSchema = Schema.Union([
  Schema.TaggedStruct('Principal', { principalId: PrincipalIdSchema }),
  Schema.TaggedStruct('Agent', {
    agentId: AgentIdSchema,
    connectionId: AgentConnectionIdSchema,
    consentRevision: RevisionSchema,
    principalId: PrincipalIdSchema,
  }),
]);
export type ActorContext = typeof ActorContextSchema.Type;

export const RoleSchema = Schema.Struct({
  createdAt: Schema.Date,
  createdBy: PrincipalIdSchema,
  id: RoleIdSchema,
  /** Company-local variant: assignable only in this legal entity. */
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  name: LabelSchema,
  tenantId: TenantIdSchema,
});
export type Role = typeof RoleSchema.Type;
/**
 * `imported` is the legacy-grant baseline (O47): a role snapshotted from today's effective legacy
 * access. It never comes from a template, so it carries no template key, exactly like `manual`.
 */
export const RoleProvenanceSchema = Schema.Literals(['template', 'customer_changed', 'manual', 'imported']);
export type RoleProvenance = typeof RoleProvenanceSchema.Type;
/** Only the template-derived provenances name the template a revision was created from. */
export const TEMPLATE_ROLE_PROVENANCES = ['template', 'customer_changed'] as const;
export const namesRoleTemplate = (provenance: RoleProvenance): boolean =>
  TEMPLATE_ROLE_PROVENANCES.some((derived: RoleProvenance) => derived === provenance);
/** Immutable. An edit creates the next revision pinned to the catalog snapshot it was saved against. */
export const RoleRevisionSchema = Schema.Struct({
  catalogSnapshotId: CatalogSnapshotIdSchema,
  cells: Schema.Array(CellSchema),
  createdAt: Schema.Date,
  createdBy: PrincipalIdSchema,
  id: RoleRevisionIdSchema,
  provenance: RoleProvenanceSchema,
  revision: RevisionSchema,
  roleId: RoleIdSchema,
  templateKey: Schema.optionalKey(RoleTemplateKeySchema),
  tenantId: TenantIdSchema,
}).check(
  uniqueCellSlots,
  Schema.makeFilter(
    ({ provenance, templateKey }) =>
      namesRoleTemplate(provenance) === (templateKey !== undefined) ||
      'Exactly the template-derived revisions name a template',
  ),
);
export type RoleRevision = typeof RoleRevisionSchema.Type;

/** Limits frozen from the delegation that created an assignment; they outlive the delegation. */
export const DelegatedLimitsSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(AmountCeilingSchema),
  capabilityKeys: Schema.NonEmptyArray(CapabilityKeySchema).check(Schema.isUnique()),
  delegationId: DelegationIdSchema,
  until: Schema.Date,
});
export type DelegatedLimits = typeof DelegatedLimitsSchema.Type;
/**
 * One holder x role x scope x period. The incarnation id is never reused; a role edit re-points
 * `roleRevisionId` to a newer revision of the same role and keeps the incarnation.
 */
export const AssignmentSchema = Schema.Struct({
  assignedAt: Schema.Date,
  assignedBy: PrincipalIdSchema,
  delegated: Schema.optionalKey(DelegatedLimitsSchema),
  holder: HolderSchema,
  incarnationId: AssignmentIncarnationIdSchema,
  roleId: RoleIdSchema,
  roleRevisionId: RoleRevisionIdSchema,
  scopeId: AccessScopeIdSchema,
  status: LifecycleStatusSchema,
  tenantId: TenantIdSchema,
  validFrom: Schema.Date,
  validUntil: Schema.optionalKey(Schema.Date),
}).check(
  Schema.makeFilter(
    ({ validFrom, validUntil }) =>
      validUntil === undefined || validFrom < validUntil || 'validUntil must follow validFrom',
  ),
  Schema.makeFilter(
    ({ delegated, validUntil }) =>
      delegated === undefined ||
      (validUntil !== undefined && validUntil <= delegated.until) ||
      'A delegated assignment ends no later than its delegation',
  ),
);
export type Assignment = typeof AssignmentSchema.Type;
/** A bounded management envelope. The manager never manages themselves and never delegates further. */
export const DelegationSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(AmountCeilingSchema),
  capabilityKeys: Schema.NonEmptyArray(CapabilityKeySchema).check(Schema.isUnique()),
  grantedBy: PrincipalIdSchema,
  id: DelegationIdSchema,
  managerId: PrincipalIdSchema,
  people: Schema.NonEmptyArray(PrincipalIdSchema).check(Schema.isUnique()),
  roleIds: Schema.NonEmptyArray(RoleIdSchema).check(Schema.isUnique()),
  scopeId: AccessScopeIdSchema,
  status: LifecycleStatusSchema,
  tenantId: TenantIdSchema,
  validFrom: Schema.Date,
  validUntil: Schema.Date,
}).check(
  boundedPeriod,
  Schema.makeFilter(
    ({ grantedBy, managerId, people }) =>
      (grantedBy !== managerId && !people.includes(managerId)) ||
      'A delegation is never self-granted or self-assignable',
  ),
);
export type Delegation = typeof DelegationSchema.Type;

export const AccessChangeKindSchema = Schema.Literals(['new', 'renamed', 'split', 'removed', 'risk_changed']);
export type AccessChangeKind = typeof AccessChangeKindSchema.Type;
export const AccessChangeItemStatusSchema = Schema.Literals(['pending', 'adopted', 'declined', 'undone']);
export type AccessChangeItemStatus = typeof AccessChangeItemStatusSchema.Type;
/** A Novinky entry. Listing an item grants nothing; only an adoption decision changes roles. */
export const AccessChangeItemSchema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  catalogSnapshotId: CatalogSnapshotIdSchema,
  createdAt: Schema.Date,
  id: AccessChangeItemIdSchema,
  kind: AccessChangeKindSchema,
  lineageFrom: Schema.Array(CapabilityKeySchema).check(Schema.isUnique()),
  risk: AccessRiskSchema,
  status: AccessChangeItemStatusSchema,
  suggestedRoleIds: Schema.Array(RoleIdSchema).check(Schema.isUnique()),
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter(
    ({ kind, lineageFrom }) =>
      (kind === 'renamed' || kind === 'split') === lineageFrom.length > 0 ||
      'Exactly renamed and split items name a lineage',
  ),
);
export type AccessChangeItem = typeof AccessChangeItemSchema.Type;
export const AccessChangeDecisionKindSchema = Schema.Literals(['adopt', 'decline', 'undo']);
export type AccessChangeDecisionKind = typeof AccessChangeDecisionKindSchema.Type;
/** Append-only. An undo is a new decision producing new revisions; it never restores a revocation. */
export const AccessChangeDecisionSchema = Schema.Struct({
  batchId: AccessChangeBatchIdSchema,
  decidedAt: Schema.Date,
  decidedBy: PrincipalIdSchema,
  decision: AccessChangeDecisionKindSchema,
  id: AccessChangeDecisionIdSchema,
  itemId: AccessChangeItemIdSchema,
  roleRevisionIds: Schema.Array(RoleRevisionIdSchema).check(Schema.isUnique()),
  tenantId: TenantIdSchema,
  undoesDecisionId: Schema.optionalKey(AccessChangeDecisionIdSchema),
}).check(
  Schema.makeFilter(
    ({ decision, id, undoesDecisionId }) =>
      (decision === 'undo'
        ? undoesDecisionId !== undefined && undoesDecisionId !== id
        : undoesDecisionId === undefined) || 'Exactly undo decisions reference another decision',
  ),
  Schema.makeFilter(
    ({ decision, roleRevisionIds }) =>
      decision !== 'decline' || roleRevisionIds.length === 0 || 'A decline changes no role',
  ),
);
export type AccessChangeDecision = typeof AccessChangeDecisionSchema.Type;

export const ProposalStatusSchema = Schema.Literals([
  'pending',
  'approved',
  'executed',
  'lapsed',
  'rejected',
  'expired',
]);
export type ProposalStatus = typeof ProposalStatusSchema.Type;
const PROPOSAL_TRANSITIONS = {
  approved: ['executed', 'lapsed', 'expired'],
  executed: [],
  expired: [],
  lapsed: [],
  pending: ['approved', 'rejected', 'lapsed', 'expired'],
  rejected: [],
} as const satisfies Readonly<Record<ProposalStatus, readonly ProposalStatus[]>>;
/** Monotonic: terminal states have no exit, so reassignment or recovery never revives an approval. */
export const canTransitionProposalStatus = (from: ProposalStatus, to: ProposalStatus): boolean =>
  PROPOSAL_TRANSITIONS[from].some((next: ProposalStatus) => next === to);
export const WitnessPurposeSchema = Schema.Literals(['requester', 'approval', 'execution', 'parent_record_read']);
export type WitnessPurpose = typeof WitnessPurposeSchema.Type;
/**
 * A purpose names the mode the witness cell must be held in (R2-H1): a `propose`-mode grant can
 * never justify an approval or an execution, and a parent read is always a `run` read.
 */
export const WITNESS_PURPOSE_MODES = {
  approval: 'approve',
  execution: 'run',
  parent_record_read: 'run',
  requester: 'propose',
} as const satisfies Readonly<Record<WitnessPurpose, AccessMode>>;
export const witnessPurposeMode = (purpose: WitnessPurpose): AccessMode => WITNESS_PURPOSE_MODES[purpose];
/** The tagged holder of an actor: an agent is never folded into the person it acts for (guarantee 4). */
export const actorHolder = (actor: ActorContext): Holder =>
  Match.value(actor).pipe(
    Match.tag('Principal', ({ principalId }): Holder => ({ _tag: 'Principal', principalId })),
    Match.tag('Agent', ({ agentId }): Holder => ({ _tag: 'Agent', agentId })),
    Match.exhaustive,
  );
/** Total, tag-aware identity of a holder, so a person and an agent never collide. */
export const holderKey = (holder: Holder): string =>
  Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }) => `principal ${principalId}`),
    Match.tag('Agent', ({ agentId }) => `agent ${agentId}`),
    Match.exhaustive,
  );
export const sameHolder = (left: Holder, right: Holder): boolean => holderKey(left) === holderKey(right);
const principalHolder = (principalId: PrincipalId): Holder => ({ _tag: 'Principal', principalId });
/**
 * The exact assignment incarnation, holder, scope and grant cell that justified one part of a
 * proposal. Every field is frozen here because the same tuple is what the execution re-check
 * compares: the holder must still be the expected actor, in the proposal's own scope, holding the
 * cell in the mode the purpose requires (R2-H1, guarantee 5, O49, O52). Every purpose but the
 * requester's own authority belongs to the approving person (O63).
 */
export const AuthorityWitnessSchema = Schema.Struct({
  assignmentIncarnationId: AssignmentIncarnationIdSchema,
  capabilityKey: CapabilityKeySchema,
  grantIncarnationId: GrantIncarnationIdSchema,
  /** The holder the bound assignment belongs to; the requester's own holder for `requester`. */
  holderId: HolderSchema,
  mode: AccessModeSchema,
  purpose: WitnessPurposeSchema,
  /** The scope of both the assignment and the grant cell; never another legal entity (O49). */
  scopeId: AccessScopeIdSchema,
});
export type AuthorityWitness = typeof AuthorityWitnessSchema.Type;
/** "Approve and execute using my access": the approver is also the executor. */
const HistoricalApprovalSchema = Schema.Struct({
  approvalAssignmentIncarnationId: AssignmentIncarnationIdSchema,
  approvedAt: Schema.Date,
  approverId: PrincipalIdSchema,
  executionAssignmentIncarnationId: AssignmentIncarnationIdSchema,
  expiresAt: Schema.Date,
});
const ActionApprovalV2Schema = Schema.Struct({
  actionAuthority: ActionAuthorityProofV2Schema,
  approvedAt: Schema.Date,
  approverId: PrincipalIdSchema,
  expiresAt: Schema.Date,
});
export const ApprovalSchema = Schema.Union([HistoricalApprovalSchema, ActionApprovalV2Schema]);
export type Approval = typeof ApprovalSchema.Type;
export const ExecutionReceiptSchema = Schema.Struct({
  actionInvocationId: ActionInvocationIdSchema,
  executedAt: Schema.Date,
});
export type ExecutionReceipt = typeof ExecutionReceiptSchema.Type;

interface ProposalLifecycle {
  readonly approval?: Approval;
  readonly capabilityKey: string;
  readonly createdAt: Date;
  readonly endedAt?: Date;
  readonly execution?: ExecutionReceipt;
  readonly expiresAt: Date;
  readonly rejectedBy?: string;
  readonly status: ProposalStatus;
  readonly witnesses: readonly AuthorityWitness[];
}
const proposalEndIssue = ({
  approval,
  endedAt,
  execution,
  rejectedBy,
  status,
}: ProposalLifecycle): string | undefined => {
  if ((status === 'executed') !== (execution !== undefined)) {
    return 'Exactly executed proposals carry an execution receipt';
  }
  if (
    execution !== undefined &&
    approval !== undefined &&
    !(approval.approvedAt <= execution.executedAt && execution.executedAt < approval.expiresAt)
  ) {
    return 'Execution happens while the approval is live';
  }
  if ((status === 'rejected') !== (rejectedBy !== undefined)) {
    return 'Exactly rejected proposals name who rejected them';
  }
  if ((status === 'rejected' || status === 'lapsed' || status === 'expired') !== (endedAt !== undefined)) {
    return 'Exactly rejected, lapsed and expired proposals carry an end time';
  }
  return undefined;
};
const proposalLifecycleIssue = (proposal: ProposalLifecycle): string | undefined => {
  const { approval, createdAt, expiresAt, status } = proposal;
  if (createdAt >= expiresAt) {
    return 'A proposal needs a positive lifetime';
  }
  // Lapse and expiry can happen before or after approval; only those two states may go either way.
  const approvalRequired = status === 'approved' || status === 'executed';
  const approvalForbidden = status === 'pending' || status === 'rejected';
  if ((approvalRequired && approval === undefined) || (approvalForbidden && approval !== undefined)) {
    return 'Approved and executed proposals carry an approval; pending and rejected ones do not';
  }
  if (
    approval !== undefined &&
    !(createdAt <= approval.approvedAt && approval.approvedAt < expiresAt && approval.approvedAt < approval.expiresAt)
  ) {
    return 'An approval happens within the proposal lifetime and has a positive lifetime';
  }
  return proposalEndIssue(proposal);
};
interface WitnessScopeFacts {
  readonly actionAuthority?: ActionAuthorityProofV2;
  readonly approval?: Approval;
  readonly capabilityKey: string;
  readonly commandDigest: string;
  readonly expiresAt: Date;
  readonly requester: ActorContext;
  readonly scopeId: AccessScopeId;
  readonly target?: string;
  readonly witnesses: readonly AuthorityWitness[];
}
const proofDeadlineCovers = (proof: ActionAuthorityProofV2, deadline: Date): boolean =>
  proof.admissionDeadline === undefined ||
  DateTime.toEpochMillis(DateTime.makeUnsafe(deadline)) <= proof.admissionDeadline;

const sameForwardWriteQuestions = (requester: ActionAuthorityProofV2, approver: ActionAuthorityProofV2): boolean => {
  const requested = requester.questions.map(({ questionHash }) => questionHash).toSorted();
  const approved = approver.questions
    .flatMap(({ purpose, questionHash }) => (purpose === 'approve_write' ? [questionHash] : []))
    .toSorted();
  return requested.length === approved.length && requested.every((hash, index) => hash === approved[index]);
};

const forwardWitnessIssue = (facts: WitnessScopeFacts, requester: ActionAuthorityProofV2): string | undefined => {
  if (
    facts.witnesses.length !== 0 ||
    facts.target !== undefined ||
    requester.phase !== 'requester' ||
    !Predicate.isTagged(facts.requester, 'Principal') ||
    requester.principalId !== facts.requester.principalId ||
    requester.commandDigest !== facts.commandDigest ||
    requester.scopeId !== facts.scopeId ||
    !proofDeadlineCovers(requester, facts.expiresAt)
  ) {
    return 'A forward Action proposal binds its exact requester proof, digest, scope and deadline, never scalar witnesses';
  }
  const { approval } = facts;
  if (approval === undefined) {
    return undefined;
  }
  if (!('actionAuthority' in approval)) {
    return 'A forward Action proposal cannot acquire a historical execution/RUN approval';
  }
  const approver = approval.actionAuthority;
  return approver.phase === 'approver' &&
    approver.principalId === approval.approverId &&
    approver.scopeId === facts.scopeId &&
    approver.commandDigest === facts.commandDigest &&
    approver.targetSetHash === requester.targetSetHash &&
    sameForwardWriteQuestions(requester, approver) &&
    proofDeadlineCovers(approver, approval.expiresAt)
    ? undefined
    : 'A forward Action approval binds its exact approver, complete command, target set, scope and deadline';
};
/** Why the approving person's own authority is what an approved command needs, per purpose. */
const APPROVER_HOLDER_ISSUES = {
  approval: 'The approval witness belongs to the approver',
  execution: 'Only the approving human executes a mandate, so the execution witness belongs to the approver',
  parent_record_read: 'The parent record read belongs to the approver who executes the mandate',
} as const satisfies Readonly<Record<Exclude<WitnessPurpose, 'requester'>, string>>;
/** The holder a purpose must be held by, as far as the proposal record itself knows it. */
const holderIssue = (facts: WitnessScopeFacts, witness: AuthorityWitness): string | undefined => {
  if (witness.purpose === 'requester') {
    return sameHolder(witness.holderId, actorHolder(facts.requester))
      ? undefined
      : 'The requester witness belongs to the requester itself';
  }
  // An approver's authority is the approving person's own, and only a person's: a mandate exists for
  // sensitive and critical work, which an agent never runs, so neither the approver's agent nor the
  // requester's agent ever holds an execution witness (O63). A witness without an approval is
  // refused by `witnessIssue` below instead.
  if (facts.approval === undefined) {
    return undefined;
  }
  return sameHolder(witness.holderId, principalHolder(facts.approval.approverId))
    ? undefined
    : APPROVER_HOLDER_ISSUES[witness.purpose];
};
const witnessIssue = (facts: WitnessScopeFacts): string | undefined => {
  const { approval, capabilityKey, scopeId, witnesses } = facts;
  if (facts.actionAuthority !== undefined) {
    return forwardWitnessIssue(facts, facts.actionAuthority);
  }
  if (approval !== undefined && 'actionAuthority' in approval) {
    return 'A historical proposal cannot acquire a forward Action approval';
  }
  const slots = witnesses.map(
    (witness) => `${witness.purpose} ${witness.assignmentIncarnationId} ${witness.capabilityKey}`,
  );
  if (new Set(slots).size !== slots.length) {
    return 'Each witness slot occurs once';
  }
  const wrongMode = witnesses.find((witness) => witness.mode !== witnessPurposeMode(witness.purpose));
  if (wrongMode !== undefined) {
    return `A ${wrongMode.purpose} witness is held in the ${witnessPurposeMode(wrongMode.purpose)} mode`;
  }
  const foreignScope = witnesses.find((witness) => witness.scopeId !== scopeId);
  if (foreignScope !== undefined) {
    return 'Every witness is held in the scope of the proposal';
  }
  const wrongHolder = witnesses.find((witness) => holderIssue(facts, witness) !== undefined);
  if (wrongHolder !== undefined) {
    return holderIssue(facts, wrongHolder);
  }
  const bound = (purpose: WitnessPurpose, assignmentId?: string) =>
    witnesses.some(
      (witness) =>
        witness.purpose === purpose &&
        witness.capabilityKey === capabilityKey &&
        (assignmentId === undefined || witness.assignmentIncarnationId === assignmentId),
    );
  if (!bound('requester')) {
    return 'A proposal binds the requester authority it was made with';
  }
  if (approval === undefined) {
    return witnesses.some(({ purpose }) => purpose === 'approval' || purpose === 'execution')
      ? 'Only an approval binds approver witnesses'
      : undefined;
  }
  return bound('approval', approval.approvalAssignmentIncarnationId) &&
    bound('execution', approval.executionAssignmentIncarnationId)
    ? undefined
    : 'An approval binds the approver assignments and grant cells it relies on';
};
/**
 * An agent's or person's frozen request. Once a person approves it, the same record is the
 * mandate: bound to the exact approver and requester incarnations, single use, never revived.
 */
export const ProposalSchema = Schema.Struct({
  /** Forward proof only; historical rows keep their original immutable witness contract. */
  actionAuthority: Schema.optionalKey(ActionAuthorityProofV2Schema),
  approval: Schema.optionalKey(ApprovalSchema),
  capabilityKey: CapabilityKeySchema,
  commandDigest: CommandDigestSchema,
  createdAt: Schema.Date,
  endedAt: Schema.optionalKey(Schema.Date),
  execution: Schema.optionalKey(ExecutionReceiptSchema),
  expiresAt: Schema.Date,
  id: ProposalIdSchema,
  rejectedBy: Schema.optionalKey(PrincipalIdSchema),
  requester: ActorContextSchema,
  scopeId: AccessScopeIdSchema,
  status: ProposalStatusSchema,
  target: Schema.optionalKey(RecordKeySchema),
  tenantId: TenantIdSchema,
  witnesses: Schema.Array(AuthorityWitnessSchema),
}).check(Schema.makeFilter((proposal) => proposalLifecycleIssue(proposal) ?? witnessIssue(proposal) ?? true));
export type Proposal = typeof ProposalSchema.Type;
/** A mandate is a proposal a person approved. It executes at most once while every bound witness is live. */
export const MandateSchema = ProposalSchema.check(
  Schema.makeFilter(
    ({ approval, status }) =>
      (approval !== undefined && (status === 'approved' || status === 'executed')) ||
      'A mandate is an approved proposal',
  ),
);
/** What a connection lets an agent use, intersected with the person's and the agent's own grants. */
export const ConsentCeilingSchema = Schema.Struct({ cells: Schema.Array(CellSchema) }).check(uniqueCellSlots);
export type ConsentCeiling = typeof ConsentCeilingSchema.Type;
/** Read fresh on every decision; a new consent is a new revision and snapshot. */
export const AgentConnectionSchema = Schema.Struct({
  agentId: AgentIdSchema,
  id: AgentConnectionIdSchema,
  principalId: PrincipalIdSchema,
  revision: RevisionSchema,
  scopeId: AccessScopeIdSchema,
  status: LifecycleStatusSchema,
  tenantId: TenantIdSchema,
  validFrom: Schema.Date,
  validUntil: Schema.Date,
}).check(boundedPeriod);
export type AgentConnection = typeof AgentConnectionSchema.Type;
export const ScopeFenceStateSchema = Schema.Literals(['Ready', 'Changing', 'Unavailable']);
export type ScopeFenceState = typeof ScopeFenceStateSchema.Type;
/** One writer lock per scope, owned by the operation that took it. */
export const ScopeFenceSchema = Schema.Struct({
  owningOperationId: Schema.optionalKey(AccessOperationIdSchema),
  revision: RevisionSchema,
  scopeId: AccessScopeIdSchema,
  state: ScopeFenceStateSchema,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter(
    ({ owningOperationId, state }) =>
      (state === 'Ready') === (owningOperationId === undefined) || 'Exactly a held fence names its owning operation',
  ),
);
export type ScopeFence = typeof ScopeFenceSchema.Type;
export const OperationPhaseSchema = Schema.Literals(['validated', 'fenced', 'projected', 'committed', 'failed']);
export type OperationPhase = typeof OperationPhaseSchema.Type;
const OPERATION_PHASE_ORDER: readonly OperationPhase[] = ['validated', 'fenced', 'projected', 'committed'];
/** A retry resumes the same operation forward; committed and failed are terminal. */
export const canAdvanceOperationPhase = (from: OperationPhase, to: OperationPhase): boolean =>
  from !== 'committed' &&
  from !== 'failed' &&
  (to === 'failed' || OPERATION_PHASE_ORDER.indexOf(to) > OPERATION_PHASE_ORDER.indexOf(from));
export const OperationJournalSchema = Schema.Struct({
  commandDigest: CommandDigestSchema,
  failureCode: Schema.optionalKey(ReasonCodeSchema),
  operationId: AccessOperationIdSchema,
  phase: OperationPhaseSchema,
  projectionToken: Schema.optionalKey(ProjectionTokenSchema),
  scopeId: AccessScopeIdSchema,
  startedAt: Schema.Date,
  tenantId: TenantIdSchema,
  updatedAt: Schema.Date,
}).check(
  Schema.makeFilter(({ startedAt, updatedAt }) => startedAt <= updatedAt || 'Journal time never goes backwards'),
  Schema.makeFilter(
    ({ failureCode, phase }) =>
      (phase === 'failed') === (failureCode !== undefined) || 'Exactly failed operations carry a failure code',
  ),
  Schema.makeFilter(
    ({ phase, projectionToken }) =>
      !(phase === 'projected' || phase === 'committed') ||
      projectionToken !== undefined ||
      'A projected operation records its projection token',
  ),
);
export type OperationJournal = typeof OperationJournalSchema.Type;

export const DecisionOutcomeSchema = Schema.Literals(['ALLOWED', 'NEEDS_APPROVAL', 'DENIED', 'UNAVAILABLE']);
export type DecisionOutcome = typeof DecisionOutcomeSchema.Type;
export const DecisionReasonSchema = Schema.Struct({
  assignmentIncarnationId: Schema.optionalKey(AssignmentIncarnationIdSchema),
  capabilityKey: Schema.optionalKey(CapabilityKeySchema),
  code: ReasonCodeSchema,
  grantIncarnationId: Schema.optionalKey(GrantIncarnationIdSchema),
});
export type DecisionReason = typeof DecisionReasonSchema.Type;
/** Append-only evidence for "Proč?". An unavailable engine is logged as UNAVAILABLE, never as DENIED. */
export const DecisionLogSchema = Schema.Struct({
  actor: ActorContextSchema,
  admissionDeadline: Schema.optionalKey(Schema.Date),
  capabilityKey: CapabilityKeySchema,
  correlationId: CorrelationIdSchema,
  decidedAt: Schema.Date,
  id: DecisionLogIdSchema,
  mode: AccessModeSchema,
  outcome: DecisionOutcomeSchema,
  reasons: Schema.NonEmptyArray(DecisionReasonSchema),
  scopeId: AccessScopeIdSchema,
  target: Schema.optionalKey(RecordKeySchema),
  tenantId: TenantIdSchema,
});
