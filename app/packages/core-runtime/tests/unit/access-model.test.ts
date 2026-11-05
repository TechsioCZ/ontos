import { DateTime, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CapabilityKeySchema, RecordKeySchema } from '../../src/access/ids.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  AccessChangeDecisionSchema,
  AccessChangeItemSchema,
  AccessScopeSchema,
  AmountCeilingSchema,
  AssignmentSchema,
  CatalogSnapshotSchema,
  CellSchema,
  ConsentCeilingSchema,
  DecisionLogSchema,
  DelegationSchema,
  HolderSchema,
  MandateSchema,
  OperationJournalSchema,
  ProposalSchema,
  RoleRevisionSchema,
  ScopeFenceSchema,
  canAdvanceOperationPhase,
  canTransitionProposalStatus,
  namesRoleTemplate,
} from '../../src/access/model.ts';
import type { OperationPhase, ProposalStatus } from '../../src/access/model.ts';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const at = (hour: number) => DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, hour)));
const decode = <Input>(schema: Schema.Decoder<unknown>, input: Input) =>
  Schema.decodeUnknownResult(schema, ACCESS_MODEL_PARSE_OPTIONS)(input);
const expectAccepted = <Input>(schema: Schema.Decoder<unknown>, input: Input) => {
  const result = decode(schema, input);
  if (Result.isFailure(result)) {
    expect.unreachable(result.failure.message);
  }
};
const expectRejected = <Input>(schema: Schema.Decoder<unknown>, input: Input, reason?: string) => {
  const result = decode(schema, input);
  expect(Result.isFailure(result)).toBe(true);
  if (reason !== undefined && Result.isFailure(result)) {
    expect(result.failure.message).toContain(reason);
  }
};

const tenantId = id(1);
const person = id(2);
const manager = id(3);
const agent = id(4);
const scopeId = id(5);
const key = 'finance.invoice.void';
const cell = { capabilityKey: key, mode: 'run', selector: { _tag: 'all' } };

it('accepts only lowercase capability keys with module, resource and verb', () => {
  for (const valid of ['party.registry.party.merge', 'party-registry.party.add-note', 'finance.invoice.write_off']) {
    expect(Schema.is(CapabilityKeySchema)(valid)).toBe(true);
  }
  for (const invalid of [
    'finance.invoice',
    'Finance.invoice.void',
    'finance..invoice.void',
    'finance.invoice.void.',
    `a.b.${'c'.repeat(200)}`,
  ]) {
    expect(Schema.is(CapabilityKeySchema)(invalid)).toBe(false);
  }
  expect(Schema.is(RecordKeySchema)('')).toBe(false);
});

it('decodes exact cells and rejects malformed selectors and ceilings', () => {
  expectAccepted(CellSchema, {
    ...cell,
    amountCeiling: { currency: 'CZK', limitMinor: 10_000_000 },
    selector: { _tag: 'targets', recordKeys: ['invoice-1', 'invoice-2'] },
  });
  for (const selector of [
    { _tag: 'targets', recordKeys: [] },
    { _tag: 'targets', recordKeys: ['a', 'a'] },
    { _tag: 'any' },
  ]) {
    expectRejected(CellSchema, { ...cell, selector });
  }
  expectRejected(CellSchema, { ...cell, mode: 'administer' });
  expectRejected(CellSchema, { ...cell, grant: true });
  for (const ceiling of [
    { currency: 'CZK', limitMinor: -1 },
    { currency: 'CZK', limitMinor: 1.5 },
    { currency: 'czk', limitMinor: 1 },
    { currency: 'CZK', limitMinor: Number.MAX_SAFE_INTEGER + 2 },
  ]) {
    expectRejected(AmountCeilingSchema, ceiling);
  }
});

