import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { freezeCommand } from '../../src/access/approvals/command.ts';
import { ActionKeySchema } from '../../src/access/approvals/frozen-command.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import { ActionInvocationRefSchema } from '../../src/access/approvals/execution.ts';
import { boundWitnessSlot } from '../../src/access/approvals/proposal.ts';
import { proposalIdForInvocation } from '../../src/access/approvals/proposal-invocation-id.ts';
import type { BoundWitness } from '../../src/access/approvals/proposal.ts';
import { makeApprovalsService } from '../../src/access/approvals/service.ts';
import type {
  ApprovalsPorts,
  ApprovalsService,
  ApproveCommand,
  ExecuteCommand,
  ProposeCommand,
  RejectCommand,
  WithdrawCommand,
} from '../../src/access/approvals/service.ts';
import { actorHolder } from '../../src/access/model.ts';
import type { GovernedCapability } from '../../src/access/approvals/policy.ts';
import type { AccessScopeId, PrincipalId } from '../../src/access/ids.ts';
import {
  makeInMemoryApprovalCatalog,
  makeInMemoryApprovalStore,
  makeMutableApprovalClock,
  makeScriptedApprovalIdentifiers,
  makeScriptedProjection,
  makeScriptedScopeAdministration,
  makeUnavailableAuthorityInspector,
} from './access-approvals-support.ts';
import {
  APPROVER,
  AT,
  BYSTANDER,
  HOUR_MS,
  INVOICE_READ,
  INVOICE_VOID,
  OTHER_ROLE_REVISION,
  OTHER_SCOPE,
  REQUESTER,
  ROLE_REVISION,
  SCOPE,
  TENANT,
  agentOf,
  approverWitness,
  capabilityKey,
  plus,
  principalId,
  proposalId,
  recordKey,
  requesterWitness,
  sensitiveCapability,
  uuid,
} from './access-approvals-fixtures.ts';

const INVOCATION = Schema.decodeSync(ActionInvocationRefSchema)(uuid(500));
const FROZEN_COMMAND = {
  capabilityKey: capabilityKey(INVOICE_VOID),
  payload: { invoice: 'invoice-1', reason: 'duplicate' },
  target: recordKey('invoice-1'),
} as const;
const REQUIRES_DIGEST = Result.getOrThrow(freezeCommand(FROZEN_COMMAND));
/** The same capability and record with another payload: a different command, so a different digest. */
const OTHER_COMMAND = {
  capabilityKey: capabilityKey(INVOICE_VOID),
  payload: { invoice: 'invoice-1', reason: 'another' },
  target: recordKey('invoice-1'),
} as const;
const OTHER_DIGEST = Result.getOrThrow(freezeCommand(OTHER_COMMAND));
/** In-memory store ignores this database handle; production insists on the owner transaction. */
const testTransaction: CoreTransaction = Object.create(null);
const withOwnerTransaction = (service: ApprovalsService): ApprovalsService => ({
  ...service,
  execute: (command) => service.execute(command, { transaction: testTransaction }),
});

const setup = (
  administrators: readonly { principalId: PrincipalId; scopeId: AccessScopeId }[] = [],
  capability: GovernedCapability = sensitiveCapability(),
) => {
  const projection = makeScriptedProjection(ROLE_REVISION);
  const store = makeInMemoryApprovalStore();
  const clock = makeMutableApprovalClock(AT);
  const ports: ApprovalsPorts = {
    administrators: makeScriptedScopeAdministration(administrators),
    authority: projection,
    catalog: makeInMemoryApprovalCatalog([capability]),
    clock,
    identifiers: makeScriptedApprovalIdentifiers([proposalId(201), proposalId(202)]),
    store,
  };
  /*
   * The doubles hold their facts in memory, so there is no second connection to escape to: the same
   * ports are already "the transaction's". A test that needs a store which cannot be bound withholds
   * `inTransaction` instead, which is what the shipped composition does without a `join`.
   */
  const rawService = makeApprovalsService({ ...ports, inTransaction: () => ports });
  const service = withOwnerTransaction(rawService);
  return { clock, ports, projection, rawService, service, store };
};

/** The requester's propose cell plus the approver's approve, run and parent-read cells. */
const allowMine = (projection: ReturnType<typeof makeScriptedProjection>) => {
  projection.bind(requesterWitness(11, 21), 'propose');
  projection.bind(approverWitness(31, 41), 'approve');
  projection.bind(approverWitness(32, 42), 'run');
  projection.bind(approverWitness(33, 43, capabilityKey(INVOICE_READ)), 'run');
};

