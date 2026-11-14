import { and, eq, inArray } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Context, Crypto, Effect, Layer, Option, Result, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

import { isDatabaseIntegrityRefusal, isDatabaseUnavailableFailure } from '../../database/driver-failure.ts';
import { isPostgresUniqueViolation } from '../../database/postgres-failure.ts';
import {
  accessAssignments,
  accessDecisionLogs,
  accessFrozenCommands,
  accessMandateGrants,
  accessMandates,
  accessProposals,
} from '../../db/schema.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { ProposalIdSchema } from '../ids.ts';
import type { AccessScopeId, ProposalId } from '../ids.ts';
import type { Holder, Proposal, ProposalStatus } from '../model.ts';
import { HolderSchema, canTransitionProposalStatus } from '../model.ts';
import type { ApprovalDecisionEvidence, ApprovalProposalRecords } from './service.ts';
import { ApprovalStorageConflictError, ApprovalStorageUnavailableError } from './errors.ts';
import type { ActionInvocationRef } from './execution.ts';
import type {
  FrozenCommandConflictError,
  FrozenCommandIntegrityError,
  FrozenCommandRecord,
  FrozenCommandStore,
} from './frozen-command.ts';
import {
  FrozenCommandConflictErrorSchema,
  FrozenCommandIntegrityErrorSchema,
  FrozenCommands,
  verifyFrozenCommand,
} from './frozen-command.ts';
import {
  decisionRecordInsert,
  mandateColumns,
  mandateGrantColumns,
  mandateGrantValues,
  mandateInsertValues,
  proposalColumns,
  proposalFrom,
  proposalInsertValues,
  proposalTransitionValues,
  witnessOfRow,
} from './persistence/records.ts';
import type { EncodedWitness, MandateRow, ProposalRow } from './persistence/records.ts';

/*
 * The Drizzle store behind the approval records. The proposal row owns the whole lifecycle (O52), so
 * every transition is a compare-and-set on its status: a second execution of one mandate, a lapse
 * racing an approval and a stale writer all lose the same way, and the loser is told it lost instead
 * of overwriting the decision that won. The approval record and its witness rows are append-only
 * evidence, and the decision that ends a proposal is appended to the decision log (O61) — all in the
 * same transaction as the transition they describe.
 *
 * Every call arrives with the trusted `OperationalScope` of the request and installs it on its
 * transaction before it reads or writes, because the access tables force tenant row-level security on
 * `ontos_runtime` (O66). The store never binds a tenant to itself and never takes one from the record
 * it is asked to write: a command whose tenant or acting person is not the scope's own is refused
 * before SQL sees it.
 */

/**
 * The Core executor the store is built over; the caller owns the pool, its scope and its deadlines.
 *
 * A store that must read and write inside a transaction an owner Action already holds is built by
 * `makeJoinedDrizzleApprovalStore` instead, with that transaction: a mandate's own read then joins the
 * transaction whose lock and receipt it is part of (O75).
 */
export interface ApprovalStoreDatabase {
  /** The enrolled database identities the installed scope is verified against. */
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly executor: CoreDatabaseExecutor;
  /** Optional until the append-only repository is installed; proposals then fail closed. */
  readonly frozenCommands?: FrozenCommandStore;
}

/** The store an owner Action builds over the transaction it already owns (O75). */
export interface JoinedApprovalStoreDatabase {
  /** The enrolled database identities the installed scope is verified against. */
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly frozenCommands?: FrozenCommandStore;
  /** The caller's transaction: the store reads and writes in it and never ends it. */
  readonly transaction: CoreTransaction;
}

/** One transition of one proposal, exactly as the approvals service asks for it. */
export interface SaveApprovalInput {
  readonly evidence?: ApprovalDecisionEvidence;
  readonly expectedStatus: ProposalStatus;
  readonly proposal: Proposal;
  readonly reason?: string;
}

/**
 * One end of a proposal that no person decided: its deadline passed, or the authority it rests on was
 * lost (O60, O52). It is a separate port method so the person's path can never write it, and it
 * carries no evidence because there is nobody to name (R4-H1).
 */
export interface RecordProposalEndInput {
  readonly expectedStatus: ProposalStatus;
  readonly proposal: Proposal;
  readonly reason: string;
}

/** The open proposals of one tenant, or of one exact access scope inside it (O7). */
export interface ListOpenApprovalsInput {
  readonly scopeId?: AccessScopeId;
}

/**
 * The store's own port. Every operation names the trusted request scope it runs in, so the tenant and
 * the acting person are the request's, never the command body's (O66).
 */
