/*
 * Mandate dispatch protocol (P6, O63): the only executable command is the tenant-scoped, durable
 * frozen payload, never the execute request body. Decode mandateId, load and re-hash the frozen
 * command, prove its scope/capability/target and the approving human's identity, then recheck the
 * one gate and bound witnesses while holding the access fence. In the owner's SAME transaction,
 * CAS approved → executed with this Action invocation as receipt, run the handler, and commit the
 * receipt, invocation success and owner writes together. Rollback releases the mandate; an
 * ambiguous commit is resolved by the invocation/receipt, never by rerunning under a new id.
 * Until a transaction-joining approvals store and frozen-command repository are wired, mandate
 * requests fail closed: an independent Approvals.execute transaction would consume authority before
 * an owner commit, and a post-commit CAS could execute the owner twice. The joining halves now exist
 * — `executeInTransaction`, `makeJoinedDrizzleApprovalStore`, the frozen-command store and
 * `ApprovalsPorts.inTransaction`, which binds the witness, membership, role-binding, record and
 * acting-person-kind reads to `input.transaction` — and this adapter stays off until an owner binds
 * it and the runner's own proposal lock is proved against them.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Context, DateTime, Effect, Option, Result, Schema } from 'effect';

import { freezeCommand, FrozenCommandSchema } from './command.ts';
import type { FrozenCommand } from './command.ts';
import { ActionKeySchema, verifyFrozenCommand } from './frozen-command.ts';
import type { FrozenCommandRecord, FrozenCommandStore } from './frozen-command.ts';
import type { AccessPrincipalKinds } from '../enforcement/actor.ts';
import type { AccessDecision } from '../decision/contract.ts';
import {
  AccessScopeIdSchema,
  CommandDigestSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  TenantIdSchema,
} from '../ids.ts';
import type { CapabilityKey, CommandDigest, ProposalId, RecordKey, AccessScopeId } from '../ids.ts';
import type { AuthorityWitness } from '../model.ts';
import { withOptional } from '../decision/optional.ts';
import { ApprovalAuthorityUnavailableError, ApprovalStorageUnavailableError } from './errors.ts';
import { uniqueBoundWitnesses } from './proposal.ts';
import type { BoundWitness } from './proposal.ts';
import { ActionInvocationRefSchema } from './execution.ts';
import type { ApprovalsService } from './service.ts';
import type { ActionTransportMetadata } from '../../actions/context.ts';
import {
  ActionPermissionDenied as ActionPermissionDeniedError,
  ActionPermissionCheckError,
} from '../../actions/errors.ts';
import {
  accessFrozenCommands,
  accessMandates,
  accessProposals,
  accessScopes,
  actionInvocations,
} from '../../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityScope } from '../../operations/legal-entity-scope.ts';

/** Trusted command loaded from the proposal's append-only record; never an execute-request body. */
export interface MandatePrepared {
  readonly approverId: string;
  readonly command: FrozenCommand;
  readonly commandDigest: string;
  readonly mandateId: NonNullable<ActionTransportMetadata['mandateId']>;
  readonly proposalId: string;
  readonly scopeId: string;
}

/**
 * Only a transaction-joining implementation may be bound to the owner runner. `prepare` checks
 * stored identities and hashes; `claim` locks the mandate row and rechecks its witnesses before
 * handler entry; `commit` performs the approved→executed CAS/receipt after owner success evidence.
 * The row lock lasts until the caller's transaction commits. All three are required: an omitted
 * implementation keeps mandate execution disabled rather than silently taking a direct-run grant.
 *
 * The same adapter parks a proposal (O80, O85, O90): `parkProposal` writes the proposal, its frozen
 * command and the invocation's terminal `proposed` receipt in the owner's one transaction, and
 * `loadParkedProposal` answers a retried propose request with the receipt it already stored.
 */