it('keeps catalog keys unique and entries closed', () => {
  const entry = {
    key,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    moduleKey: 'finance',
    placement: { group: 'invoices', level: 'manage' },
    risk: 'critical',
    selectors: ['all', 'assigned'],
  };
  const snapshot = { digest: 'a'.repeat(64), entries: [entry], id: id(10), publishedAt: at(1) };
  expectAccepted(CatalogSnapshotSchema, snapshot);
  expectRejected(CatalogSnapshotSchema, { ...snapshot, entries: [entry, entry] }, 'Catalog keys are unique');
  expectRejected(CatalogSnapshotSchema, { ...snapshot, entries: [{ ...entry, grantedTo: 'everyone' }] });
  expectRejected(CatalogSnapshotSchema, { ...snapshot, entries: [{ ...entry, modes: [] }] });
  expectRejected(CatalogSnapshotSchema, { ...snapshot, digest: 'A'.repeat(64) });
});

it('allows exactly one scope context and exactly one holder kind', () => {
  expectAccepted(AccessScopeSchema, { _tag: 'TenantContext', tenantId });
  expectAccepted(AccessScopeSchema, { _tag: 'LegalEntity', legalEntityId: id(6), tenantId });
  expectRejected(AccessScopeSchema, { _tag: 'TenantContext', legalEntityId: id(6), tenantId });
  expectRejected(AccessScopeSchema, { _tag: 'LegalEntity', tenantId });
  expectRejected(AccessScopeSchema, { tenantId });
  expectAccepted(HolderSchema, { _tag: 'Agent', agentId: agent });
  expectRejected(HolderSchema, { _tag: 'Principal', agentId: agent, principalId: person });
  expectRejected(HolderSchema, { _tag: 'Agent', principalId: person });
});

it('requires unique cell slots and template provenance on role revisions', () => {
  const revision = {
    catalogSnapshotId: id(10),
    cells: [cell, { ...cell, mode: 'approve' }],
    createdAt: at(1),
    createdBy: person,
    id: id(11),
    provenance: 'template',
    revision: 1,
    roleId: id(12),
    templateKey: 'finance.accountant',
    tenantId,
  };
  expectAccepted(RoleRevisionSchema, revision);
  expectAccepted(RoleRevisionSchema, { ...revision, provenance: 'customer_changed' });
  expectRejected(
    RoleRevisionSchema,
    { ...revision, cells: [cell, { ...cell, amountCeiling: { currency: 'CZK', limitMinor: 1 } }] },
    'slot occurs once',
  );
  expectRejected(RoleRevisionSchema, { ...revision, provenance: 'manual' }, 'name a template');
  const { templateKey: _templateKey, ...manual } = revision;
  expectAccepted(RoleRevisionSchema, { ...manual, provenance: 'manual' });
  expectRejected(RoleRevisionSchema, { ...manual, provenance: 'template' }, 'name a template');
  expectRejected(RoleRevisionSchema, { ...revision, revision: 0 });
  // O47: the legacy-grant import baseline is a first-class provenance and never names a template.
  expectAccepted(RoleRevisionSchema, { ...manual, provenance: 'imported' });
  expectRejected(RoleRevisionSchema, { ...revision, provenance: 'imported' }, 'name a template');
  expect(namesRoleTemplate('imported')).toBe(false);
  expect(namesRoleTemplate('manual')).toBe(false);
  expect(namesRoleTemplate('template')).toBe(true);
});

it('bounds assignment periods and freezes delegated limits within the delegation deadline', () => {
  const assignment = {
    assignedAt: at(1),
    assignedBy: manager,
    holder: { _tag: 'Principal', principalId: person },
    incarnationId: id(20),
    roleId: id(12),
    roleRevisionId: id(11),
    scopeId,
    status: 'active',
    tenantId,
    validFrom: at(1),
  };
  expectAccepted(AssignmentSchema, assignment);
  expectAccepted(AssignmentSchema, { ...assignment, holder: { _tag: 'Agent', agentId: agent }, validUntil: at(2) });
  expectRejected(AssignmentSchema, { ...assignment, validUntil: at(1) }, 'validUntil must follow validFrom');
  expectRejected(AssignmentSchema, { ...assignment, status: 'reactivated' });
  const delegated = { capabilityKeys: [key], delegationId: id(21), until: at(5) };
  expectAccepted(AssignmentSchema, { ...assignment, delegated, validUntil: at(5) });
  expectRejected(AssignmentSchema, { ...assignment, delegated }, 'no later than its delegation');
  expectRejected(AssignmentSchema, { ...assignment, delegated, validUntil: at(6) }, 'no later than its delegation');
});