export interface ApprovalStoreService {
  readonly create: (
    scope: OperationalScope,
    proposal: Proposal,
  ) => Effect.Effect<void, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
  /**
   * O75/O90: the proposal and its frozen command in one transaction. The stored proposal is what the
   * caller gets back, so a retried Action invocation answers the receipt it already holds instead of
   * parking a second proposal — and a proposal with any other binding is a conflict, never a replay.
   */
  readonly createWithFrozenCommand: (
    scope: OperationalScope,
    input: {
      readonly actionInvocationId?: ActionInvocationRef | undefined;
      readonly frozen: FrozenCommandRecord;
      readonly proposal: Proposal;
      readonly transaction?: CoreTransaction | undefined;
    },
  ) => Effect.Effect<Proposal, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
  /** O75: execution receipt and owner Action success share the caller's transaction. */
  readonly executeInTransaction: (
    scope: OperationalScope,
    input: { readonly expectedStatus: 'approved'; readonly proposal: Proposal },
    transaction: CoreTransaction,
  ) => Effect.Effect<void, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
  readonly listOpen: (
    scope: OperationalScope,
    input: ListOpenApprovalsInput,
  ) => Effect.Effect<readonly Proposal[], ApprovalStorageUnavailableError>;
  readonly load: (
    scope: OperationalScope,
    input: { readonly proposalId: ProposalId; readonly scopeId?: AccessScopeId },
  ) => Effect.Effect<Option.Option<Proposal>, ApprovalStorageUnavailableError>;
  readonly loadByActionInvocation: (
    scope: OperationalScope,
    input: { readonly actionInvocationId: ActionInvocationRef },
  ) => Effect.Effect<Option.Option<Proposal>, ApprovalStorageUnavailableError>;
  /**
   * The workload's own end of a proposal: an expiry or an authority loss, observed by Core and never
   * decided by a person. Only `lapsed` and `expired` may be written here, and the person's `save`
   * refuses both, so a caller with somebody else's scope cannot end a proposal (R4-H1).
   */
  readonly recordEnd: (
    scope: OperationalScope,
    input: RecordProposalEndInput,
  ) => Effect.Effect<void, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
  /**
   * The approval record port of one request scope. The approvals service carries no scope of its own,
   * so the caller that knows the request's scope asks the store for this view; a record or a decision
   * that names another tenant or another acting person is still refused by the store itself.
   */
  readonly recordsFor: (scope: OperationalScope) => ApprovalProposalRecords;
  readonly save: (
    scope: OperationalScope,
    input: SaveApprovalInput,
  ) => Effect.Effect<void, ApprovalStorageConflictError | ApprovalStorageUnavailableError>;
}

const storageConflict = (reason: string): ApprovalStorageConflictError =>
  new ApprovalStorageConflictError({ code: 'approval_storage_conflict', reason });

const storageUnavailable = (reason: string): ApprovalStorageUnavailableError =>
  new ApprovalStorageUnavailableError({ code: 'approval_storage_unavailable', reason });

const invalidRow = (failure: string): ApprovalStorageUnavailableError =>
  storageUnavailable(`A stored proposal does not satisfy the model: ${failure}`);

/**
 * A frozen-command append the repository refused as a conflict or an integrity break. Both mean the
 * same thing to the caller: this proposal's command was not written, and nothing in this transaction
 * may be retried.
 */
const frozenAppendRefusal = (
  failure:
    | FrozenCommandConflictError
    | FrozenCommandIntegrityError
    | ApprovalStorageConflictError
    | ApprovalStorageUnavailableError,
): ApprovalStorageConflictError | ApprovalStorageUnavailableError =>
  Schema.is(FrozenCommandConflictErrorSchema)(failure) || Schema.is(FrozenCommandIntegrityErrorSchema)(failure)
    ? storageConflict('The frozen owner command could not be appended')
    : failure;

/** The frozen command of a freshly inserted proposal, written in the same transaction (O75). */
const appendFrozenOwnerCommand =
  (input: {
    readonly frozen: FrozenCommandRecord;
    readonly frozenCommands: FrozenCommandStore;
    readonly proposal: Proposal;
    readonly scope: OperationalScope;
  }) =>
  (
    transaction: CoreTransaction,
  ): Effect.Effect<Proposal, ApprovalStorageConflictError | ApprovalStorageUnavailableError> =>
    input.frozenCommands.appendInTransaction(input.scope, input.frozen, transaction).pipe(
      Effect.mapError(frozenAppendRefusal),
      Effect.map(() => input.proposal),
    );

/**
 * The unique indexes of the tables this store writes. A collision on one of them is the same
 * conflict as a lost compare-and-set: two writers planned from the same record and only the first
 * can be stored. Core owns the SQLSTATE taxonomy; this store owns only its own constraint names.
 */
const OWNER_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_mandate_grants_pk',
  'access_mandates_pkey',
  'access_mandates_proposal_uk',
  'access_proposals_execution_uk',
  'access_proposals_pkey',
]);

type StoreRefusal = ApprovalStorageConflictError | ApprovalStorageUnavailableError;
type StoreFailure = StoreRefusal | EffectDrizzleQueryError | SqlError;

/**
 * A write PostgreSQL refused. A uniqueness collision on this store's own indexes is a race the
 * caller repairs by re-reading, exactly like a lost compare-and-set. An integrity refusal — a class-23
 * constraint or an access trigger's `55000`, including the deferred ones PostgreSQL raises at COMMIT —
 * proves that this record can never be stored, so it is a refusal and never retried. Everything else
 * — connectivity, an administrative shutdown, or a state the caller has to observe again — stays
 * retryable unavailability, so a driver failure is never reported as a decision about the data.
 */
const sqlFailure = (failure: SqlError | EffectDrizzleQueryError): StoreRefusal => {
  if (isPostgresUniqueViolation(failure, OWNER_UNIQUE_CONSTRAINTS)) {
    return storageConflict('Another writer already stored the record this transition claims');
  }
  if (isDatabaseIntegrityRefusal(failure)) {
    return storageConflict('PostgreSQL refused this record: it breaks a rule the access tables keep');
  }
  return storageUnavailable(
    isDatabaseUnavailableFailure(failure)
      ? 'The approvals store is unavailable'
      : 'The approvals store could not settle the write',
  );
};