export interface ActionMandateDispatch {
  readonly claim: (
    input: MandateTransactionInput,
  ) => Effect.Effect<void, ActionPermissionDeniedError | ActionPermissionCheckError>;
  readonly commit: (
    input: MandateTransactionInput,
  ) => Effect.Effect<void, ActionPermissionDeniedError | ActionPermissionCheckError>;
  /** The stored 202 of an already parked invocation; `None` when it parked no proposal. */
  readonly loadParkedProposal: (input: {
    readonly actionInvocationId: string;
    readonly scope: OperationalScope;
  }) => Effect.Effect<Option.Option<ActionProposalParked>, ActionPermissionDeniedError | ActionPermissionCheckError>;
  /** Proposal, frozen command and the terminal `proposed` receipt commit together or not at all. */
  readonly parkProposal: (
    input: ActionProposalParkInput,
  ) => Effect.Effect<ActionProposalParked, ActionPermissionDeniedError | ActionPermissionCheckError>;
  readonly prepare: (input: {
    readonly actionKey: string;
    readonly administrative?: boolean;
    readonly capabilityKey: string;
    readonly legalEntityScope?: LegalEntityScope;
    readonly mandateId: NonNullable<ActionTransportMetadata['mandateId']>;
    readonly requestPayload: unknown;
    readonly scope: OperationalScope;
  }) => Effect.Effect<MandatePrepared, ActionPermissionDeniedError | ActionPermissionCheckError>;
}

/** The parked proposal the runner answers 202 with; it never carries a handler result (O85). */
export interface ActionProposalParked {
  readonly expiresAt: Date;
  readonly proposalId: ProposalId;
}

/**
 * The owner command the runner freezes. The encoded payload is the request's own, the capability and
 * target are the registered declaration's, and the witnesses are the gate's NEEDS_APPROVAL evidence
 * (O85): nothing here is a caller's claim about its own authority.
 */
export interface ActionProposalParkInput {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly capabilityKey: CapabilityKey;
  readonly decision: AccessDecision;
  readonly now: Date;
  /** The encoded wire form of the decoded request payload; anything not JSON is refused. */
  readonly payload: unknown;
  readonly scope: OperationalScope;
  readonly target?: RecordKey;
  readonly transaction: CoreTransaction;
}

export interface MandateTransactionInput {
  readonly actionInvocationId: string;
  readonly now: Date;
  readonly prepared: MandatePrepared;
  readonly scope: OperationalScope;
  readonly transaction: CoreTransaction;
}

const fenceUnavailable = (cause?: unknown) => {
  const failure = new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'The access authority of this Action could not be pinned to its transaction',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { value: cause });
  }
  return failure;
};

/** The one access scope of a tenant context (no company) or of one company; anything else is the typed 503. */
const scopeFenceOf = Effect.fn('ActionMandateDispatch.scopeFenceOf')(function* scopeFenceOfEffect(
  transaction: CoreTransaction,
  tenantId: OperationalScope['tenantId'],
  legalEntityId?: OperationalScope['legalEntityId'],
) {
  const scopes = yield* transaction
    .select({ scopeId: accessScopes.scopeId })
    .from(accessScopes)
    .where(
      and(
        eq(accessScopes.tenantId, tenantId),
        legalEntityId === undefined
          ? isNull(accessScopes.legalEntityId)
          : eq(accessScopes.legalEntityId, legalEntityId),
      ),
    )
    .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
  const [resolved] = scopes;
  return scopes.length === 1 && resolved !== undefined ? resolved.scopeId : yield* fenceUnavailable();
});

/** Holds one scope's fence to commit; only a Ready fence admits, so a Changing writer is a 503. */
const lockScopeFence = Effect.fn('ActionMandateDispatch.lockScopeFence')(function* lockScopeFenceEffect(
  transaction: CoreTransaction,
  tenantId: OperationalScope['tenantId'],
  scopeId: string,
) {
  const fences = yield* transaction
    .execute<{ readonly state: string | null }>(
      sql`select trust.lock_access_scope_fence(${tenantId}::uuid, ${scopeId}::uuid) as state`,
      'objects',
    )
    .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
  return fences.length === 1 && fences[0]?.state === 'Ready' ? yield* Effect.void : yield* fenceUnavailable();
});