it('never lets a delegation be self-granted, self-assignable or unbounded', () => {
  const delegation = {
    capabilityKeys: [key],
    grantedBy: person,
    id: id(21),
    managerId: manager,
    people: [id(30)],
    roleIds: [id(12)],
    scopeId,
    status: 'active',
    tenantId,
    validFrom: at(1),
    validUntil: at(5),
  };
  expectAccepted(DelegationSchema, delegation);
  expectRejected(DelegationSchema, { ...delegation, grantedBy: manager }, 'never self-granted');
  expectRejected(DelegationSchema, { ...delegation, people: [id(30), manager] }, 'never self-granted');
  expectRejected(DelegationSchema, { ...delegation, capabilityKeys: [] });
  expectRejected(DelegationSchema, { ...delegation, roleIds: [] });
  expectRejected(DelegationSchema, { ...delegation, people: [] });
  expectRejected(DelegationSchema, { ...delegation, validUntil: at(1) }, 'validUntil must follow validFrom');
  expectRejected(DelegationSchema, { ...delegation, canRedelegate: true });
});

it('keeps Novinky lineage and decisions consistent', () => {
  const item = {
    capabilityKey: key,
    catalogSnapshotId: id(10),
    createdAt: at(1),
    id: id(40),
    kind: 'renamed',
    lineageFrom: ['finance.invoice.cancel'],
    risk: 'critical',
    status: 'pending',
    suggestedRoleIds: [id(12)],
    tenantId,
  };
  expectAccepted(AccessChangeItemSchema, item);
  expectRejected(AccessChangeItemSchema, { ...item, lineageFrom: [] }, 'name a lineage');
  expectRejected(AccessChangeItemSchema, { ...item, kind: 'new' }, 'name a lineage');
  expectAccepted(AccessChangeItemSchema, { ...item, kind: 'new', lineageFrom: [] });
  const decision = {
    batchId: id(41),
    decidedAt: at(2),
    decidedBy: person,
    decision: 'adopt',
    id: id(42),
    itemId: id(40),
    roleRevisionIds: [id(11)],
    tenantId,
  };
  expectAccepted(AccessChangeDecisionSchema, decision);
  expectAccepted(AccessChangeDecisionSchema, { ...decision, decision: 'undo', id: id(43), undoesDecisionId: id(42) });
  expectRejected(AccessChangeDecisionSchema, { ...decision, decision: 'undo' }, 'reference another decision');
  expectRejected(
    AccessChangeDecisionSchema,
    { ...decision, decision: 'undo', undoesDecisionId: id(42) },
    'reference another decision',
  );
  expectRejected(AccessChangeDecisionSchema, { ...decision, undoesDecisionId: id(1) }, 'reference another decision');
  expectRejected(AccessChangeDecisionSchema, { ...decision, decision: 'decline' }, 'A decline changes no role');
});