/** Only the driver failures this store understands are named; a bug stays a defect and is never retried. */
const durable = <Value>(effect: Effect.Effect<Value, StoreFailure>): Effect.Effect<Value, StoreRefusal> =>
  effect.pipe(
    Effect.catchTags({
      EffectDrizzleQueryError: (failure) => Effect.fail(sqlFailure(failure)),
      SqlError: (failure) => Effect.fail(sqlFailure(failure)),
    }),
  );

/**
 * A read compares and sets nothing, so unavailability is the only refusal it can honestly report.
 * Mapping the conflict branch keeps the read contract of the port exact instead of widening it.
 */
const readOnly = <Value>(
  effect: Effect.Effect<Value, StoreRefusal>,
): Effect.Effect<Value, ApprovalStorageUnavailableError> =>
  effect.pipe(
    Effect.catchTag('ApprovalStorageConflictError', (failure) => Effect.fail(storageUnavailable(failure.reason))),
  );

/** The identifier a store mints: the approval record and the decision record each need one. */
const nextUuid = (crypto: Crypto.Crypto): Effect.Effect<string, ApprovalStorageUnavailableError> =>
  crypto
    .randomUUIDv4()
    .pipe(
      Effect.catchTag('PlatformError', () =>
        Effect.fail(storageUnavailable('An identifier for this proposal record could not be generated')),
      ),
    );

const decodeHolder = Schema.decodeUnknownResult(HolderSchema);

/** The holder an assignment really belongs to; SQL keeps exactly one of a person and an agent. */
const holderOf = (assignment: {
  readonly agentId: string | null;
  readonly principalId: string | null;
}): Effect.Effect<Holder, ApprovalStorageUnavailableError> =>
  Result.match(
    decodeHolder(
      assignment.principalId === null
        ? { _tag: 'Agent', agentId: assignment.agentId }
        : { _tag: 'Principal', principalId: assignment.principalId },
    ),
    {
      onFailure: () => Effect.fail(invalidRow('a bound witness names no holder this tenant stores')),
      onSuccess: (holder) => Effect.succeed(holder),
    },
  );

const proposalOf = (
  row: ProposalRow,
  bound: BoundApproval | undefined,
): Effect.Effect<Proposal, ApprovalStorageUnavailableError> =>
  Result.match(proposalFrom(row, bound?.mandate, bound?.witnesses), {
    onFailure: (failure) => Effect.fail(invalidRow(failure)),
    onSuccess: (proposal) => Effect.succeed(proposal),
  });

const OPEN_STATUSES = ['pending', 'approved'] as const;

/** One proposal together with the approval record and the witness rows a person's decision bound. */
export interface BoundApproval {
  readonly mandate: MandateRow;
  readonly witnesses: readonly EncodedWitness[];
}

/** One bound witness row, paired with the approval record it belongs to. */
const boundWitnessOf = Effect.fn('approvals.persistence.boundWitnessOf')(function* boundWitnessOfEffect(
  grant: Parameters<typeof witnessOfRow>[0],
  mandateOf: ReadonlyMap<string, MandateRow>,
  holders: ReadonlyMap<string, { readonly agentId: string | null; readonly principalId: string | null }>,
) {
  const mandate = mandateOf.get(grant.mandateId);
  if (mandate === undefined) {
    return yield* invalidRow(`a witness row of mandate ${grant.mandateId} belongs to no approval`);
  }
  const assignment = holders.get(grant.assignmentIncarnationId);
  if (assignment === undefined) {
    return yield* invalidRow(
      `a witness row names assignment ${grant.assignmentIncarnationId}, which this tenant does not hold`,
    );
  }
  return { mandate, witness: witnessOfRow(grant, yield* holderOf(assignment)) };
});

/**
 * The witnesses an approval bound, rebuilt from the witness rows its approval record holds and the
 * assignment each one really belongs to. Those rows are what SQL proved at approval time: the scope
 * of the proposal, the mode the purpose requires and the exact grant cell the witness claims.
 */
const readBoundApprovals = Effect.fn('approvals.persistence.readBoundApprovals')(function* readBoundApprovalsEffect(
  transaction: CoreTransaction,
  tenantId: string,
  proposalIds: readonly string[],
) {
  const byProposal = new Map<string, BoundApproval>();
  if (proposalIds.length === 0) {
    return byProposal;
  }
  const mandates = yield* transaction
    .select(mandateColumns)
    .from(accessMandates)
    .where(and(eq(accessMandates.tenantId, tenantId), inArray(accessMandates.proposalId, [...proposalIds])));
  if (mandates.length === 0) {
    return byProposal;
  }
  const mandateOf = new Map(mandates.map((mandate) => [mandate.mandateId, mandate]));
  for (const mandate of mandates) {
    byProposal.set(mandate.proposalId, { mandate, witnesses: [] });
  }
  const grants = yield* transaction
    .select(mandateGrantColumns)
    .from(accessMandateGrants)
    .where(
      and(
        eq(accessMandateGrants.tenantId, tenantId),
        inArray(
          accessMandateGrants.mandateId,
          mandates.map(({ mandateId }) => mandateId),
        ),
      ),
    );
  const assignmentIds = [...new Set(grants.map(({ assignmentIncarnationId }) => assignmentIncarnationId))];
  const assignments =
    assignmentIds.length === 0
      ? []
      : yield* transaction
          .select({
            agentId: accessAssignments.agentId,
            incarnationId: accessAssignments.incarnationId,
            principalId: accessAssignments.principalId,
          })
          .from(accessAssignments)
          .where(
            and(eq(accessAssignments.tenantId, tenantId), inArray(accessAssignments.incarnationId, assignmentIds)),
          );
  const holders = new Map(assignments.map((assignment) => [assignment.incarnationId, assignment]));
  const bound = yield* Effect.forEach(grants, (grant) => boundWitnessOf(grant, mandateOf, holders), {
    concurrency: 1,
  });
  for (const { mandate, witness } of bound) {
    const current = byProposal.get(mandate.proposalId);
    byProposal.set(mandate.proposalId, { mandate, witnesses: [...(current?.witnesses ?? []), witness] });
  }
  return byProposal;
});

