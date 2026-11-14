import { AccessApprovalsInbox } from '@app/core-runtime/access/approvals/inbox';
import type { AccessApprovalsInboxService } from '@app/core-runtime/access/approvals/inbox';
import { AccessChangesCommands } from '@app/core-runtime/access/changes/commands';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CommandDigestSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { AccessPeopleDirectory } from '@app/core-runtime/access/intent/people-directory';
import { Context, Effect, Layer, Option, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApprovalOwnerTransport } from '../../api/access-admin/approval-owner-transport.ts';
import { AccessApprovalsCommands } from '../../api/access-admin/approvals-commands.ts';
import { approvalRecordRevision } from '../../api/access-admin/approvals-contract.ts';
import { AccessApprovalsLive, accessApprovalActionsLayer } from '../../api/access-admin/approvals-live.ts';
import { approvalOwnerFrozen, approvalOwnerProposal, approvalOwnerTenantScope } from '../fixtures/approval-owner.ts';

type Proposal = Effect.Success<ReturnType<AccessApprovalsInboxService['open']>>[number];
const pending: Proposal = {
  capabilityKey: approvalOwnerFrozen.command.capabilityKey,
  commandDigest: approvalOwnerFrozen.commandDigest,
  createdAt: approvalOwnerProposal.createdAt,
  expiresAt: approvalOwnerProposal.expiresAt,
  id: approvalOwnerFrozen.proposalId,
  requester: {
    _tag: 'Principal',
    principalId: PrincipalIdSchema.make('00000000-0000-4000-8000-000000000002'),
  },
  scopeId: approvalOwnerFrozen.scopeId,
  status: 'pending',
  tenantId: approvalOwnerFrozen.tenantId,
  witnesses: [],
};
const approval = {
  approvalAssignmentIncarnationId: AssignmentIncarnationIdSchema.make('00000000-0000-4000-8000-000000000022'),
  approvedAt: pending.createdAt,
  approverId: PrincipalIdSchema.make(approvalOwnerTenantScope.principalId),
  executionAssignmentIncarnationId: AssignmentIncarnationIdSchema.make('00000000-0000-4000-8000-000000000023'),
  expiresAt: pending.expiresAt,
};
const approved: Proposal = {
  ...pending,
  approval,
  status: 'approved',
};
const unused = () => Effect.die('Owner approval must not use a legacy local approval or execution port');

const fixture = Effect.fn('OwnerApprovalPersistenceTest.fixture')(function* persistenceFixture(
  persisted: readonly Proposal[],
  stale: boolean,
  operation: 'approve' | 'inspect',
) {
  let ownerCalls = 0;
  let inspections = 0;
  let reads = 0;
  const inbox: AccessApprovalsInboxService = {
    approvals: () => ({
      approve: unused,
      execute: unused,
      expireDue: unused,
      propose: unused,
      recheckAuthority: unused,
      recordAuthorityLoss: unused,
      reject: unused,
      withdraw: unused,
    }),
    frozenCommand: () => Effect.succeed(Option.some(approvalOwnerFrozen)),
    isAdministrator: unused,
    open: () =>
      Effect.sync(() => {
        reads += 1;
        return reads === 1 ? [pending] : persisted;
      }),
    scopes: unused,
  };
  const context = yield* Layer.build(
    AccessApprovalsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          accessApprovalActionsLayer([]),
          Layer.succeed(AccessApprovalsInbox, inbox),
          Layer.succeed(ApprovalOwnerTransport, {
            approve: () =>
              Effect.sync(() => {
                ownerCalls += 1;
              }),
            inspect: () =>
              Effect.sync(() => {
                inspections += 1;
                return true;
              }),
          }),
          Layer.succeed(AccessPeopleDirectory, {
            companyMember: unused,
            companyMembers: unused,
            people: unused,
            scopeLabels: unused,
          }),
          Layer.succeed(AccessChangesCommands, {
            adopt: unused,
            decline: unused,
            preview: unused,
            read: unused,
            readRelease: unused,
            roleNames: unused,
            undo: unused,
          }),
        ),
      ),
    ),
  );
  const commands = Context.get(context, AccessApprovalsCommands);
  const input = {
    headers: new Headers(),
    proposalId: pending.id,
    revision: stale ? 'stale' : approvalRecordRevision(approvalOwnerProposal),
  };
  const result = yield* operation === 'approve'
    ? commands.approve(approvalOwnerTenantScope, input).pipe(Effect.result)
    : commands.inspect(approvalOwnerTenantScope, input).pipe(Effect.result);
  return { inspections, ownerCalls, reads, result };
});