const requester = {
  _tag: 'Agent',
  agentId: agent,
  connectionId: id(50),
  consentRevision: 2,
  principalId: person,
};
const requesterWitness = {
  assignmentIncarnationId: id(20),
  capabilityKey: key,
  grantIncarnationId: id(60),
  holderId: { _tag: 'Agent', agentId: agent },
  mode: 'propose',
  purpose: 'requester',
  scopeId,
};
const pending = {
  capabilityKey: key,
  commandDigest: 'b'.repeat(64),
  createdAt: at(1),
  expiresAt: at(9),
  id: id(70),
  requester,
  scopeId,
  status: 'pending',
  target: 'invoice-1',
  tenantId,
  witnesses: [requesterWitness],
};
const approval = {
  approvalAssignmentIncarnationId: id(22),
  approvedAt: at(2),
  approverId: manager,
  executionAssignmentIncarnationId: id(23),
  expiresAt: at(3),
};
const approverWitnesses = [
  {
    assignmentIncarnationId: id(22),
    capabilityKey: key,
    grantIncarnationId: id(61),
    holderId: { _tag: 'Principal', principalId: manager },
    mode: 'approve',
    purpose: 'approval',
    scopeId,
  },
  {
    assignmentIncarnationId: id(23),
    capabilityKey: key,
    grantIncarnationId: id(62),
    holderId: { _tag: 'Principal', principalId: manager },
    mode: 'run',
    purpose: 'execution',
    scopeId,
  },
  {
    assignmentIncarnationId: id(23),
    capabilityKey: 'finance.invoice.read',
    grantIncarnationId: id(63),
    holderId: { _tag: 'Principal', principalId: manager },
    mode: 'run',
    purpose: 'parent_record_read',
    scopeId,
  },
];
const approved = { ...pending, approval, status: 'approved', witnesses: [requesterWitness, ...approverWitnesses] };
const execution = { actionInvocationId: id(80), executedAt: at(2) };