const readProposal = Effect.fn('approvals.persistence.readProposal')(function* readProposalEffect(
  transaction: CoreTransaction,
  tenantId: string,
  input: { readonly proposalId: ProposalId; readonly scopeId?: AccessScopeId },
) {
  const rows = yield* transaction
    .select(proposalColumns)
    .from(accessProposals)
    .where(
      and(
        eq(accessProposals.tenantId, tenantId),
        eq(accessProposals.proposalId, input.proposalId),
        input.scopeId === undefined ? undefined : eq(accessProposals.scopeId, input.scopeId),
      ),
    );
  const [row] = rows;
  if (row === undefined) {
    return Option.none<Proposal>();
  }
  const bound = yield* readBoundApprovals(transaction, tenantId, [input.proposalId]);
  return Option.some(yield* proposalOf(row, bound.get(input.proposalId)));
});

const readOpenProposals = Effect.fn('approvals.persistence.readOpenProposals')(function* readOpenProposalsEffect(
  transaction: CoreTransaction,
  tenantId: string,
  input: ListOpenApprovalsInput,
) {
  const scope =
    input.scopeId === undefined
      ? eq(accessProposals.tenantId, tenantId)
      : and(eq(accessProposals.tenantId, tenantId), eq(accessProposals.scopeId, input.scopeId));
  const rows = yield* transaction
    .select(proposalColumns)
    .from(accessProposals)
    .where(and(scope, inArray(accessProposals.status, OPEN_STATUSES)))
    .orderBy(accessProposals.createdAt, accessProposals.proposalId);
  const bound = yield* readBoundApprovals(
    transaction,
    tenantId,
    rows.map(({ proposalId }) => proposalId),
  );
  return yield* Effect.forEach(rows, (row) => proposalOf(row, bound.get(row.proposalId)), { concurrency: 1 });
});

/**
 * A command the scope cannot own: another tenant's record, or a decision taken by somebody other than
 * the person this request runs as. The store refuses it before a statement is prepared (O66).
 */
const foreignTenant = (scope: OperationalScope, tenantId: string): Option.Option<string> =>
  tenantId === scope.tenantId ? Option.none() : Option.some(`tenant ${tenantId} is not the scope's tenant`);

/**
 * The statuses only Core's own clock or its own authority bookkeeping produces (O60, O52, O57): a
 * deadline passed, or the authority the proposal rests on was lost. A person's write never ends a
 * proposal this way, so `save` refuses both and `recordEnd` refuses everything else.
 */
const WORKLOAD_END_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(['expired', 'lapsed']);

/**
 * The acting person a person's transition must be, decided by the status it produces (O66, O63, O61,
 * O57). The stored row already says who approved, rejected or requested; comparing it with the
 * request's own person is what stops a bystander from writing somebody else's decision. A status the
 * store cannot attribute to this person is refused instead of being written unbound (R4-H1).
 */
/** The acting person as the request's own scope states it: a plain identifier, compared by value. */
type PersonBinding = (input: SaveApprovalInput, acting: string) => string | null;

const PERSON_BINDINGS = {
  approved: ({ proposal }, acting) => {
    const approverId = proposal.approval?.approverId;
    if (approverId === undefined) {
      return 'A proposal becomes the mandate only together with the approval that names its approver';
    }
    return approverId === acting
      ? null
      : `An approval is stored only by the approving person ${approverId}, never by ${acting}`;
  },
  // The executor is proved against the stored approval record inside the transaction.
  executed: () => null,
  expired: (_input, acting) =>
    `An expiry is the clock's own end, never a write by ${acting}: it belongs to the workload`,
  lapsed: ({ evidence, proposal }, acting) => {
    // A withdrawal carries the person who took it; the requester's own withdrawal carries nobody but
    // is still the requester's own act (O57).
    if (evidence !== undefined) {
      return null;
    }
    const requester = proposal.requester.principalId;
    return requester === acting ? null : `A mandate is lapsed by its requester ${requester}, never by ${acting}`;
  },
  pending: (_input, acting) => `A proposal is created pending; ${acting} writes no transition back to it`,
  rejected: ({ proposal }, acting) => {
    const { rejectedBy } = proposal;
    if (rejectedBy === undefined) {
      return 'A rejection names the person who took it';
    }
    return rejectedBy === acting
      ? null
      : `A rejection is stored only by the person who took it, ${rejectedBy}, never by ${acting}`;
  },
} as const satisfies Record<ProposalStatus, PersonBinding>;

const personBindingIssue = (scope: OperationalScope, input: SaveApprovalInput): string | null =>
  PERSON_BINDINGS[input.proposal.status](input, scope.principalId);

/** One transition as one request: the transaction it runs in, what it writes, and whose write it is. */
interface TransitionRequest {
  /** The acting person of a person's own transition; absent for the workload's own ends. */
  readonly actingPerson?: OperationalScope;
  readonly input: SaveApprovalInput;
  readonly transaction: CoreTransaction;
}

