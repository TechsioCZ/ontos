import { DateTime, Result, Schema } from 'effect';

import { approve } from '../../src/access/approvals/approval.ts';
import type { ApproveInput } from '../../src/access/approvals/approval.ts';
import { verifyHumanPrincipal } from '../../src/access/approvals/principals.ts';
import type { VerifiedHumanPrincipal } from '../../src/access/approvals/principals.ts';
import { propose } from '../../src/access/approvals/proposal.ts';
import type { BoundWitness } from '../../src/access/approvals/proposal.ts';
import type { GovernedCapability } from '../../src/access/approvals/policy.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  GrantIncarnationIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  RecordKeySchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type {
  AccessScopeId,
  AgentConnectionId,
  AgentId,
  AssignmentIncarnationId,
  CapabilityKey,
  CommandDigest,
  GrantIncarnationId,
  ModuleKey,
  PrincipalId,
  ProposalId,
  RecordKey,
  RoleRevisionId,
  TenantId,
} from '../../src/access/ids.ts';
import type { ActorContext, Holder, Proposal } from '../../src/access/model.ts';
import { actorHolder } from '../../src/access/model.ts';

/*
 * Fixtures for the proposal and mandate suites. Proposals and mandates are built through the real
 * pure transitions, so a fixture that violates a lifecycle rule fails here instead of in a test.
 */

export const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

export const principalId = (value: number): PrincipalId => Schema.decodeSync(PrincipalIdSchema)(uuid(value));
export const agentId = (value: number): AgentId => Schema.decodeSync(AgentIdSchema)(uuid(value));
export const agentConnectionId = (value: number): AgentConnectionId =>
  Schema.decodeSync(AgentConnectionIdSchema)(uuid(value));
export const proposalId = (value: number): ProposalId => Schema.decodeSync(ProposalIdSchema)(uuid(value));
export const assignmentIncarnationId = (value: number): AssignmentIncarnationId =>
  Schema.decodeSync(AssignmentIncarnationIdSchema)(uuid(value));
export const grantIncarnationId = (value: number): GrantIncarnationId =>
  Schema.decodeSync(GrantIncarnationIdSchema)(uuid(value));
export const capabilityKey = (value: string): CapabilityKey => Schema.decodeSync(CapabilityKeySchema)(value);
export const recordKey = (value: string): RecordKey => Schema.decodeSync(RecordKeySchema)(value);
export const roleRevisionId = (value: number): RoleRevisionId => Schema.decodeSync(RoleRevisionIdSchema)(uuid(value));
export const moduleKey = (value: string): ModuleKey => Schema.decodeSync(ModuleKeySchema)(value);
export const commandDigest = (value: string): CommandDigest => Schema.decodeSync(CommandDigestSchema)(value);

export const TENANT: TenantId = Schema.decodeSync(TenantIdSchema)(uuid(900));
export const SCOPE: AccessScopeId = Schema.decodeSync(AccessScopeIdSchema)(uuid(901));
export const OTHER_SCOPE: AccessScopeId = Schema.decodeSync(AccessScopeIdSchema)(uuid(902));
export const OTHER_TENANT: TenantId = Schema.decodeSync(TenantIdSchema)(uuid(903));
export const AT = DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, 9)));
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const at = (hours: number, minutes = 0): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, hours, minutes)));
export const plus = (from: Date, milliseconds: number): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(from).pipe(DateTime.add({ milliseconds })));

export const person = (value: number): ActorContext => ({ _tag: 'Principal', principalId: principalId(value) });
export const agentOf = (value: number, agent: number, connection: number): ActorContext => ({
  _tag: 'Agent',
  agentId: agentId(agent),
  connectionId: agentConnectionId(connection),
  consentRevision: 1,
  principalId: principalId(value),
});

export const REQUESTER = person(1);
export const APPROVER = person(2);
export const BYSTANDER = person(3);
export const REQUESTER_HOLDER: Holder = actorHolder(REQUESTER);
export const APPROVER_HOLDER: Holder = actorHolder(APPROVER);
/** The single role revision every scripted assignment and grant binding shares (O49). */
export const ROLE_REVISION = roleRevisionId(700);
export const OTHER_ROLE_REVISION = roleRevisionId(701);

/** Only a verified person can hold the approval proof; an agent or a workload cannot (O46). */
export const humanApprover = (value: number): VerifiedHumanPrincipal =>
  Result.getOrThrow(verifyHumanPrincipal({ principalId: principalId(value), principalKind: 'human' }));

export const APPROVER_PROOF = humanApprover(2);
export const REQUESTER_PROOF = humanApprover(1);