/**
 * The same scope fence the intent/projection writer changes from Ready to Changing. A shared row
 * lock is held to commit: an exclusive writer cannot acquire the fence between the second gate
 * decision and the owner write. Missing/Changing/Unavailable is 503, never an implicit grant.
 * This is not a replacement for the one gate: the runner re-decides while holding this lock.
 *
 * Request identities hold no grant on `core.access_scope_fences`. The lock is taken by the
 * `trust.lock_access_scope_fence` routine, which only reaches a fence of the tenant the transaction's
 * established scope allows. Any SQL failure of either read is the typed 503, never a defect.
 */
export const lockActionAccessFence = Effect.fn('ActionMandateDispatch.lockAccessFence')(
  function* lockActionAccessFenceEffect(
    transaction: CoreTransaction,
    scope: OperationalScope,
    legalEntityScope: LegalEntityScope,
    administrative: boolean,
  ) {
    if (!administrative && legalEntityScope === 'required' && scope.legalEntityId === undefined) {
      return yield* fenceUnavailable();
    }
    const company = !administrative && legalEntityScope === 'required' ? scope.legalEntityId : undefined;
    // The projection writer turns the tenant context's fence to Changing for the whole tenant and projects
    // every company under it, so that is the fence a decision must hold. A company Action also holds its
    // own company's fence, taken second in the writer's order, so neither scope can change under it.
    const tenantFence = yield* scopeFenceOf(transaction, scope.tenantId);
    yield* lockScopeFence(transaction, scope.tenantId, tenantFence);
    return company === undefined
      ? yield* Effect.void
      : yield* lockScopeFence(transaction, scope.tenantId, yield* scopeFenceOf(transaction, scope.tenantId, company));
  },
);

const refused = (reason: string) => new ActionPermissionDeniedError({ code: 'action_permission_denied', reason });

/** A refusal of a proposal request: the caller may not park this command, and approval stays required. */
const refusedProposal = (reason: string) =>
  new ActionPermissionDeniedError({ code: 'action_approval_required', reason });

/** The refusal vocabulary of `Approvals.propose`, mapped onto the Action's own two channels. */
const proposalFailure = (error: {
  readonly _tag: string;
  readonly reason?: string | undefined;
}): ActionPermissionDeniedError | ActionPermissionCheckError => {
  if (Schema.is(ApprovalAuthorityUnavailableError)(error) || Schema.is(ApprovalStorageUnavailableError)(error)) {
    return fenceUnavailable();
  }
  return refusedProposal(error.reason ?? 'The proposal could not be recorded');
};

/** A missing/foreign/ended mandate is never authority; storage/identity outages remain retryable. */
export interface MandateDispatchDependencies {
  /** Binds the existing approvals service to the caller's own scoped store and authority inspector. */
  readonly approvalsFor: (scope: OperationalScope) => ApprovalsService;
  readonly database: { readonly executor: CoreDatabaseExecutor };
  readonly frozenCommands: FrozenCommandStore;
  readonly principalKinds: AccessPrincipalKinds;
}

/**
 * Production adapter. The proposal lock and `Approvals.execute` share the OWNER transaction; the
 * service rechecks every bound witness (requester, approval, execution, parent read), human identity,
 * digest and deadline BEFORE the handler. Its CAS is uncommitted until the Action's success marker,
 * audit evidence and business writes commit. This adapter must be explicitly bound by the owner;
 * merely transporting a mandate ID never enables it.
 */
type PrepareInput = Parameters<ActionMandateDispatch['prepare']>[0];