const proposeCommand = (): ProposeCommand => ({
  actionKey: ActionKeySchema.make('finance.invoice.void'),
  actor: REQUESTER,
  capabilityKey: capabilityKey(INVOICE_VOID),
  command: FROZEN_COMMAND,
  commandDigest: REQUIRES_DIGEST,
  requesterAuthority: [requesterWitness(11, 21)],
  requesterKind: 'human',
  scopeId: SCOPE,
  target: recordKey('invoice-1'),
  tenantId: TENANT,
});

const approveCommand = (): ApproveCommand => ({
  approver: APPROVER,
  approverKind: 'human',
  authority: {
    approval: approverWitness(31, 41),
    execution: approverWitness(32, 42),
    parentRecordRead: [approverWitness(33, 43, capabilityKey(INVOICE_READ))],
  },
  policy: { selfApproval: 'permitted' },
  proposalId: proposalId(201),
  scopeId: SCOPE,
  tenantId: TENANT,
});

const rejectCommand = (approveAuthority: readonly BoundWitness[] = [approverWitness(31, 41)]): RejectCommand => ({
  approveAuthority,
  approver: APPROVER,
  approverKind: 'human',
  proposalId: proposalId(201),
  scopeId: SCOPE,
  tenantId: TENANT,
});

const withdrawCommand = (overrides: Partial<WithdrawCommand> = {}): WithdrawCommand => ({
  actor: REQUESTER,
  proposalId: proposalId(201),
  scopeId: SCOPE,
  tenantId: TENANT,
  withdrawAuthority: [],
  ...overrides,
});

const executeCommand = (): ExecuteCommand => ({
  actionInvocationId: INVOCATION,
  actor: APPROVER,
  commandDigest: REQUIRES_DIGEST,
  proposalId: proposalId(201),
  scopeId: SCOPE,
  tenantId: TENANT,
});

/** The stable refusal code of a failed operation, read from the typed error channel. */
const codeOf = <Value>(effect: Effect.Effect<Value, { readonly _tag: string; readonly code?: string }>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code ?? error._tag));

it.effect('proposes, approves and executes one mandate while every witness stays live', () =>
  Effect.gen(function* approvalsHappyPath() {
    const { projection, service, store } = setup();
    allowMine(projection);
    const proposal = yield* service.propose(proposeCommand());
    expect(proposal.status).toBe('pending');
    expect(proposal.commandDigest).toBe(REQUIRES_DIGEST);
    expect(store.all()).toHaveLength(1);
    expect(store.frozen()).toHaveLength(1);
    expect(store.frozen()[0]?.commandDigest).toBe(REQUIRES_DIGEST);

    const mandate = yield* service.approve(approveCommand());
    expect(mandate.status).toBe('approved');
    expect(mandate.witnesses.some(({ purpose }) => purpose === 'parent_record_read')).toBe(true);

    const executed = yield* service.execute(executeCommand());
    expect(executed.status).toBe('executed');
    expect(executed.execution?.actionInvocationId).toBe(INVOCATION);
    expect(store.all().map(({ status }) => status)).toStrictEqual(['executed']);
    expect(yield* codeOf(service.execute(executeCommand()))).toBe('proposal_already_executed');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['executed']);
  }),
);