export const INVOICE_VOID = 'finance.invoice.void';
export const INVOICE_READ = 'finance.invoice.read';

/** A sensitive action: 24-hour approval lifetime, run/propose/approve (P10, P12). */
export const sensitiveCapability = (overrides: Partial<GovernedCapability> = {}): GovernedCapability => ({
  capabilityKey: capabilityKey(INVOICE_VOID),
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  /** The catalog names the read that governs the record, so no command has to (D30, O64). */
  parentRecordReadCapabilityKey: capabilityKey(INVOICE_READ),
  risk: 'sensitive',
  selectors: ['assigned'],
  ...overrides,
});

/** A critical action: one-hour approval lifetime (P10). */
export const criticalCapability = (overrides: Partial<GovernedCapability> = {}): GovernedCapability =>
  sensitiveCapability({ capabilityKey: capabilityKey('finance.invoice.issue'), risk: 'critical', ...overrides });

/** A record-scoped action that needs the approver's read of the parent record (D30). */
export const recordScopedCapability = (overrides: Partial<GovernedCapability> = {}): GovernedCapability =>
  sensitiveCapability({ selectors: ['assigned'], ...overrides });

/**
 * One bound witness. The holder is the holder of the assignment itself — a person or an agent —
 * and the scope is where both the assignment and the grant cell live (R2-H1).
 */
export const boundWitness = (input: {
  readonly assignment: number;
  readonly capabilityKey?: CapabilityKey;
  readonly grant: number;
  readonly holderId?: Holder;
  readonly scopeId?: AccessScopeId;
}): BoundWitness => ({
  assignmentIncarnationId: assignmentIncarnationId(input.assignment),
  capabilityKey: input.capabilityKey ?? capabilityKey(INVOICE_VOID),
  grantIncarnationId: grantIncarnationId(input.grant),
  holderId: input.holderId ?? REQUESTER_HOLDER,
  scopeId: input.scopeId ?? SCOPE,
});

/** The requester's own propose authority, held by the requester itself. */
export const requesterWitness = (
  assignment: number,
  grant: number,
  key: CapabilityKey = capabilityKey(INVOICE_VOID),
  holderId: Holder = REQUESTER_HOLDER,
): BoundWitness => boundWitness({ assignment, capabilityKey: key, grant, holderId });

/** The approver's own authority, held by the approver's person — never by the requester (O56). */
export const approverWitness = (
  assignment: number,
  grant: number,
  key: CapabilityKey = capabilityKey(INVOICE_VOID),
): BoundWitness => boundWitness({ assignment, capabilityKey: key, grant, holderId: APPROVER_HOLDER });

export interface ProposalFixtureOptions {
  readonly capability?: GovernedCapability;
  readonly now?: Date;
  readonly requester?: ActorContext;
  readonly target?: RecordKey;
}

export const proposeResult = (options: ProposalFixtureOptions = {}) => {
  const capability = options.capability ?? sensitiveCapability();
  const requester = options.requester ?? REQUESTER;
  const holderId = actorHolder(requester);
  const prepared = {
    capability,
    commandDigest: commandDigest('1'.repeat(64)),
    now: options.now ?? AT,
    proposalId: proposalId(101),
    requester,
    requesterAuthority: [
      requesterWitness(11, 21, capability.capabilityKey, holderId),
      requesterWitness(12, 22, capability.capabilityKey, holderId),
    ],
    scopeId: SCOPE,
    tenantId: TENANT,
  };
  return propose(options.target === undefined ? prepared : { ...prepared, target: options.target });
};

export const proposalOf = (options: ProposalFixtureOptions = {}): Proposal => Result.getOrThrow(proposeResult(options));

export interface MandateFixtureOptions extends ProposalFixtureOptions {
  readonly approvedAt?: Date;
}

export const mandateOf = (options: MandateFixtureOptions = {}): Proposal => {
  const proposal = proposalOf(options);
  const approval: ApproveInput = {
    approver: APPROVER_PROOF,
    authority: {
      approval: approverWitness(31, 41, proposal.capabilityKey),
      execution: approverWitness(32, 42, proposal.capabilityKey),
      parentRecordRead: proposal.target === undefined ? [] : [approverWitness(33, 43, capabilityKey(INVOICE_READ))],
    },
    capability: options.capability ?? sensitiveCapability(),
    now: options.approvedAt ?? AT,
    policy: { selfApproval: 'permitted' },
    proposal,
  };
  const approved =
    proposal.target === undefined
      ? approve(approval)
      : approve({ ...approval, parentRecordReadCapabilityKey: capabilityKey(INVOICE_READ) });
  return Result.getOrThrow(approved);
};