const matchingFrozenCommand = (
  input: PrepareInput,
  row: {
    readonly commandDigest: string;
    readonly proposalDigest: string;
    readonly proposalId: string;
    readonly scopeId: string;
    readonly target: string | null;
  },
  record: FrozenCommandRecord,
): boolean =>
  record.tenantId === input.scope.tenantId &&
  record.scopeId === row.scopeId &&
  record.proposalId === row.proposalId &&
  record.commandDigest === row.commandDigest &&
  row.commandDigest === row.proposalDigest &&
  record.actionKey === input.actionKey &&
  record.command.capabilityKey === input.capabilityKey &&
  (record.command.target ?? null) === row.target;

const approvalExpired = (
  row: { readonly approvalExpiresAt: Date; readonly proposalExpiresAt: Date },
  now: Date,
): boolean => now >= row.approvalExpiresAt || now >= row.proposalExpiresAt;

/**
 * The proposal's own row, read through the caller's transaction: never a second connection. Each row
 * carries the invocation's terminal receipt, so "a proposal exists" and "the invocation finished by
 * proposing it" are one fact (O90.3).
 */
const proposedReceiptRow = (transaction: CoreTransaction, scope: OperationalScope, actionInvocationId: string) =>
  transaction
    .select({
      capabilityKey: accessProposals.capabilityKey,
      commandDigest: accessProposals.commandDigest,
      completedAt: actionInvocations.completedAt,
      expiresAt: accessProposals.expiresAt,
      proposalId: accessProposals.proposalId,
      scopeId: accessProposals.scopeId,
      status: actionInvocations.status,
      target: accessProposals.target,
    })
    .from(actionInvocations)
    .innerJoin(
      accessProposals,
      and(
        eq(accessProposals.tenantId, actionInvocations.tenantId),
        eq(accessProposals.actionInvocationId, actionInvocations.actionInvocationId),
        eq(accessProposals.requesterPrincipalId, actionInvocations.principalId),
      ),
    )
    .innerJoin(
      accessFrozenCommands,
      and(
        eq(accessFrozenCommands.tenantId, accessProposals.tenantId),
        eq(accessFrozenCommands.proposalId, accessProposals.proposalId),
        eq(accessFrozenCommands.scopeId, accessProposals.scopeId),
        eq(accessFrozenCommands.capabilityKey, accessProposals.capabilityKey),
        eq(accessFrozenCommands.commandDigest, accessProposals.commandDigest),
        eq(accessFrozenCommands.actionKey, actionInvocations.actionKey),
      ),
    )
    .where(
      and(
        eq(actionInvocations.tenantId, scope.tenantId),
        eq(actionInvocations.principalId, scope.principalId),
        eq(actionInvocations.actionInvocationId, actionInvocationId),
      ),
    )
    .limit(2)
    .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));

/** The one terminal state a propose request ends in; anything else is no receipt for this request. */
const isProposedReceipt = (row: { readonly completedAt: Date | null; readonly status: string }): boolean =>
  row.status === 'proposed' && row.completedAt !== null;

const parkedOf = (row: { readonly expiresAt: Date; readonly proposalId: string }): ActionProposalParked => ({
  expiresAt: row.expiresAt,
  proposalId: ProposalIdSchema.make(row.proposalId),
});

/**
 * O90.3: the invocation's terminal `proposed` receipt, written in the owner's own transaction and only
 * for a proposal that is already durable there. A zero-row update means the invocation moved, so the
 * whole transaction (proposal, frozen command and receipt) rolls back and the same key may retry.
 *
 * A duplicate propose does not raise: the proposal insert is a skipped row and this UPDATE matches
 * nothing once the winner's receipt committed, which leaves the transaction usable. The stored
 * receipt is then read here instead of being lost to an aborted transaction (SQLSTATE 25P02).
 */