/** One store operation inside a transaction of the request's scope, and the failures it may name. */
type ScopedBody<Value> = (transaction: CoreTransaction) => Effect.Effect<Value, StoreFailure>;

/**
 * WHERE one store operation gets its transaction (O66, O75): a transaction it opens for itself, or the
 * one a caller already opened and still owns. The two are separate capabilities, so no operation can
 * believe it is inside a transaction it never joined.
 */
type ScopedRunner = <Value>(scope: OperationalScope, body: ScopedBody<Value>) => Effect.Effect<Value, StoreRefusal>;

/** Installs and verifies the request's scope on the transaction an operation reads or writes in (O66). */
const scopeInstalledIn = <Value>(
  transaction: CoreTransaction,
  scope: OperationalScope,
  enrollment: DatabaseIdentityEnrollment,
  body: ScopedBody<Value>,
): Effect.Effect<Value, StoreFailure> =>
  installOperationalScope(transaction, scope, enrollment).pipe(
    Effect.catchTag('OperationContextUnavailable', () =>
      Effect.fail(storageUnavailable('The tenant scope of this approvals write could not be installed')),
    ),
    Effect.andThen(() => body(transaction)),
  );

/** The store's ordinary source: one transaction per operation on the pool, which owns the boundary. */
const requestScoped =
  (executor: CoreDatabaseExecutor, enrollment: DatabaseIdentityEnrollment): ScopedRunner =>
  <Value>(scope: OperationalScope, body: ScopedBody<Value>) =>
    durable(executor.transaction((transaction) => scopeInstalledIn(transaction, scope, enrollment, body)));

/**
 * The transaction a caller opened and still owns (O75). It opens nothing, applies no option and starts
 * no savepoint, and it never commits or rolls back: every operation of the joined store is part of the
 * caller's transaction, whose snapshot is the one the store reads. The caller's COMMIT or ROLLBACK is
 * the only boundary, so a receipt this store writes and the owner write it belongs to stand or fall
 * together.
 */
const callerScoped =
  (transaction: CoreTransaction, enrollment: DatabaseIdentityEnrollment): ScopedRunner =>
  <Value>(scope: OperationalScope, body: ScopedBody<Value>) =>
    durable(scopeInstalledIn(transaction, scope, enrollment, body));