it('binds proposals and mandates to exact authority and a single live execution', () => {
  expectAccepted(ProposalSchema, pending);
  expectAccepted(ProposalSchema, approved);
  expectAccepted(ProposalSchema, { ...approved, execution, status: 'executed' });
  expectAccepted(ProposalSchema, { ...approved, endedAt: at(2), status: 'lapsed' });
  expectAccepted(ProposalSchema, { ...pending, endedAt: at(2), rejectedBy: manager, status: 'rejected' });
  expectRejected(ProposalSchema, { ...pending, approval }, 'pending and rejected ones do not');
  const { approval: _approval, ...unapproved } = approved;
  expectRejected(ProposalSchema, unapproved, 'Approved and executed proposals carry an approval');
  expectRejected(ProposalSchema, { ...approved, witnesses: [requesterWitness] }, 'binds the approver assignments');
  expectRejected(
    ProposalSchema,
    {
      ...approved,
      witnesses: [requesterWitness, approverWitnesses[0], { ...approverWitnesses[1], assignmentIncarnationId: id(29) }],
    },
    'binds the approver assignments',
  );
  expectRejected(ProposalSchema, { ...pending, witnesses: approverWitnesses }, 'binds the requester authority');
  expectRejected(
    ProposalSchema,
    { ...pending, witnesses: [requesterWitness, approverWitnesses[0]] },
    'Only an approval binds',
  );
  expectRejected(
    ProposalSchema,
    { ...pending, witnesses: [requesterWitness, requesterWitness] },
    'witness slot occurs once',
  );
  expectRejected(ProposalSchema, { ...approved, status: 'executed' }, 'execution receipt');
  expectRejected(ProposalSchema, { ...approved, execution }, 'execution receipt');
  expectRejected(
    ProposalSchema,
    { ...approved, execution: { ...execution, executedAt: at(3) }, status: 'executed' },
    'while the approval is live',
  );
  expectRejected(
    ProposalSchema,
    { ...approved, approval: { ...approval, approvedAt: at(9) } },
    'within the proposal lifetime',
  );
  expectRejected(ProposalSchema, { ...pending, expiresAt: at(1) }, 'positive lifetime');
  expectRejected(ProposalSchema, { ...pending, endedAt: at(2), status: 'rejected' }, 'name who rejected them');
  expectRejected(ProposalSchema, { ...pending, status: 'expired' }, 'carry an end time');
  const { connectionId: _connectionId, ...unconnected } = requester;
  expectRejected(ProposalSchema, { ...pending, requester: unconnected });
  expectRejected(ProposalSchema, { ...pending, witnesses: [] });
  // R2-H1 negative controls: the witness tuple is what the execution re-check compares, so a
  // witness with the wrong mode, holder or scope is refused before it is ever stored.
  expectRejected(
    ProposalSchema,
    { ...pending, witnesses: [{ ...requesterWitness, mode: 'run' }] },
    'requester witness is held in the propose mode',
  );
  expectRejected(
    ProposalSchema,
    { ...approved, witnesses: [{ ...requesterWitness, mode: 'approve' }, ...approverWitnesses] },
    'requester witness is held in the propose mode',
  );
  expectRejected(
    ProposalSchema,
    { ...approved, witnesses: [requesterWitness, { ...approverWitnesses[0], mode: 'run' }, approverWitnesses[1]] },
    'approval witness is held in the approve mode',
  );
  expectRejected(
    ProposalSchema,
    { ...approved, witnesses: [requesterWitness, approverWitnesses[0], { ...approverWitnesses[1], mode: 'propose' }] },
    'execution witness is held in the run mode',
  );
  expectRejected(
    ProposalSchema,
    { ...approved, witnesses: [requesterWitness, approverWitnesses[0], { ...approverWitnesses[2], mode: 'approve' }] },
    'parent_record_read witness is held in the run mode',
  );
  // (a) another person's live assignment and grant can never stand in for the requester.
  expectRejected(
    ProposalSchema,
    { ...pending, witnesses: [{ ...requesterWitness, holderId: { _tag: 'Principal', principalId: person } }] },
    'requester witness belongs to the requester itself',
  );
  // A person is not interchangeable with the agent that acts for them.
  expectRejected(
    ProposalSchema,
    { ...pending, witnesses: [{ ...requesterWitness, holderId: { _tag: 'Principal', principalId: agent } }] },
    'requester witness belongs to the requester itself',
  );
  // (c) an approver witness from another legal entity never counts.
  expectRejected(
    ProposalSchema,
    { ...approved, witnesses: [requesterWitness, { ...approverWitnesses[0], scopeId: id(99) }, approverWitnesses[1]] },
    'Every witness is held in the scope of the proposal',
  );
  // The approval belongs to the approver named on the record, not to anyone else.
  expectRejected(
    ProposalSchema,
    {
      ...approved,
      witnesses: [requesterWitness, { ...approverWitnesses[0], holderId: { _tag: 'Principal', principalId: person } }],
    },
    'approval witness belongs to the approver',
  );
  // O63: only the approving human executes a mandate, so neither the requester, the requester's
  // agent nor the approver's own agent ever holds the execution witness.
  expectRejected(
    ProposalSchema,
    {
      ...approved,
      witnesses: [
        requesterWitness,
        approverWitnesses[0],
        { ...approverWitnesses[1], holderId: requesterWitness.holderId },
      ],
    },
    'the execution witness belongs to the approver',
  );
  expectRejected(
    ProposalSchema,
    {
      ...approved,
      witnesses: [
        requesterWitness,
        approverWitnesses[0],
        { ...approverWitnesses[1], holderId: { _tag: 'Agent', agentId: id(98) } },
      ],
    },
    'Only the approving human executes a mandate',
  );
  expectRejected(
    ProposalSchema,
    {
      ...approved,
      witnesses: [
        requesterWitness,
        approverWitnesses[0],
        { ...approverWitnesses[1], holderId: { _tag: 'Principal', principalId: person } },
      ],
    },
    'the execution witness belongs to the approver',
  );
  // The parent record read is the approver's own authority too (O63).
  expectRejected(
    ProposalSchema,
    {
      ...approved,
      witnesses: [
        requesterWitness,
        approverWitnesses[0],
        approverWitnesses[1],
        { ...approverWitnesses[2], holderId: { _tag: 'Principal', principalId: person } },
      ],
    },
    'parent record read belongs to the approver',
  );
  expectAccepted(MandateSchema, approved);
  expectRejected(MandateSchema, pending, 'A mandate is an approved proposal');
  expectRejected(MandateSchema, { ...approved, endedAt: at(2), status: 'lapsed' }, 'A mandate is an approved proposal');
});