const settleProposedReceipt = Effect.fn('ActionMandateDispatch.settleProposedReceipt')(
  function* settleProposedReceiptEffect(
    input: ActionProposalParkInput,
    parked: ActionProposalParked,
    commandDigest: CommandDigest,
  ) {
    const receipts = yield* input.transaction
      .update(actionInvocations)
      .set({ completedAt: input.now, status: 'proposed' })
      .where(
        and(
          eq(actionInvocations.tenantId, input.scope.tenantId),
          eq(actionInvocations.actionInvocationId, input.actionInvocationId),
          eq(actionInvocations.actionKey, input.actionKey),
          eq(actionInvocations.principalId, input.scope.principalId),
          eq(actionInvocations.status, 'received'),
        ),
      )
      .returning({ actionInvocationId: actionInvocations.actionInvocationId })
      .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
    if (receipts.length === 1) {
      return parked;
    }
    const rows = yield* proposedReceiptRow(input.transaction, input.scope, input.actionInvocationId);
    const [row] = rows;
    if (
      rows.length !== 1 ||
      row === undefined ||
      !isProposedReceipt(row) ||
      row.proposalId !== parked.proposalId ||
      row.capabilityKey !== input.capabilityKey ||
      row.commandDigest !== commandDigest ||
      (row.target ?? null) !== (input.target ?? null)
    ) {
      return yield* fenceUnavailable();
    }
    return parkedOf(row);
  },
);

/** The propose-mode witnesses the gate resolved for this command, and the one scope they share. */
const requesterAuthorityOf = (
  decision: AccessDecision,
  capabilityKey: CapabilityKey,
): Result.Result<{ readonly requesterAuthority: readonly BoundWitness[]; readonly scopeId: AccessScopeId }, string> => {
  const witnesses: AuthorityWitness[] = [];
  for (const { witness } of decision.evidence) {
    if (witness.capabilityKey === capabilityKey) {
      witnesses.push(witness);
    }
  }
  const [firstWitness] = witnesses;
  if (firstWitness === undefined || witnesses.some((witness) => witness.scopeId !== firstWitness.scopeId)) {
    return Result.fail('The gate resolved no single propose scope for this command');
  }
  return Result.succeed({
    requesterAuthority: uniqueBoundWitnesses(
      witnesses.map((witness) => ({
        assignmentIncarnationId: witness.assignmentIncarnationId,
        capabilityKey: witness.capabilityKey,
        grantIncarnationId: witness.grantIncarnationId,
        holderId: witness.holderId,
        scopeId: witness.scopeId,
      })),
    ),
    scopeId: firstWitness.scopeId,
  });
};

export class MandateDispatchPorts extends Context.Service<MandateDispatchPorts, MandateDispatchDependencies>()(
  '@app/core-runtime/access/approvals/action-mandate-dispatch/MandateDispatchPorts',
) {}