it.effect('never consumes a mandate outside the owner Action transaction', () =>
  Effect.gen(function* standaloneExecutionDisabled() {
    const { projection, rawService, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    expect(yield* codeOf(rawService.execute(executeCommand()))).toBe('approval_authority_unavailable');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    expect((yield* service.execute(executeCommand())).status).toBe('executed');
  }),
);

it.effect('refuses a mandate whose authority cannot be read inside its owner transaction (O75)', () =>
  Effect.gen(function* unjoinedAuthority() {
    const { ports, projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    /*
     * The ports without `inTransaction` are the composition that would have to read the witnesses,
     * the membership path and the role bindings through a second connection. A claim decides under the
     * owner transaction's proposal lock, so that composition is unavailability — the mandate stays
     * approved and unconsumed instead of being executed on another instant's word.
     */
    const unjoined = makeApprovalsService(ports);
    expect(yield* codeOf(unjoined.execute(executeCommand()))).toBe('approval_authority_unavailable');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    // Parking into an owner transaction needs the same proof: nothing is stored without it.
    expect(
      yield* codeOf(
        unjoined.propose({ ...proposeCommand(), actionInvocationId: INVOCATION }, { transaction: testTransaction }),
      ),
    ).toBe('approval_authority_unavailable');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    // The same two steps with an authority that joins the transaction are the ones that decide.
    expect((yield* service.execute(executeCommand())).status).toBe('executed');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['executed']);
  }),
);

it.effect('binds an Action proposal to its owner transaction and to one durable invocation (O90)', () =>
  Effect.gen(function* ownerProposal() {
    const { projection, rawService, store } = setup();
    allowMine(projection);
    const command = { ...proposeCommand(), actionInvocationId: INVOCATION };
    expect(yield* codeOf(rawService.propose(command))).toBe('approval_authority_unavailable');
    expect(store.all()).toEqual([]);
    expect(store.frozen()).toEqual([]);
    const proposal = yield* rawService.propose(command, { transaction: testTransaction });
    expect(proposal.id).toBe(proposalIdForInvocation(TENANT, INVOCATION));
    expect(store.frozen()[0]?.proposalId).toBe(proposal.id);
    // O90.4: the same invocation proposing the same command answers the stored proposal itself.
    const replayed = yield* rawService.propose(command, { transaction: testTransaction });
    expect(replayed.id).toBe(proposal.id);
    expect(store.all()).toHaveLength(1);
    expect(store.frozen()).toHaveLength(1);
    // Another command under the same invocation is a conflict, never a second proposal or a replay.
    expect(
      yield* codeOf(
        rawService.propose(
          { ...command, command: OTHER_COMMAND, commandDigest: OTHER_DIGEST },
          { transaction: testTransaction },
        ),
      ),
    ).toBe('approval_storage_conflict');
    expect(store.all()).toHaveLength(1);
    expect(store.frozen()).toHaveLength(1);
  }),
);

it.effect('refuses a payload that does not recompute to the frozen proposal digest', () =>
  Effect.gen(function* mutatedCommandRefused() {
    const { projection, service, store } = setup();
    allowMine(projection);
    expect(
      yield* codeOf(
        service.propose({
          ...proposeCommand(),
          command: { ...FROZEN_COMMAND, payload: { invoice: 'invoice-2', reason: 'different' } },
        }),
      ),
    ).toBe('command_not_canonical');
    expect(store.all()).toEqual([]);
    expect(store.frozen()).toEqual([]);
  }),
);

it.effect('re-checks every witness at execution and lapses the mandate when one is gone', () =>
  Effect.gen(function* approvalsRecheck() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    projection.revoke(approverWitness(32, 42));
    expect(yield* codeOf(service.execute(executeCommand()))).toBe('authority_lost');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    yield* service.recheckAuthority({ proposalId: proposalId(201), scopeId: SCOPE, tenantId: TENANT });
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('refuses a witness the projection reports for another holder, mode or scope (R2-H1)', () =>
  Effect.gen(function* approvalsWitnessFacts() {
    const other = setup();
    // (a) Another person's live assignment is never the requester's own authority.
    other.projection.bind(approverWitness(11, 21), 'propose');
    expect(yield* codeOf(other.service.propose(proposeCommand()))).toBe('requester_authority_missing');
    expect(other.store.all()).toHaveLength(0);

    // (b) A propose-only grant never justifies the approve or the run witness of a mandate.
    const remoded = setup();
    allowMine(remoded.projection);
    remoded.projection.remodeGrant(approverWitness(31, 41), 'propose');
    yield* remoded.service.propose(proposeCommand());
    expect(yield* codeOf(remoded.service.approve(approveCommand()))).toBe('approval_authority_missing');

    const runRemoded = setup();
    allowMine(runRemoded.projection);
    runRemoded.projection.remodeGrant(approverWitness(32, 42), 'propose');
    yield* runRemoded.service.propose(proposeCommand());
    expect(yield* codeOf(runRemoded.service.approve(approveCommand()))).toBe('execution_authority_missing');
    expect(runRemoded.store.all().map(({ status }) => status)).toStrictEqual(['pending']);

    // (c) The same role revision held in another legal entity is not authority here (O49).
    const foreign = setup();
    allowMine(foreign.projection);
    foreign.projection.bind(requesterWitness(11, 21, capabilityKey(INVOICE_VOID)), 'propose');
    foreign.projection.moveGrant(requesterWitness(11, 21), OTHER_SCOPE);
    expect(yield* codeOf(foreign.service.propose(proposeCommand()))).toBe('requester_authority_missing');

    // A role edit that re-points the approval assignment to another revision lapses the mandate (O49).
    const rebound = setup();
    allowMine(rebound.projection);
    yield* rebound.service.propose(proposeCommand());
    yield* rebound.service.approve(approveCommand());
    rebound.projection.rebind(approverWitness(31, 41), OTHER_ROLE_REVISION);
    expect(yield* codeOf(rebound.service.execute(executeCommand()))).toBe('authority_lost');
    expect(rebound.store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    yield* rebound.service.recheckAuthority({ proposalId: proposalId(201), scopeId: SCOPE, tenantId: TENANT });
    expect(rebound.store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('verifies the approver assignment still belongs to the approval binding before executing (O49)', () =>
  Effect.gen(function* approvalsBinding() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    expect(store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    projection.rebind(approverWitness(31, 41), OTHER_ROLE_REVISION);
    expect(yield* codeOf(service.execute(executeCommand()))).toBe('authority_lost');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    yield* service.recheckAuthority({ proposalId: proposalId(201), scopeId: SCOPE, tenantId: TENANT });
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('only a verified person approves: agents and workloads never do (O46)', () =>
  Effect.gen(function* approvalsHumansOnly() {
    const { projection, service } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    expect(yield* codeOf(service.approve({ ...approveCommand(), approver: agentOf(2, 6, 7) }))).toBe(
      'approver_not_human',
    );
    for (const approverKind of ['agent', 'integration', 'service', 'system'] as const) {
      expect(yield* codeOf(service.approve({ ...approveCommand(), approverKind }))).toBe('approver_not_human');
    }
    expect((yield* service.approve(approveCommand())).status).toBe('approved');
  }),
);

it.effect('only a v2 subject proposes: workloads are refused and agents stay agents (O46)', () =>
  Effect.gen(function* approvalsSubjects() {
    const { projection, service } = setup();
    allowMine(projection);
    for (const requesterKind of ['integration', 'service', 'system'] as const) {
      expect(yield* codeOf(service.propose({ ...proposeCommand(), requesterKind }))).toBe('requester_not_v2_subject');
    }
    expect(yield* codeOf(service.propose({ ...proposeCommand(), requesterKind: 'agent' }))).toBe(
      'requester_not_v2_subject',
    );
    const agent = agentOf(1, 4, 5);
    projection.bind(requesterWitness(11, 21, capabilityKey(INVOICE_VOID), actorHolder(agent)), 'propose');
    const agentProposal = yield* service.propose({
      ...proposeCommand(),
      actor: agent,
      requesterAuthority: [requesterWitness(11, 21, capabilityKey(INVOICE_VOID), actorHolder(agent))],
      requesterKind: 'agent',
    });
    expect(agentProposal.status).toBe('pending');
  }),
);

it.effect('keeps an approved mandate when the authority projection cannot answer', () =>
  Effect.gen(function* approvalsUnavailable() {
    const store = makeInMemoryApprovalStore();
    const service = makeApprovalsService({
      administrators: makeScriptedScopeAdministration(),
      authority: makeUnavailableAuthorityInspector(),
      catalog: makeInMemoryApprovalCatalog([sensitiveCapability()]),
      clock: makeMutableApprovalClock(AT),
      identifiers: makeScriptedApprovalIdentifiers([proposalId(201)]),
      store,
    });
    expect(yield* codeOf(service.propose(proposeCommand()))).toBe('approval_authority_unavailable');
    expect(store.all()).toHaveLength(0);
  }),
);

it.effect('refuses a proposal for an unpublished capability or for authority that is already gone', () =>
  Effect.gen(function* approvalsRefusals() {
    const { projection, service, store } = setup();
    expect(yield* codeOf(service.propose(proposeCommand()))).toBe('requester_authority_missing');
    projection.revoke(requesterWitness(11, 21));
    expect(yield* codeOf(service.propose(proposeCommand()))).toBe('requester_authority_missing');
    expect(store.all()).toHaveLength(0);

    const unpublished = makeApprovalsService({
      administrators: makeScriptedScopeAdministration(),
      authority: makeScriptedProjection(ROLE_REVISION),
      catalog: makeInMemoryApprovalCatalog([]),
      clock: makeMutableApprovalClock(AT),
      identifiers: makeScriptedApprovalIdentifiers([proposalId(201)]),
      store: makeInMemoryApprovalStore(),
    });
    expect(yield* codeOf(unpublished.propose(proposeCommand()))).toBe('capability_not_proposable');
  }),
);

it.effect('refuses a second approval and a withdrawal of an executed mandate', () =>
  Effect.gen(function* approvalsMonotonic() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    expect(yield* codeOf(service.approve(approveCommand()))).toBe('proposal_not_pending');
    yield* service.execute(executeCommand());
    expect(yield* codeOf(service.withdraw(withdrawCommand()))).toBe('proposal_not_withdrawable');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['executed']);
  }),
);

it.effect('withdraws a live proposal and lapses an approved mandate through the store (O57)', () =>
  Effect.gen(function* approvalsWithdraw() {
    const { projection, service, store } = setup();
    projection.bind(requesterWitness(11, 21), 'propose');
    yield* service.propose(proposeCommand());
    const withdrawn = yield* service.withdraw(withdrawCommand());
    expect(withdrawn.status).toBe('rejected');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['rejected']);

    const mandateRun = setup();
    allowMine(mandateRun.projection);
    yield* mandateRun.service.propose(proposeCommand());
    const mandate = yield* mandateRun.service.approve(approveCommand());
    const withdrawnMandate = yield* mandateRun.service.withdraw(withdrawCommand());
    expect(withdrawnMandate.status).toBe('lapsed');
    expect(withdrawnMandate.approval).toStrictEqual(mandate.approval);
    expect(mandateRun.store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('lets only the requester, an eligible approver or a scope administrator withdraw (O61, O64)', () =>
  Effect.gen(function* approvalsWithdrawEligibility() {
    // There is no flag to claim any more: a bystander who is neither an approved decider nor an
    // administrator is refused, and the proposal stays where it is.
    const plain = setup();
    allowMine(plain.projection);
    yield* plain.service.propose(proposeCommand());
    expect(yield* codeOf(plain.service.withdraw(withdrawCommand({ actor: BYSTANDER })))).toBe(
      'withdrawal_not_permitted',
    );
    expect(plain.store.all().map(({ status }) => status)).toStrictEqual(['pending']);
    expect(plain.store.decisions()).toHaveLength(0);

    // The requester ends its own request without asking a port and with nothing to explain.
    expect((yield* plain.service.withdraw(withdrawCommand())).status).toBe('rejected');
    expect(plain.store.decisions()).toHaveLength(0);

    // An owner/administrator of the scope is a resolved fact, and the decision records its ground.
    const administered = setup([{ principalId: principalId(3), scopeId: SCOPE }]);
    allowMine(administered.projection);
    yield* administered.service.propose(proposeCommand());
    const byAdmin = yield* administered.service.withdraw(withdrawCommand({ actor: BYSTANDER }));
    expect(byAdmin.status).toBe('rejected');
    expect(byAdmin.rejectedBy).toBe(principalId(3));
    expect(administered.store.decisions()).toStrictEqual([
      { basis: 'administrator', decidedBy: principalId(3), witnesses: [] },
    ]);

    // An eligible approver withdraws with their own live approve authority, which the log keeps.
    const eligible = setup();
    allowMine(eligible.projection);
    yield* eligible.service.propose(proposeCommand());
    const byApprover = yield* eligible.service.withdraw(
      withdrawCommand({ actor: APPROVER, withdrawAuthority: [approverWitness(31, 41)] }),
    );
    expect(byApprover.status).toBe('rejected');
    expect(eligible.store.decisions()[0]?.basis).toBe('approver');
    expect(eligible.store.decisions()[0]?.witnesses.map(({ purpose }) => purpose)).toStrictEqual(['approval']);

    // An approve cell held in another scope is not authority here, however it is claimed.
    const foreignScope = setup();
    allowMine(foreignScope.projection);
    foreignScope.projection.moveGrant(approverWitness(31, 41), OTHER_SCOPE);
    yield* foreignScope.service.propose(proposeCommand());
    expect(
      yield* codeOf(
        foreignScope.service.withdraw(
          withdrawCommand({ actor: APPROVER, withdrawAuthority: [approverWitness(31, 41)] }),
        ),
      ),
    ).toBe('withdrawal_not_permitted');
    expect(foreignScope.store.all().map(({ status }) => status)).toStrictEqual(['pending']);

    // An administrator ends an approved mandate too: it lapses and the approval record stays (O57).
    const administeredMandate = setup([{ principalId: principalId(3), scopeId: SCOPE }]);
    allowMine(administeredMandate.projection);
    yield* administeredMandate.service.propose(proposeCommand());
    const mandate = yield* administeredMandate.service.approve(approveCommand());
    const lapsedMandate = yield* administeredMandate.service.withdraw(withdrawCommand({ actor: BYSTANDER }));
    expect(lapsedMandate.status).toBe('lapsed');
    expect(lapsedMandate.approval).toStrictEqual(mandate.approval);
    expect(administeredMandate.store.decisions()[0]?.basis).toBe('administrator');

    // An agent never ends somebody else's proposal, not even for the person it works for.
    const agentRun = setup([{ principalId: principalId(1), scopeId: SCOPE }]);
    allowMine(agentRun.projection);
    yield* agentRun.service.propose(proposeCommand());
    expect(yield* codeOf(agentRun.service.withdraw(withdrawCommand({ actor: agentOf(1, 4, 5) })))).toBe(
      'withdrawal_by_agent_forbidden',
    );
    expect(agentRun.store.all().map(({ status }) => status)).toStrictEqual(['pending']);
  }),
);

it.effect('lets an eligible approver reject and records the person and the witness (O61)', () =>
  Effect.gen(function* approvalsReject() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    const rejected = yield* service.reject(rejectCommand());
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectedBy).toBe(principalId(2));
    expect(rejected.approval).toBeUndefined();
    expect(store.all().map(({ status }) => status)).toStrictEqual(['rejected']);
    const recorded = store.decisions();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.basis).toBe('approver');
    expect(recorded[0]?.decidedBy).toBe(principalId(2));
    expect(recorded[0]?.witnesses.map(({ purpose }) => purpose)).toStrictEqual(['approval']);
    expect(recorded[0]?.witnesses[0]?.grantIncarnationId).toBe(approverWitness(31, 41).grantIncarnationId);
  }),
);

it.effect('lets a scope administrator reject without any approve authority (O61b)', () =>
  Effect.gen(function* approvalsRejectAdministrator() {
    const { projection, service, store } = setup([{ principalId: principalId(3), scopeId: SCOPE }]);
    allowMine(projection);
    yield* service.propose(proposeCommand());
    const rejected = yield* service.reject({
      ...rejectCommand([]),
      approver: BYSTANDER,
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectedBy).toBe(principalId(3));
    // An administrator's rejection relies on the scope fact, so it records the ground and no witness.
    expect(store.decisions()[0]).toStrictEqual({ basis: 'administrator', decidedBy: principalId(3), witnesses: [] });
  }),
);

it.effect('refuses a member who is neither an eligible approver nor a scope administrator (O61)', () =>
  Effect.gen(function* approvalsRejectMember() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    // A plain member with no approve authority at all.
    expect(yield* codeOf(service.reject({ ...rejectCommand([]), approver: BYSTANDER }))).toBe(
      'rejection_not_permitted',
    );
    // An administrator of another scope is not an administrator of this one.
    const otherScopeAdmin = setup([{ principalId: principalId(3), scopeId: OTHER_SCOPE }]);
    allowMine(otherScopeAdmin.projection);
    yield* otherScopeAdmin.service.propose(proposeCommand());
    expect(yield* codeOf(otherScopeAdmin.service.reject({ ...rejectCommand([]), approver: BYSTANDER }))).toBe(
      'rejection_not_permitted',
    );
    expect(store.all().map(({ status }) => status)).toStrictEqual(['pending']);
    expect(otherScopeAdmin.store.all().map(({ status }) => status)).toStrictEqual(['pending']);
    expect(store.decisions()).toHaveLength(0);
  }),
);

it.effect('refuses the requester: they withdraw their own proposal instead (P6, O61)', () =>
  Effect.gen(function* approvalsRejectRequester() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    expect(yield* codeOf(service.reject({ ...rejectCommand([]), approver: REQUESTER }))).toBe(
      'requester_cannot_reject',
    );
    // Even an administrator of the scope cannot reject their own proposal.
    const ownAdmin = setup([{ principalId: principalId(1), scopeId: SCOPE }]);
    allowMine(ownAdmin.projection);
    yield* ownAdmin.service.propose(proposeCommand());
    expect(yield* codeOf(ownAdmin.service.reject({ ...rejectCommand([]), approver: REQUESTER }))).toBe(
      'requester_cannot_reject',
    );
    expect(store.all().map(({ status }) => status)).toStrictEqual(['pending']);
  }),
);

it.effect('refuses a propose-only holder and an approve holder of another scope (O61a)', () =>
  Effect.gen(function* approvalsRejectWrongAuthority() {
    // A propose-mode cell never makes somebody an eligible approver.
    const proposeOnly = setup();
    allowMine(proposeOnly.projection);
    proposeOnly.projection.remodeGrant(approverWitness(31, 41), 'propose');
    yield* proposeOnly.service.propose(proposeCommand());
    expect(yield* codeOf(proposeOnly.service.reject(rejectCommand()))).toBe('rejection_not_permitted');
    expect(proposeOnly.store.all().map(({ status }) => status)).toStrictEqual(['pending']);

    // An approve cell held in another legal entity is not approve authority in this scope (O49).
    const foreignScope = setup();
    allowMine(foreignScope.projection);
    foreignScope.projection.moveGrant(approverWitness(31, 41), OTHER_SCOPE);
    yield* foreignScope.service.propose(proposeCommand());
    expect(yield* codeOf(foreignScope.service.reject(rejectCommand()))).toBe('rejection_not_permitted');
    expect(foreignScope.store.all().map(({ status }) => status)).toStrictEqual(['pending']);

    // The same witness handed in for another capability is a caller defect, never a rejection.
    const wrongCapability = setup();
    allowMine(wrongCapability.projection);
    yield* wrongCapability.service.propose(proposeCommand());
    expect(
      yield* codeOf(
        wrongCapability.service.reject(
          rejectCommand([approverWitness(31, 41, capabilityKey('finance.invoice.issue'))]),
        ),
      ),
    ).toBe('authority_witness_mismatch');
  }),
);

it.effect('refuses to reject an approved mandate (O57)', () =>
  Effect.gen(function* approvalsRejectMandate() {
    const mandateRun = setup();
    allowMine(mandateRun.projection);
    yield* mandateRun.service.propose(proposeCommand());
    yield* mandateRun.service.approve(approveCommand());
    expect(yield* codeOf(mandateRun.service.reject(rejectCommand()))).toBe('proposal_not_pending');
    expect(mandateRun.store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    expect(mandateRun.store.decisions()).toHaveLength(0);
  }),
);

it.effect('lapses open proposals when their authority is lost and expires them at the deadline', () =>
  Effect.gen(function* approvalsLapseAndExpire() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    const lapsed = yield* service.recordAuthorityLoss({
      authorityLoss: 'role_lost',
      principalId: principalId(2),
      scopeId: SCOPE,
      tenantId: TENANT,
    });
    expect(lapsed.map(({ status }) => status)).toStrictEqual(['lapsed']);
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);

    const second = setup();
    second.projection.bind(requesterWitness(11, 21), 'propose');
    yield* second.service.propose(proposeCommand());
    second.clock.set(plus(AT, 8 * 24 * HOUR_MS));
    const expired = yield* second.service.expireDue({ scopeId: SCOPE, tenantId: TENANT });
    expect(expired.map(({ status }) => status)).toStrictEqual(['expired']);
    expect(second.store.all().map(({ status }) => status)).toStrictEqual(['expired']);
  }),
);

it.effect('reaches every scope of the tenant when a departure is reported at tenant context (R2-H7)', () =>
  Effect.gen(function* approvalsTenantWideLoss() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    // The proposal lives in a legal-entity scope; the loss names only the tenant.
    const lapsed = yield* service.recordAuthorityLoss({
      authorityLoss: 'membership_lost',
      principalId: principalId(2),
      tenantId: TENANT,
    });
    expect(lapsed.map(({ status }) => status)).toStrictEqual(['lapsed']);
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('lapses every open proposal of an uninstalled module without a module key (R2-H7)', () =>
  Effect.gen(function* approvalsUninstall() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    const lapsed = yield* service.recordAuthorityLoss({
      authorityLoss: 'module_uninstalled',
      principalId: principalId(2),
      tenantId: TENANT,
    });
    expect(lapsed.map(({ status }) => status)).toStrictEqual(['lapsed']);
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('never revives a lapsed mandate when the module is reinstalled (R2-H7)', () =>
  Effect.gen(function* approvalsReinstall() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    yield* service.recordAuthorityLoss({
      authorityLoss: 'module_uninstalled',
      principalId: principalId(2),
      tenantId: TENANT,
    });
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
    // The module comes back and every witness is live again, but the approval is gone for good.
    allowMine(projection);
    const rechecked = yield* service.recheckAuthority({
      proposalId: proposalId(201),
      scopeId: SCOPE,
      tenantId: TENANT,
    });
    expect(rechecked.status).toBe('lapsed');
    expect(yield* codeOf(service.execute(executeCommand()))).toBe('proposal_lapsed');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('keeps a mandate on a role edit that keeps its witnesses and lapses it after a real loss', () =>
  Effect.gen(function* approvalsRoleEdit() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    const rechecked = yield* service.recheckAuthority({
      proposalId: proposalId(201),
      scopeId: SCOPE,
      tenantId: TENANT,
    });
    expect(rechecked.status).toBe('approved');
    projection.revoke(approverWitness(31, 41));
    const lapsed = yield* service.recheckAuthority({
      proposalId: proposalId(201),
      scopeId: SCOPE,
      tenantId: TENANT,
    });
    expect(lapsed.status).toBe('lapsed');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('executes only as the approving person, never as an agent (O63)', () =>
  Effect.gen(function* approvalsOnlyApproverExecutes() {
    const { projection, service } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    expect(yield* codeOf(service.execute({ ...executeCommand(), actor: REQUESTER }))).toBe('execution_not_permitted');
    expect(yield* codeOf(service.execute({ ...executeCommand(), actor: agentOf(1, 4, 5) }))).toBe(
      'agent_cannot_execute',
    );
    expect(yield* codeOf(service.execute({ ...executeCommand(), actor: agentOf(2, 6, 7) }))).toBe(
      'agent_cannot_execute',
    );
    expect((yield* service.execute(executeCommand())).status).toBe('executed');
  }),
);

it.effect('refuses an approval from somebody who no longer reaches the record (P5, N6)', () =>
  Effect.gen(function* approvalsApproveReach() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    // The record was reassigned: the approver still holds approve and run, but not on this record.
    projection.reassignRecord(approverWitness(31, 41));
    projection.reassignRecord(approverWitness(32, 42));
    expect(yield* codeOf(service.approve(approveCommand()))).toBe('approval_authority_missing');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['pending']);
    // The reassignment is what refused it: the same approval is accepted while the cells reach.
    projection.bind(approverWitness(31, 41), 'approve');
    projection.bind(approverWitness(32, 42), 'run');
    expect((yield* service.approve(approveCommand())).status).toBe('approved');
  }),
);

it.effect('takes the parent-record read from the catalog, never from the command (D30, O64, N6)', () =>
  Effect.gen(function* approvalsParentReadFromCatalog() {
    // The published entry names the read of the record, so the approver has to hold it too.
    const declared = setup();
    allowMine(declared.projection);
    yield* declared.service.propose(proposeCommand());
    const mandate = yield* declared.service.approve(approveCommand());
    expect(mandate.witnesses.find(({ purpose }) => purpose === 'parent_record_read')?.capabilityKey).toBe(
      capabilityKey(INVOICE_READ),
    );

    // An entry that names no read makes a record-scoped command unapprovable; a caller cannot fill it in.
    const readless: GovernedCapability = {
      capabilityKey: capabilityKey(INVOICE_VOID),
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      risk: 'sensitive',
      selectors: ['assigned'],
    };
    const undeclared = setup([], readless);
    allowMine(undeclared.projection);
    yield* undeclared.service.propose(proposeCommand());
    expect(yield* codeOf(undeclared.service.approve(approveCommand()))).toBe('parent_record_read_missing');
    expect(undeclared.store.all().map(({ status }) => status)).toStrictEqual(['pending']);
  }),
);

it.effect('lapses a mandate whose witness no longer reaches the record the command changes (N6)', () =>
  Effect.gen(function* approvalsTargetReach() {
    const { projection, service, store } = setup();
    allowMine(projection);
    yield* service.propose(proposeCommand());
    yield* service.approve(approveCommand());
    // The record is reassigned: the approver's run cell is still live, but it no longer reaches it.
    projection.reassignRecord(approverWitness(32, 42));
    expect(yield* codeOf(service.execute(executeCommand()))).toBe('authority_lost');
    expect(store.all().map(({ status }) => status)).toStrictEqual(['approved']);
    yield* service.recheckAuthority({ proposalId: proposalId(201), scopeId: SCOPE, tenantId: TENANT });
    expect(store.all().map(({ status }) => status)).toStrictEqual(['lapsed']);
  }),
);

it.effect('reports a mandate as absent instead of inventing one', () =>
  Effect.gen(function* approvalsMissing() {
    const { service } = setup();
    expect(yield* codeOf(service.execute(executeCommand()))).toBe('proposal_not_found');
    expect(yield* codeOf(service.approve({ ...approveCommand(), proposalId: proposalId(202) }))).toBe(
      'proposal_not_found',
    );
    expect(yield* codeOf(service.reject({ ...rejectCommand(), proposalId: proposalId(202) }))).toBe(
      'proposal_not_found',
    );
  }),
);

it.effect('keeps a stored proposal in its own tenant and scope', () =>
  Effect.gen(function* approvalsScope() {
    const { projection, service, store } = setup();
    allowMine(projection);
    const proposal = yield* service.propose(proposeCommand());
    const stored = store.all();
    expect(stored.map(({ id }) => id)).toStrictEqual([proposal.id]);
    expect(stored[0]?.scopeId).toBe(SCOPE);
    const witness: BoundWitness | undefined = stored[0]?.witnesses[0];
    expect(witness === undefined ? 'missing' : boundWitnessSlot(witness)).toBe(
      boundWitnessSlot(requesterWitness(11, 21)),
    );
  }),
);