it('moves proposal status only forward and never out of a terminal state', () => {
  const allowed: readonly (readonly [ProposalStatus, ProposalStatus])[] = [
    ['pending', 'approved'],
    ['pending', 'rejected'],
    ['pending', 'lapsed'],
    ['pending', 'expired'],
    ['approved', 'executed'],
    ['approved', 'lapsed'],
    ['approved', 'expired'],
  ];
  const statuses: readonly ProposalStatus[] = ['pending', 'approved', 'executed', 'lapsed', 'rejected', 'expired'];
  for (const from of statuses) {
    for (const to of statuses) {
      const expected = allowed.some(([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to);
      expect([from, to, canTransitionProposalStatus(from, to)]).toEqual([from, to, expected]);
    }
  }
});

it('ties a held scope fence to its operation and moves journals only forward', () => {
  const fence = { revision: 3, scopeId, state: 'Ready', tenantId };
  expectAccepted(ScopeFenceSchema, fence);
  expectAccepted(ScopeFenceSchema, { ...fence, owningOperationId: id(90), state: 'Changing' });
  expectRejected(ScopeFenceSchema, { ...fence, owningOperationId: id(90) }, 'names its owning operation');
  expectRejected(ScopeFenceSchema, { ...fence, state: 'Unavailable' }, 'names its owning operation');
  const journal = {
    commandDigest: 'c'.repeat(64),
    operationId: id(90),
    phase: 'committed',
    projectionToken: 'GhUKEzE3OTM2NjkzMDAwMDAwMDAwMDA=',
    scopeId,
    startedAt: at(1),
    tenantId,
    updatedAt: at(2),
  };
  expectAccepted(OperationJournalSchema, journal);
  const { projectionToken: _projectionToken, ...unprojected } = journal;
  expectRejected(OperationJournalSchema, unprojected, 'records its projection token');
  expectAccepted(OperationJournalSchema, { ...unprojected, phase: 'fenced' });
  expectRejected(OperationJournalSchema, { ...journal, phase: 'failed' }, 'carry a failure code');
  expectAccepted(OperationJournalSchema, { ...journal, failureCode: 'projection.unavailable', phase: 'failed' });
  expectRejected(OperationJournalSchema, { ...journal, updatedAt: at(0) }, 'never goes backwards');
  const forward: readonly (readonly [OperationPhase, OperationPhase, boolean])[] = [
    ['validated', 'fenced', true],
    ['fenced', 'committed', true],
    ['projected', 'failed', true],
    ['fenced', 'validated', false],
    ['committed', 'failed', false],
    ['failed', 'validated', false],
  ];
  for (const [from, to, expected] of forward) {
    expect([from, to, canAdvanceOperationPhase(from, to)]).toEqual([from, to, expected]);
  }
});

it('keeps consent ceilings slot-unique and decision logs explained', () => {
  expectAccepted(ConsentCeilingSchema, { cells: [cell] });
  expectRejected(ConsentCeilingSchema, { cells: [cell, cell] }, 'slot occurs once');
  const log = {
    actor: requester,
    capabilityKey: key,
    correlationId: 'request-1',
    decidedAt: at(1),
    id: id(95),
    mode: 'run',
    outcome: 'NEEDS_APPROVAL',
    reasons: [{ assignmentIncarnationId: id(20), capabilityKey: key, code: 'agent.propose_only' }],
    scopeId,
    tenantId,
  };
  expectAccepted(DecisionLogSchema, log);
  expectAccepted(DecisionLogSchema, { ...log, outcome: 'UNAVAILABLE', reasons: [{ code: 'engine.unavailable' }] });
  expectRejected(DecisionLogSchema, { ...log, reasons: [] });
  expectRejected(DecisionLogSchema, { ...log, outcome: 'ALLOW' });
  expectRejected(DecisionLogSchema, { ...log, reasons: [{ code: 'Agent Propose Only' }] });
});