const buildApprovalStore = ({
  crypto,
  enrollment,
  frozenCommands,
  runInScope,
}: {
  readonly crypto: Crypto.Crypto;
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly frozenCommands: FrozenCommandStore | undefined;
  readonly runInScope: ScopedRunner;
}): ApprovalStoreService => {
  /** The append-only approval record and one witness row per bound witness, written once. */
  const appendApprovalRecord = Effect.fn('approvals.persistence.appendApprovalRecord')(
    function* appendApprovalRecordEffect(transaction: CoreTransaction, proposal: Proposal) {
      const { approval } = proposal;
      if (approval === undefined) {
        // A mandate record without an approval is a service bug, and it must never be written silently.
        return yield* storageConflict('A proposal becomes the mandate only together with its approval');
      }
      const mandateId = yield* nextUuid(crypto);
      yield* transaction
        .insert(accessMandates)
        .values(mandateInsertValues(proposal, approval, mandateId))
        .pipe(Effect.asVoid);
      const grants = mandateGrantValues(proposal, mandateId);
      if (grants.length > 0) {
        yield* transaction.insert(accessMandateGrants).values(grants).pipe(Effect.asVoid);
      }
      return yield* Effect.void;
    },
  );

  /** The "Proč?" record of a rejection, a lapse or an expiry (O61), appended with the transition. */
  const appendDecisionRecord = Effect.fn('approvals.persistence.appendDecisionRecord')(
    function* appendDecisionRecordEffect(transaction: CoreTransaction, input: SaveApprovalInput) {
      const decidedAt = input.proposal.endedAt ?? input.proposal.approval?.approvedAt ?? input.proposal.createdAt;
      yield* transaction
        .insert(accessDecisionLogs)
        .values(
          decisionRecordInsert({
            decidedAt,
            decisionLogId: yield* nextUuid(crypto),
            evidence: input.evidence,
            proposal: input.proposal,
            reason: input.reason,
          }),
        )
        .pipe(Effect.asVoid);
    },
  );

  /**
   * The approving person a mandate's execution must run as (O63, R4-H1). The approval record is read
   * in the same transaction, so the executor is compared with the approver SQL stored, never with a
   * value the command body claims.
   */
  const requireExecutor = Effect.fn('approvals.persistence.requireExecutor')(function* requireExecutorEffect(
    transaction: CoreTransaction,
    scope: OperationalScope,
    proposal: Proposal,
  ) {
    const mandate = yield* transaction
      .select({ approverId: accessMandates.approverId })
      .from(accessMandates)
      .where(and(eq(accessMandates.tenantId, proposal.tenantId), eq(accessMandates.proposalId, proposal.id)));
    const [stored] = mandate;
    if (stored === undefined) {
      return yield* storageConflict(`Proposal ${proposal.id} carries no approval record to execute`);
    }
    return stored.approverId === scope.principalId
      ? yield* Effect.void
      : yield* storageConflict(
          `A mandate is executed only by its approving person ${stored.approverId}, never by ${scope.principalId}`,
        );
  });

  /**
   * One transition. The model's own transition table refuses an illegal move before SQL sees it, and
   * the status comparison is the compare-and-set that decides which writer wins. Only the winner
   * appends the approval or the decision evidence of that same transition. A person's transition also
   * proves the acting person of the status it writes (`actingPerson`); the workload's own ends name
   * nobody, so they are the only callers that leave it out.
   */
  const transitionProposal = Effect.fn('approvals.persistence.transitionProposal')(function* transitionProposalEffect(
    request: TransitionRequest,
  ) {
    const { actingPerson, input, transaction } = request;
    const { proposal } = input;
    if (!canTransitionProposalStatus(input.expectedStatus, proposal.status)) {
      return yield* storageConflict(`A proposal never moves from ${input.expectedStatus} to ${proposal.status}`);
    }
    if (actingPerson !== undefined) {
      const issue = personBindingIssue(actingPerson, input);
      if (issue !== null) {
        return yield* storageConflict(issue);
      }
      if (proposal.status === 'executed') {
        yield* requireExecutor(transaction, actingPerson, proposal);
      }
    }
    const transitioned = yield* transaction
      .update(accessProposals)
      .set(proposalTransitionValues(proposal))
      .where(
        and(
          eq(accessProposals.tenantId, proposal.tenantId),
          eq(accessProposals.scopeId, proposal.scopeId),
          eq(accessProposals.proposalId, proposal.id),
          eq(accessProposals.status, input.expectedStatus),
        ),
      )
      .returning({ proposalId: accessProposals.proposalId });
    if (transitioned.length === 0) {
      return yield* storageConflict(`Proposal ${proposal.id} is not ${input.expectedStatus} in this scope any more`);
    }
    if (input.expectedStatus === 'pending' && proposal.status === 'approved') {
      yield* appendApprovalRecord(transaction, proposal);
    }
    if (input.evidence !== undefined || input.reason !== undefined) {
      yield* appendDecisionRecord(transaction, input);
    }
    return yield* Effect.void;
  });

  const create: ApprovalStoreService['create'] = Effect.fn('approvals.persistence.create')(
    function* createProposalEffect(scope: OperationalScope, proposal: Proposal) {
      const tenantIssue = foreignTenant(scope, proposal.tenantId);
      if (Option.isSome(tenantIssue)) {
        return yield* storageConflict(`A proposal is created only in the scope's own tenant: ${tenantIssue.value}`);
      }
      if (proposal.status !== 'pending') {
        // A proposal is created pending and only a person's approval makes it a mandate; a record
        // that arrives already approved would be a half-written approval and SQL would refuse it.
        return yield* storageConflict(`A proposal is created pending, not ${proposal.status}`);
      }
      const requester = proposal.requester.principalId;
      if (requester !== scope.principalId) {
        return yield* storageConflict(
          `A proposal is created only by the acting person ${scope.principalId}, not by ${requester}`,
        );
      }
      return yield* runInScope(scope, (transaction) =>
        transaction.insert(accessProposals).values(proposalInsertValues(proposal)).pipe(Effect.asVoid),
      );
    },
  );

  /**
   * The proposal an O90.4 retry answers with, proved to be the same request: one row of this tenant,
   * bound to the same Action invocation, in the same scope, with the same capability, target and
   * frozen digest, requested by the same person. Anything else is a conflict, so no caller is ever
   * handed a proposal it did not ask for.
   */
  const storedProposalFor = Effect.fn('approvals.persistence.storedProposalFor')(function* storedProposalForEffect(
    transaction: CoreTransaction,
    tenantId: string,
    expected: {
      readonly actionInvocationId: string | null;
      readonly actionKey: string;
      readonly capabilityKey: string;
      readonly commandDigest: string;
      readonly proposalId: ProposalId;
      readonly requesterPrincipalId: string;
      readonly scopeId: AccessScopeId;
      readonly target: string | null;
    },
  ) {
    const rows = yield* transaction
      .select({
        ...proposalColumns,
        actionInvocationId: accessProposals.actionInvocationId,
        frozenActionKey: accessFrozenCommands.actionKey,
        frozenCapabilityKey: accessFrozenCommands.capabilityKey,
        frozenCommandDigest: accessFrozenCommands.commandDigest,
        frozenScopeId: accessFrozenCommands.scopeId,
        requesterPrincipalId: accessProposals.requesterPrincipalId,
      })
      .from(accessProposals)
      .leftJoin(
        accessFrozenCommands,
        and(
          eq(accessFrozenCommands.tenantId, accessProposals.tenantId),
          eq(accessFrozenCommands.proposalId, accessProposals.proposalId),
        ),
      )
      .where(and(eq(accessProposals.tenantId, tenantId), eq(accessProposals.proposalId, expected.proposalId)))
      .limit(2);
    const [row] = rows;
    if (row === undefined || rows.length !== 1) {
      return yield* storageConflict(`Proposal ${expected.proposalId} is not stored exactly once in this tenant`);
    }
    if (row.frozenActionKey === null) {
      return yield* storageUnavailable('The stored proposal has no frozen command');
    }
    if (
      row.actionInvocationId !== expected.actionInvocationId ||
      row.frozenActionKey !== expected.actionKey ||
      row.frozenCapabilityKey !== expected.capabilityKey ||
      row.frozenCommandDigest !== expected.commandDigest ||
      row.frozenScopeId !== expected.scopeId ||
      row.scopeId !== expected.scopeId ||
      row.capabilityKey !== expected.capabilityKey ||
      row.commandDigest !== expected.commandDigest ||
      (row.target ?? null) !== expected.target ||
      row.requesterPrincipalId !== expected.requesterPrincipalId
    ) {
      return yield* storageConflict('This Action invocation is already bound to a different proposal');
    }
    const bound = yield* readBoundApprovals(transaction, tenantId, [expected.proposalId]);
    return yield* proposalOf(row, bound.get(expected.proposalId));
  });

  /** The proposal and the immutable approved payload never commit separately (O75). */
  const createWithFrozenCommand: ApprovalStoreService['createWithFrozenCommand'] = Effect.fn(
    'approvals.persistence.createWithFrozenCommand',
  )(function* createWithFrozenCommandEffect(
    scope,
    { actionInvocationId, frozen, proposal, transaction: ownerTransaction },
  ) {
    if (frozenCommands === undefined) {
      return yield* storageUnavailable('The frozen-command store is unavailable');
    }
    if (
      proposal.status !== 'pending' ||
      proposal.tenantId !== scope.tenantId ||
      proposal.requester.principalId !== scope.principalId ||
      frozen.tenantId !== proposal.tenantId ||
      frozen.scopeId !== proposal.scopeId ||
      frozen.proposalId !== proposal.id ||
      frozen.commandDigest !== proposal.commandDigest ||
      frozen.command.capabilityKey !== proposal.capabilityKey ||
      frozen.command.target !== proposal.target
    ) {
      return yield* storageConflict('The frozen owner command does not belong to this pending proposal and caller');
    }
    const checked = verifyFrozenCommand(frozen);
    if (Result.isFailure(checked)) {
      return yield* storageConflict('The frozen owner command digest does not match its proposal');
    }
    const expected = {
      actionInvocationId: actionInvocationId ?? null,
      actionKey: frozen.actionKey,
      capabilityKey: proposal.capabilityKey,
      commandDigest: proposal.commandDigest,
      proposalId: proposal.id,
      requesterPrincipalId: proposal.requester.principalId,
      scopeId: proposal.scopeId,
      target: proposal.target ?? null,
    };
    /*
     * A duplicate is a skipped row, never a raised uniqueness error. PostgreSQL aborts the whole
     * transaction on 23505 (SQLSTATE 25P02 answers every later statement), and the owner runner has
     * to answer the receipt it already stored in that same transaction (O90.4).
     */
    const appendFrozen = appendFrozenOwnerCommand({ frozen, frozenCommands, proposal, scope });
    const persist = (transaction: CoreTransaction) =>
      transaction
        .insert(accessProposals)
        .values({ ...proposalInsertValues(proposal), actionInvocationId: actionInvocationId ?? null })
        .onConflictDoNothing()
        .returning({ proposalId: accessProposals.proposalId })
        .pipe(
          Effect.flatMap((inserted) =>
            inserted.length === 0
              ? storedProposalFor(transaction, scope.tenantId, expected)
              : appendFrozen(transaction),
          ),
        );
    return yield* ownerTransaction === undefined
      ? runInScope(scope, persist)
      : durable(
          installOperationalScope(ownerTransaction, scope, enrollment).pipe(
            Effect.catchTag('OperationContextUnavailable', () =>
              Effect.fail(storageUnavailable('The owner Action scope could not be installed for its proposal')),
            ),
            Effect.andThen(() => persist(ownerTransaction)),
          ),
        );
  });

  const load: ApprovalStoreService['load'] = Effect.fn('approvals.persistence.load')(function* loadProposalEffect(
    scope: OperationalScope,
    input: { readonly proposalId: ProposalId; readonly scopeId?: AccessScopeId },
  ) {
    return yield* readOnly(runInScope(scope, (transaction) => readProposal(transaction, scope.tenantId, input)));
  });

  const loadByActionInvocation: ApprovalStoreService['loadByActionInvocation'] = Effect.fn(
    'approvals.persistence.loadByActionInvocation',
  )(function* loadByActionInvocationEffect(scope, { actionInvocationId }) {
    return yield* readOnly(
      runInScope(scope, (transaction) =>
        transaction
          .select({ proposalId: accessProposals.proposalId })
          .from(accessProposals)
          .where(
            and(
              eq(accessProposals.tenantId, scope.tenantId),
              eq(accessProposals.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(2)
          .pipe(
            Effect.flatMap((rows) => {
              if (rows.length > 1) {
                return Effect.fail(storageUnavailable('More than one proposal belongs to the Action invocation'));
              }
              return rows[0] === undefined
                ? Effect.succeed(Option.none<Proposal>())
                : readProposal(transaction, scope.tenantId, { proposalId: ProposalIdSchema.make(rows[0].proposalId) });
            }),
          ),
      ),
    );
  });

  /** Every open proposal of the scope's tenant, or of one exact access scope inside it. */
  const listOpen: ApprovalStoreService['listOpen'] = Effect.fn('approvals.persistence.listOpen')(
    function* listOpenProposalsEffect(scope: OperationalScope, input: ListOpenApprovalsInput) {
      return yield* readOnly(runInScope(scope, (transaction) => readOpenProposals(transaction, scope.tenantId, input)));
    },
  );

  const save: ApprovalStoreService['save'] = Effect.fn('approvals.persistence.save')(function* saveProposalEffect(
    scope: OperationalScope,
    input: SaveApprovalInput,
  ) {
    const tenantIssue = foreignTenant(scope, input.proposal.tenantId);
    if (Option.isSome(tenantIssue)) {
      return yield* storageConflict(`A proposal is stored only in the scope's own tenant: ${tenantIssue.value}`);
    }
    const decider = input.evidence?.decidedBy;
    if (decider !== undefined && decider !== scope.principalId) {
      return yield* storageConflict(
        `A decision is recorded only by the acting person ${scope.principalId}, not by ${decider}`,
      );
    }
    return yield* runInScope(scope, (transaction) => transitionProposal({ actingPerson: scope, input, transaction }));
  });

  /**
   * The workload's end of a proposal: the deadline passed, or the authority behind it was lost (O60).
   * It names no acting person because there is none, and it is the only path to `expired` and to a
   * `lapsed` proposal nobody withdrew (R4-H1).
   */
  const recordEnd: ApprovalStoreService['recordEnd'] = Effect.fn('approvals.persistence.recordEnd')(
    function* recordEndEffect(scope: OperationalScope, input: RecordProposalEndInput) {
      const tenantIssue = foreignTenant(scope, input.proposal.tenantId);
      if (Option.isSome(tenantIssue)) {
        return yield* storageConflict(`A proposal is ended only in the scope's own tenant: ${tenantIssue.value}`);
      }
      if (!WORKLOAD_END_STATUSES.has(input.proposal.status)) {
        return yield* storageConflict(
          `A workload ends a proposal by its deadline or its lost authority, never as ${input.proposal.status}`,
        );
      }
      return yield* runInScope(scope, (transaction) => transitionProposal({ input, transaction }));
    },
  );

  const executeInTransaction: ApprovalStoreService['executeInTransaction'] = Effect.fn(
    'approvals.persistence.executeInTransaction',
  )(function* executeInTransactionEffect(scope, input, transaction) {
    const tenantIssue = foreignTenant(scope, input.proposal.tenantId);
    if (Option.isSome(tenantIssue)) {
      return yield* storageConflict(`A mandate executes only in its tenant: ${tenantIssue.value}`);
    }
    if (input.proposal.status !== 'executed' || input.proposal.execution === undefined) {
      return yield* storageConflict('Execution requires a completed proposal with an Action invocation receipt');
    }
    return yield* durable(
      installOperationalScope(transaction, scope, enrollment).pipe(
        Effect.catchTag('OperationContextUnavailable', () =>
          Effect.fail(storageUnavailable('The tenant scope of this execution could not be installed')),
        ),
        Effect.andThen(() => transitionProposal({ actingPerson: scope, input, transaction })),
      ),
    );
  });

  const recordsFor = (scope: OperationalScope): ApprovalProposalRecords => ({
    create: (proposal) => create(scope, proposal),
    createWithFrozenCommand: (input) => createWithFrozenCommand(scope, input),
    executeInTransaction: (input, transaction) => executeInTransaction(scope, input, transaction),
    listOpen: (input) =>
      input.tenantId === scope.tenantId
        ? listOpen(scope, input.scopeId === undefined ? {} : { scopeId: input.scopeId })
        : Effect.fail(storageUnavailable('The open proposals of another tenant are never listed')),
    load: (input) =>
      input.tenantId === scope.tenantId
        ? load(scope, { proposalId: input.proposalId, scopeId: input.scopeId })
        : Effect.fail(storageUnavailable('A proposal of another tenant is never read')),
    recordEnd: (input) => recordEnd(scope, input),
    save: (input) => save(scope, input),
  });

  return Object.freeze({
    create,
    createWithFrozenCommand,
    executeInTransaction,
    listOpen,
    load,
    loadByActionInvocation,
    recordEnd,
    recordsFor,
    save,
  });
};

/**
 * The approvals store over the pool: every operation opens a transaction of the request's scope (O66).
 */
export const makeDrizzleApprovalStore = (
  database: ApprovalStoreDatabase,
  crypto: Crypto.Crypto,
): ApprovalStoreService =>
  buildApprovalStore({
    crypto,
    enrollment: database.enrollment,
    frozenCommands: database.frozenCommands,
    runInScope: requestScoped(database.executor, database.enrollment),
  });

/**
 * The same store over the transaction an owner Action already opened and still owns (O75): its reads
 * and its receipt are part of that transaction, so a claim decides from what its own receipt commits
 * with, and a rolled-back owner write leaves no proposal, no frozen command and no receipt behind.
 */
export const makeJoinedDrizzleApprovalStore = (
  database: JoinedApprovalStoreDatabase,
  crypto: Crypto.Crypto,
): ApprovalStoreService =>
  buildApprovalStore({
    crypto,
    enrollment: database.enrollment,
    frozenCommands: database.frozenCommands,
    runInScope: callerScoped(database.transaction, database.enrollment),
  });

/**
 * The approvals store as Core provides it over the pool: one instance for the process, scoped by the
 * caller's `OperationalScope` on every call (O66). A store joined to an owner's transaction is built
 * by `makeJoinedDrizzleApprovalStore` instead (O75).
 */
export class ApprovalStore extends Context.Service<ApprovalStore, ApprovalStoreService>()(
  '@app/core-runtime/access/approvals/drizzle-store/ApprovalStore',
) {}

export const ApprovalStoreLive: Layer.Layer<
  ApprovalStore,
  never,
  CoreDatabase | Crypto.Crypto | DatabaseIdentityEnrollmentContext | FrozenCommands
> = Layer.effect(
  ApprovalStore,
  Effect.gen(function* makeApprovalStoreLive() {
    const { executor } = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const frozenCommands = yield* FrozenCommands;
    return makeDrizzleApprovalStore({ enrollment, executor, frozenCommands }, yield* Crypto.Crypto);
  }),
);