export const makeDrizzleActionMandateDispatch = Effect.fn('ActionMandateDispatch.makeDrizzle')(
  function* makeDrizzleActionMandateDispatchEffect() {
    const ports = yield* MandateDispatchPorts;
    const prepare: ActionMandateDispatch['prepare'] = Effect.fn('ActionMandateDispatch.prepare')(
      function* prepareMandate(input) {
        if (input.requestPayload !== undefined && input.requestPayload !== null) {
          return yield* refused('Mandate execution cannot take a request-supplied command');
        }
        const kind = yield* ports.principalKinds
          .readKind({
            principalId: PrincipalIdSchema.make(input.scope.principalId),
            scope: input.scope,
            tenantId: TenantIdSchema.make(input.scope.tenantId),
          })
          .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
        if (Option.isNone(kind) || kind.value !== 'human') {
          return yield* refused('Only the approving human executes a mandate');
        }
        const rows = yield* ports.database.executor
          .transaction((transaction) =>
            installOperationalScope(transaction, input.scope).pipe(
              Effect.andThen(() =>
                transaction
                  .select({
                    approvalExpiresAt: accessMandates.approvalExpiresAt,
                    approverId: accessMandates.approverId,
                    commandDigest: accessMandates.commandDigest,
                    legalEntityId: accessScopes.legalEntityId,
                    proposalDigest: accessProposals.commandDigest,
                    proposalExpiresAt: accessProposals.expiresAt,
                    proposalId: accessMandates.proposalId,
                    scopeId: accessMandates.scopeId,
                    status: accessProposals.status,
                    target: accessProposals.target,
                  })
                  .from(accessMandates)
                  .innerJoin(
                    accessProposals,
                    and(
                      eq(accessProposals.tenantId, accessMandates.tenantId),
                      eq(accessProposals.proposalId, accessMandates.proposalId),
                    ),
                  )
                  .innerJoin(
                    accessScopes,
                    and(
                      eq(accessScopes.tenantId, accessMandates.tenantId),
                      eq(accessScopes.scopeId, accessMandates.scopeId),
                    ),
                  )
                  .where(
                    and(
                      eq(accessMandates.tenantId, input.scope.tenantId),
                      eq(accessMandates.mandateId, input.mandateId),
                    ),
                  )
                  .limit(1),
              ),
            ),
          )
          .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
        const [row] = rows;
        if (row === undefined || row.approverId !== input.scope.principalId) {
          return yield* refused('This mandate does not belong to the approving person in this tenant');
        }
        const expectedLegalEntity =
          input.administrative === true || input.legalEntityScope !== 'required'
            ? null
            : (input.scope.legalEntityId ?? null);
        if (row.legalEntityId !== expectedLegalEntity) {
          return yield* refused('The mandate is outside this Action scope');
        }
        const frozen = yield* ports.frozenCommands
          .load(input.scope, {
            proposalId: ProposalIdSchema.make(row.proposalId),
            scopeId: AccessScopeIdSchema.make(row.scopeId),
          })
          .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
        if (Option.isNone(frozen)) {
          return yield* refused('The mandate has no durable frozen owner command');
        }
        const verified = verifyFrozenCommand(frozen.value);
        if (Result.isFailure(verified)) {
          return yield* refused('The frozen owner command failed its integrity check');
        }
        const record = verified.success;
        if (!matchingFrozenCommand(input, row, record)) {
          return yield* refused('The owner Action or payload differs from the approved frozen command');
        }
        // An executed retry must first prove the SAME succeeded invocation/receipt. The runner then
        // returns ActionAlreadyCommitted for that deterministic request hash, without rerunning it.
        if (row.status === 'executed') {
          const receipts = yield* ports.database.executor
            .transaction((transaction) =>
              installOperationalScope(transaction, input.scope).pipe(
                Effect.andThen(() =>
                  transaction
                    .select({ invocationId: actionInvocations.actionInvocationId, status: actionInvocations.status })
                    .from(actionInvocations)
                    .innerJoin(
                      accessProposals,
                      eq(accessProposals.executionOperationId, actionInvocations.actionInvocationId),
                    )
                    .where(
                      and(
                        eq(accessProposals.proposalId, row.proposalId),
                        eq(accessProposals.tenantId, input.scope.tenantId),
                        eq(actionInvocations.tenantId, input.scope.tenantId),
                        eq(actionInvocations.principalId, input.scope.principalId),
                        eq(actionInvocations.actionKey, input.actionKey),
                        eq(actionInvocations.idempotencyKey, `mandate:${input.mandateId}`),
                      ),
                    )
                    .limit(1),
                ),
              ),
            )
            .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
          if (receipts[0]?.status !== 'succeeded') {
            return yield* fenceUnavailable();
          }
        } else if (row.status !== 'approved') {
          return yield* refused('This mandate is not approved and live');
        }
        const now = yield* DateTime.nowAsDate;
        if (row.status === 'approved' && approvalExpired(row, now)) {
          return yield* refused('This mandate has expired');
        }
        return {
          approverId: row.approverId,
          command: record.command,
          commandDigest: record.commandDigest,
          mandateId: input.mandateId,
          proposalId: row.proposalId,
          scopeId: row.scopeId,
        };
      },
    );

    const claim: ActionMandateDispatch['claim'] = Effect.fn('ActionMandateDispatch.claim')(
      function* claimMandate(input) {
        const rows = yield* input.transaction
          .select({
            approverId: accessMandates.approverId,
            digest: accessProposals.commandDigest,
            proposalId: accessProposals.proposalId,
            scopeId: accessProposals.scopeId,
            status: accessProposals.status,
            target: accessProposals.target,
          })
          .from(accessProposals)
          .innerJoin(
            accessMandates,
            and(
              eq(accessMandates.tenantId, accessProposals.tenantId),
              eq(accessMandates.proposalId, accessProposals.proposalId),
            ),
          )
          .where(
            and(
              eq(accessProposals.tenantId, input.scope.tenantId),
              eq(accessMandates.mandateId, input.prepared.mandateId),
            ),
          )
          // Only the proposal changes during claim. Mandate rows are immutable; locking the joined
          // mandate as well would require granting UPDATE on authority that must remain append-only.
          .for('update', { of: accessProposals })
          .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
        const [row] = rows;
        if (
          row === undefined ||
          row.status !== 'approved' ||
          row.proposalId !== input.prepared.proposalId ||
          row.scopeId !== input.prepared.scopeId ||
          row.digest !== input.prepared.commandDigest ||
          row.approverId !== input.scope.principalId ||
          row.approverId !== input.prepared.approverId ||
          (row.target ?? null) !== (input.prepared.command.target ?? null)
        ) {
          return yield* refused('The approved mandate changed before the owner Action started');
        }
        /*
         * The proposal row is locked above in THIS transaction, so the service is handed the same one:
         * with `inTransaction` available it re-reads the stored proposal and every bound witness —
         * cells, membership path, role bindings — in `input.transaction`, and without it the call is
         * unavailable instead of being proved by a second connection (O75).
         */
        const executed = yield* ports
          .approvalsFor(input.scope)
          .execute(
            {
              actionInvocationId: ActionInvocationRefSchema.make(input.actionInvocationId),
              actor: { _tag: 'Principal', principalId: PrincipalIdSchema.make(input.scope.principalId) },
              commandDigest: CommandDigestSchema.make(input.prepared.commandDigest),
              proposalId: ProposalIdSchema.make(row.proposalId),
              scopeId: AccessScopeIdSchema.make(row.scopeId),
              tenantId: TenantIdSchema.make(input.scope.tenantId),
            },
            { transaction: input.transaction },
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(ApprovalAuthorityUnavailableError)(error) || Schema.is(ApprovalStorageUnavailableError)(error)
                ? fenceUnavailable()
                : refused('Mandate execution is no longer permitted'),
            ),
          );
        if (executed.execution?.actionInvocationId !== input.actionInvocationId) {
          return yield* fenceUnavailable();
        }
        return yield* Effect.void;
      },
    );

    const commit: ActionMandateDispatch['commit'] = Effect.fn('ActionMandateDispatch.commit')(
      function* verifyReceipt(input) {
        const rows = yield* input.transaction
          .select({
            executionOperationId: accessProposals.executionOperationId,
            status: accessProposals.status,
          })
          .from(accessProposals)
          .where(
            and(
              eq(accessProposals.tenantId, input.scope.tenantId),
              eq(accessProposals.proposalId, input.prepared.proposalId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
        if (rows[0]?.status !== 'executed' || rows[0]?.executionOperationId !== input.actionInvocationId) {
          return yield* fenceUnavailable();
        }
        return yield* Effect.void;
      },
    );
    /**
     * O90.4: the stored 202 of an invocation that already parked its proposal. It answers only the
     * invocation's own terminal `proposed` receipt joined to the proposal it names, so a stray
     * proposal row is never mistaken for a finished request.
     */
    const loadParkedProposal: ActionMandateDispatch['loadParkedProposal'] = Effect.fn(
      'ActionMandateDispatch.loadParkedProposal',
    )(function* loadParkedProposalEffect(input) {
      const rows = yield* ports.database.executor
        .transaction((transaction) =>
          installOperationalScope(transaction, input.scope).pipe(
            Effect.andThen(() => proposedReceiptRow(transaction, input.scope, input.actionInvocationId)),
          ),
        )
        .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
      const [row] = rows;
      if (rows.length > 1) {
        return yield* fenceUnavailable();
      }
      // A proposal row is not a receipt: only the invocation's own terminal `proposed` state, joined
      // to the proposal it names, is the 202 this request already earned (O90.3).
      if (row === undefined || !isProposedReceipt(row)) {
        return Option.none<ActionProposalParked>();
      }
      return Option.some(parkedOf(row));
    });

    /**
     * O75/O90: one transaction writes the proposal, its append-only frozen command and the invocation's
     * terminal `proposed` receipt. A rolled-back owner transaction therefore leaves neither a proposal
     * nor a receipt, so the same idempotency key can retry; a committed one answers the same 202.
     */
    const parkProposal: ActionMandateDispatch['parkProposal'] = Effect.fn('ActionMandateDispatch.parkProposal')(
      function* parkProposalEffect(input) {
        const decodedCommand = Schema.decodeUnknownResult(FrozenCommandSchema)(
          withOptional({ capabilityKey: input.capabilityKey, payload: input.payload }, 'target', input.target),
        );
        if (Result.isFailure(decodedCommand)) {
          return yield* refusedProposal('The owner command is not canonical JSON');
        }
        const command = decodedCommand.success;
        const digest = freezeCommand(command);
        if (Result.isFailure(digest)) {
          return yield* refusedProposal('The owner command cannot be frozen canonically');
        }
        const commandDigest = CommandDigestSchema.make(digest.success);
        const requester = requesterAuthorityOf(input.decision, input.capabilityKey);
        if (Result.isFailure(requester)) {
          return yield* refusedProposal(requester.failure);
        }
        /*
         * The acting person's kind is read in the SAME transaction the proposal, its frozen command and
         * its receipt are written in (O75): a kind read through the pool would be a second connection's
         * answer about another instant, and on one connection PostgreSQL refuses the inner transaction.
         */
        const kind = yield* ports.principalKinds
          .readKind(
            {
              principalId: PrincipalIdSchema.make(input.scope.principalId),
              scope: input.scope,
              tenantId: TenantIdSchema.make(input.scope.tenantId),
            },
            input.transaction,
          )
          .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
        // An agent never parks an administrative command, and this wave admits no agent Action at all
        // (O67-Q5, O14): the proposal is always the requesting person's own.
        if (Option.isNone(kind) || kind.value !== 'human') {
          return yield* refusedProposal('Only a person can request an approval for this Action');
        }
        const parked = yield* ports
          .approvalsFor(input.scope)
          .propose(
            withOptional(
              {
                actionInvocationId: ActionInvocationRefSchema.make(input.actionInvocationId),
                actionKey: ActionKeySchema.make(input.actionKey),
                actor: { _tag: 'Principal', principalId: PrincipalIdSchema.make(input.scope.principalId) },
                capabilityKey: input.capabilityKey,
                command,
                commandDigest,
                requesterAuthority: requester.success.requesterAuthority,
                requesterKind: 'human' as const,
                scopeId: requester.success.scopeId,
                tenantId: TenantIdSchema.make(input.scope.tenantId),
              },
              'target',
              input.target,
            ),
            { transaction: input.transaction },
          )
          .pipe(
            Effect.map((proposal): ActionProposalParked => ({
              expiresAt: proposal.expiresAt,
              proposalId: proposal.id,
            })),
            Effect.mapError((error) => (Schema.is(ActionPermissionCheckError)(error) ? error : proposalFailure(error))),
          );
        return yield* settleProposedReceipt(input, parked, commandDigest);
      },
    );
    return Object.freeze({ claim, commit, loadParkedProposal, parkProposal, prepare });
  },
);