/** The command's success, or nothing when it failed. */
type CommandOutcome = Effect.Success<ReturnType<typeof fixture>>['result'];
type CommandResult = Result.Result<
  CommandOutcome extends Result.Result<infer A, unknown> ? A : never,
  CommandOutcome extends Result.Result<unknown, infer E> ? E : never
>;
const succeeded = (result: CommandResult) => (Result.isSuccess(result) ? result.success : undefined);
/** The command's failure, or nothing when it succeeded. */
const failed = (result: CommandResult) => (Result.isFailure(result) ? result.failure : undefined);

it.effect('returns the actual reloaded persisted approval, not the owner acknowledgement', () =>
  Effect.gen(function* persistedApproval() {
    const { ownerCalls, reads, result } = yield* fixture([approved], false, 'approve');
    expect(ownerCalls).toBe(1);
    expect(reads).toBe(2);
    expect(succeeded(result)).toMatchObject({
      approval: { approvedAt: approval.approvedAt, approverId: approval.approverId, expiresAt: approval.expiresAt },
      id: approved.id,
      status: 'approved',
    });
    expect(JSON.stringify(result)).not.toContain('AssignmentIncarnationId');
  }).pipe(Effect.scoped),
);

const mismatches = [
  { name: 'an unchanged pending record', proposals: [pending] },
  { name: 'a missing record', proposals: [] },
  {
    name: 'another approver',
    proposals: [{ ...approved, approval: { ...approval, approverId: pending.requester.principalId } }],
  },
  { name: 'another digest', proposals: [{ ...approved, commandDigest: CommandDigestSchema.make('ab'.repeat(32)) }] },
  {
    name: 'another scope',
    proposals: [{ ...approved, scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000088') }],
  },
  {
    name: 'another tenant',
    proposals: [{ ...approved, tenantId: TenantIdSchema.make('00000000-0000-4000-8000-000000000099') }],
  },
] as const;

for (const { name, proposals } of mismatches) {
  it.effect(`an owner acknowledgement cannot hide ${name}`, () =>
    Effect.gen(function* unconfirmedApproval() {
      const { ownerCalls, reads, result } = yield* fixture(proposals, false, 'approve');
      expect(ownerCalls).toBe(1);
      expect(reads).toBe(2);
      expect(Predicate.isTagged(failed(result), 'ApprovalPortUnavailable')).toBe(true);
    }).pipe(Effect.scoped),
  );
}

it.effect('rejects a stale revision before calling the owner transport', () =>
  Effect.gen(function* staleRevision() {
    const { ownerCalls, reads, result } = yield* fixture([approved], true, 'approve');
    expect(ownerCalls).toBe(0);
    expect(reads).toBe(1);
    expect(failed(result)).toMatchObject({ code: 'revision_stale' });
  }).pipe(Effect.scoped),
);

it.effect('inspects the original stored command without approving and rechecks that it remains pending', () =>
  Effect.gen(function* observesPending() {
    const { inspections, ownerCalls, reads, result } = yield* fixture([pending], false, 'inspect');
    expect(inspections).toBe(1);
    expect(ownerCalls).toBe(0);
    expect(reads).toBe(2);
    expect(succeeded(result)).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect('does not advertise an inspection after another caller approves the proposal', () =>
  Effect.gen(function* changedDuringInspection() {
    const { inspections, ownerCalls, reads, result } = yield* fixture([approved], false, 'inspect');
    expect(inspections).toBe(1);
    expect(ownerCalls).toBe(0);
    expect(reads).toBe(2);
    expect(failed(result)).toMatchObject({ code: 'revision_stale' });
  }).pipe(Effect.scoped),
);

it.effect('refuses stale inspection before any receiving owner observation', () =>
  Effect.gen(function* staleInspection() {
    const { inspections, ownerCalls, reads, result } = yield* fixture([pending], true, 'inspect');
    expect(inspections).toBe(0);
    expect(ownerCalls).toBe(0);
    expect(reads).toBe(1);
    expect(failed(result)).toMatchObject({ code: 'revision_stale' });
  }).pipe(Effect.scoped),
);
