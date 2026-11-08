import { Context, DateTime, Effect, Option, Predicate, Result, Schema } from 'effect';

import type { AnyActionRegistration } from '../../actions/definition.ts';
import { ActionPermissionDenied, ActionPermissionCheckError } from '../../actions/errors.ts';
import { computeCanonicalValueHash, recoverSqlTransactionError } from '../../actions/repository.ts';
import { insideDatabaseTransaction } from '../../db/transaction-io-guard.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import { lockApplicationCompositionAuthority } from '../../modules/application-composition-authority.ts';
import { bindAccessGate } from '../../operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../operations/access-gate.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { trustedTransactionTime } from '../../operations/transaction-time.ts';
import { CapabilityKeySchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import type { PrincipalId } from '../ids.ts';
import type { Proposal } from '../model.ts';
import { AccessDecisionGate } from '../enforcement/contract.ts';
import { makeAccessAuthorityCurrentness } from '../enforcement/currentness.ts';
import { lockActionAccessFence } from './action-access-fence.ts';
import { decodeActionCommandV2 } from './action-command-v2.ts';
import type { ActionCommandV2 } from './action-command-v2.ts';
import { proposeActionV2, approveActionV2, executeActionV2 } from './action-proposal-v2.ts';
import type { ApprovalsError } from './errors.ts';
import {
  ApprovalAuthorityUnavailableError,
  ApprovalRefusedError,
  ApprovalStorageConflictError,
  ApprovalStorageUnavailableError,
  MandateRefusedError,
} from './errors.ts';
import type { FrozenCommandStore } from './frozen-command.ts';
import { verifyFrozenCommand } from './frozen-command.ts';
import type { LiveApprovalServices } from './live-composition.ts';
import { prepareActionAuthorityV2, prepareBoundActionAuthorityV2 } from './prepared-action-authority-v2.ts';
import { PreparedActionStepV2 } from './prepared-action-step-v2.ts';
import { actorPrincipal } from './proposal.ts';
import { isProposalTerminal } from './lapse.ts';
import { proposalIdForInvocation } from './proposal-invocation-id.ts';
import { verifyHumanPrincipal } from './principals.ts';
import type { VerifiedHumanPrincipal } from './principals.ts';
import { requirePublishedActionCommandV2, resolveRegisteredActionSourceV2 } from './registered-action-source-v2.ts';
import type { RegisteredActionOwnerV2, ResolvedRegisteredActionSourceV2 } from './registered-action-source-v2.ts';
import type { ApproveCommand, ExecuteCommand, ProposeCommand } from './service.ts';
import { makeOwnerActionApprovalNativeServices } from './owner-native-services.ts';
import type { OwnerActionApprovalConfiguration } from './owner-native-services.ts';

/** Trusted continuation tokens, never transport metadata or admission booleans. */
export const preparedActionProposalV2: unique symbol = Symbol('prepared-action-proposal-v2');
export const preparedActionExecutionV2: unique symbol = Symbol('prepared-action-execution-v2');

type FreshAuthority = Effect.Success<ReturnType<typeof prepareActionAuthorityV2>>;
type BoundAuthority = Effect.Success<ReturnType<typeof prepareBoundActionAuthorityV2>>;

interface PreparedProposalState {
  readonly actionInvocationId: string;
  readonly authority: FreshAuthority;
  readonly command: ActionCommandV2;
  readonly requester: VerifiedHumanPrincipal;
  readonly scope: OperationalScope;
  readonly scopeHash: string;
  readonly source: ResolvedRegisteredActionSourceV2;
}
interface PreparedExecutionState {
  readonly approver: BoundAuthority;
  readonly command: ActionCommandV2;
  readonly proposal: Proposal;
  readonly requester: BoundAuthority;
  readonly scope: OperationalScope;
  readonly scopeHash: string;
  readonly source: ResolvedRegisteredActionSourceV2;
}

export type PreparedActionProposalV2 = PreparedActionStepV2<PreparedProposalState>;
export type PreparedActionExecutionV2 = PreparedActionStepV2<PreparedExecutionState>;

export interface ActionApprovalLifecycleV2 {
  readonly approve: (input: {
    readonly command: ApproveCommand;
    readonly proposal: Proposal;
    readonly scope: OperationalScope;
  }) => Effect.Effect<Proposal, ApprovalsError>;
  readonly execute: (input: {
    readonly command: ExecuteCommand;
    readonly preparation: PreparedActionExecutionV2;
    readonly scope: OperationalScope;
    readonly transaction: CoreTransaction;
  }) => Effect.Effect<Proposal, ApprovalsError>;
  /** The same complete preparation and current native fence, without saving an approval. */
  readonly inspectApproval: (
    input: Parameters<ActionApprovalLifecycleV2['approve']>[0],
  ) => Effect.Effect<boolean, ApprovalsError>;
  readonly prepareExecution: (input: {
    readonly proposalId: ExecuteCommand['proposalId'];
    readonly registration: AnyActionRegistration;
    readonly scope: OperationalScope;
    readonly scopeId: ExecuteCommand['scopeId'];
  }) => Effect.Effect<PreparedActionExecutionV2, ApprovalsError>;
  readonly prepareProposal: (input: {
    readonly actionInvocationId: string;
    readonly command: ActionCommandV2;
    readonly registration: AnyActionRegistration;
    readonly scope: OperationalScope;
  }) => Effect.Effect<PreparedActionProposalV2, ApprovalsError>;
  readonly propose: (input: {
    readonly command: ProposeCommand;
    readonly preparation: PreparedActionProposalV2;
    readonly scope: OperationalScope;
    readonly transaction: CoreTransaction;
  }) => Effect.Effect<Proposal, ApprovalsError>;
  readonly recheckAuthority: (input: {
    readonly proposal: Proposal;
    readonly scope: OperationalScope;
  }) => Effect.Effect<'live' | 'lost', ApprovalsError>;
}

/**
 * These are the same production ports used by ordinary approvals and the Action gate. In
 * particular live.join must build transaction-joined SQL services. No synthetic currentness,
 * owner descriptor, pool lease or authority snapshot is accepted in a preparation token.
 */
export interface ActionApprovalLifecycleV2Dependencies {
  readonly database: { readonly enrollment: DatabaseIdentityEnrollment; readonly executor: CoreDatabaseExecutor };
  readonly enforcement: AccessEnforcementPorts;
  readonly frozenCommands: FrozenCommandStore;
  readonly live: LiveApprovalServices;
  readonly owners: readonly RegisteredActionOwnerV2[];
}
export class ActionApprovalLifecycleV2Ports extends Context.Service<
  ActionApprovalLifecycleV2Ports,
  ActionApprovalLifecycleV2Dependencies
>()('@app/core-runtime/access/approvals/action-lifecycle-v2/ActionApprovalLifecycleV2Ports') {}

const unavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(
    new ApprovalAuthorityUnavailableError({ code: 'approval_authority_unavailable', reason }),
    'cause',
    { value: cause },
  );
const refused = (reason: string) => new MandateRefusedError({ code: 'execution_not_permitted', reason });
const authorityFailure = (failure: ActionPermissionCheckError | ActionPermissionDenied) =>
  Schema.is(ActionPermissionDenied)(failure)
    ? new ApprovalRefusedError({ code: 'approval_authority_missing', reason: failure.reason })
    : unavailable(failure.reason, failure);
const requesterKindFailure = (
  failure: ApprovalAuthorityUnavailableError | ApprovalRefusedError | MandateRefusedError,
) =>
  Schema.is(ApprovalAuthorityUnavailableError)(failure)
    ? new ActionPermissionCheckError({ code: 'action_permission_check_failed', reason: failure.reason })
    : new ActionPermissionDenied({ code: 'action_permission_denied', reason: failure.reason });
const sameProposal = (left: Proposal, right: Proposal) =>
  computeCanonicalValueHash(left) === computeCanonicalValueHash(right);
const scopeTimeUnavailable = (cause: unknown) => unavailable('The native transaction time is unavailable', cause);
const forwardProofFailure = (failure: ActionPermissionCheckError) => Effect.fail(authorityFailure(failure));
const published = (command: ActionCommandV2, services: LiveApprovalServices) =>
  services.loadRelease().pipe(
    Effect.mapError((cause) => unavailable('The published access release is unavailable', cause)),
    Effect.flatMap((release) => requirePublishedActionCommandV2({ command, release })),
  );
export const actionProposalBindingV2 = (preparation: PreparedActionProposalV2) => {
  const prepared = PreparedActionStepV2.read(preparation);
  return prepared === undefined
    ? Effect.fail(unavailable('The original proposal preparation is unavailable'))
    : Effect.succeed({
        command: prepared.command,
        commandDigest: prepared.authority.proof.commandDigest,
        scopeId: prepared.authority.proof.scopeId,
      });
};
export const actionExecutionDeadlineV2 = (
  preparation: PreparedActionExecutionV2,
): Effect.Effect<Date, ApprovalAuthorityUnavailableError> => {
  const prepared = PreparedActionStepV2.read(preparation);
  if (prepared === undefined || prepared.proposal.approval === undefined) {
    return Effect.fail(unavailable('The original mandate preparation is unavailable'));
  }
  const instants = [
    prepared.proposal.expiresAt.getTime(),
    prepared.proposal.approval.expiresAt.getTime(),
    prepared.requester.proof.admissionDeadline,
    prepared.approver.proof.admissionDeadline,
  ].filter((instant) => instant !== undefined);
  return Effect.succeed(DateTime.toDateUtc(DateTime.makeUnsafe(Math.min(...instants))));
};

interface ConstructedActionApprovalLifecycleV2 {
  readonly lifecycle: ActionApprovalLifecycleV2;
  readonly ports: ActionApprovalLifecycleV2Dependencies;
}
type OwnerActionApprovalRequirements =
  | Effect.Services<ReturnType<typeof makeOwnerActionApprovalNativeServices>>
  | AccessDecisionGate;

const constructActionApprovalLifecycleV2Effect = Effect.fn('ActionApproval.constructLifecycleV2')(
  function* buildActionApprovalLifecycleV2(
    configuration?: OwnerActionApprovalConfiguration,
  ): Effect.fn.Return<
    ConstructedActionApprovalLifecycleV2,
    never,
    ActionApprovalLifecycleV2Ports | OwnerActionApprovalRequirements
  > {
    const ports =
      configuration === undefined
        ? yield* ActionApprovalLifecycleV2Ports
        : yield* makeOwnerActionApprovalNativeServices(configuration);
    const seam = yield* AccessDecisionGate;
    // The live lifecycle always reads actual persisted fence revisions through its native executor.
    // An externally supplied currentness function or a scripted bound gate is not a lease.
    const enforcement = {
      ...ports.enforcement,
      currentness: makeAccessAuthorityCurrentness(ports.database),
    };
    const gate = bindAccessGate(seam, enforcement);

    const joined = (transaction: CoreTransaction) => {
      const active = ports.live.join?.(transaction);
      return active === undefined
        ? Effect.fail(unavailable('Full-target Action approval requires the original transaction-joining SQL services'))
        : Effect.succeed(active);
    };
    const human = Effect.fn('ActionApproval.humanV2')(function* human(
      scope: OperationalScope,
      transaction?: CoreTransaction,
      principalId: PrincipalId = PrincipalIdSchema.make(scope.principalId),
    ) {
      const kind = yield* ports.enforcement.principalKinds
        .readKind({ principalId, scope, tenantId: TenantIdSchema.make(scope.tenantId) }, transaction)
        .pipe(Effect.mapError((cause) => unavailable('The actual approving/requesting person is unavailable', cause)));
      if (Option.isNone(kind)) {
        return yield* refused('Only the actual human principal can request, approve or execute this Action');
      }
      return yield* Effect.fromResult(verifyHumanPrincipal({ principalId, principalKind: kind.value }));
    });
    const source = (command: ActionCommandV2, scope: OperationalScope) =>
      resolveRegisteredActionSourceV2({ command, owners: ports.owners, scope });
    const load = Effect.fn('ActionApproval.loadV2')(function* load(input: {
      readonly proposalId: ExecuteCommand['proposalId'];
      readonly scope: OperationalScope;
      readonly scopeId: ExecuteCommand['scopeId'];
    }) {
      const proposal = yield* ports.live.records.recordsFor(input.scope).load({
        proposalId: input.proposalId,
        scopeId: input.scopeId,
        tenantId: TenantIdSchema.make(input.scope.tenantId),
      });
      if (Option.isNone(proposal)) {
        return yield* refused('The original proposal is not available in this scope');
      }
      const record = yield* ports.frozenCommands
        .load(input.scope, { proposalId: proposal.value.id, scopeId: proposal.value.scopeId })
        .pipe(Effect.mapError((cause) => unavailable('The immutable Action command could not be read', cause)));
      if (Option.isNone(record)) {
        return yield* refused('The mandate has no original durable proposal and frozen command');
      }
      const verified = verifyFrozenCommand(record.value);
      if (
        Result.isFailure(verified) ||
        record.value.commandDigest !== proposal.value.commandDigest ||
        record.value.command.capabilityKey !== proposal.value.capabilityKey ||
        proposal.value.actionAuthority === undefined ||
        proposal.value.id !== input.proposalId ||
        record.value.proposalId !== proposal.value.id ||
        record.value.scopeId !== proposal.value.scopeId ||
        record.value.tenantId !== proposal.value.tenantId ||
        proposal.value.tenantId !== input.scope.tenantId ||
        proposal.value.scopeId !== input.scopeId ||
        proposal.value.target !== undefined ||
        record.value.command.target !== undefined
      ) {
        return yield* refused('Only an exact forward full-command mandate can use the current Action dispatcher');
      }
      const command = yield* decodeActionCommandV2(record.value.command.payload).pipe(
        Effect.mapError(authorityFailure),
      );
      if (command.actionKey !== record.value.actionKey) {
        return yield* refused('The immutable command belongs to a different registered Action');
      }
      return { command, proposal: proposal.value, record: record.value };
    });
    const requester = Effect.fn('ActionApproval.prepareRequesterV2')(function* requester(input: {
      readonly command: ActionCommandV2;
      readonly now: Date;
      readonly proposal: Proposal;
      readonly scope: OperationalScope;
    }) {
      const { command, now, proposal, scope } = input;
      const proof = proposal.actionAuthority;
      if (proof === undefined) {
        return yield* refused('A scalar historical proposal cannot be reinterpreted as full-target authority');
      }
      yield* human(scope, undefined, proof.principalId);
      const prepared = yield* prepareBoundActionAuthorityV2({
        command,
        expectation: {
          phase: 'requester',
          principalId: actorPrincipal(proposal.requester),
          scopeId: proposal.scopeId,
        },
        now,
        ports: enforcement,
        proof,
        scope,
      }).pipe(Effect.mapError(authorityFailure));
      return {
        ...prepared,
        recheck: (at: Date, transaction: CoreTransaction) =>
          human(scope, transaction, proof.principalId).pipe(
            Effect.mapError(requesterKindFailure),
            Effect.andThen(prepared.recheck(at, transaction)),
          ),
      };
    });
    const lock = Effect.fn('ActionApproval.lockV2')(function* lock(input: {
      readonly command: ActionCommandV2;
      readonly operation?: 'read' | 'write';
      readonly revision: string;
      readonly scope: OperationalScope;
      readonly transaction: CoreTransaction;
    }) {
      yield* lockApplicationCompositionAuthority(input.transaction, input.revision, input.operation ?? 'write').pipe(
        Effect.mapError((cause) => unavailable('The approving owner release is no longer current', cause)),
      );
      yield* lockActionAccessFence(
        input.transaction,
        input.scope,
        input.command.legalEntityScope,
        input.command.declaration.kind === 'admin',
      ).pipe(Effect.mapError(authorityFailure));
    });

    const prepareProposal: ActionApprovalLifecycleV2['prepareProposal'] = Effect.fn('ActionApproval.prepareProposalV2')(
      function* prepareProposal(input) {
        const command = yield* decodeActionCommandV2(input.command).pipe(Effect.mapError(authorityFailure));
        const original = yield* source(command, input.scope);
        if (original.registration !== input.registration) {
          return yield* refused('The proposing Action must be the original registered owner executable');
        }
        yield* published(command, ports.live);
        const now = yield* DateTime.nowAsDate;
        const [person, authority] = yield* Effect.all(
          [
            human(input.scope),
            prepareActionAuthorityV2({
              command,
              gate,
              now,
              phase: 'requester',
              scope: input.scope,
            }).pipe(Effect.mapError(authorityFailure)),
          ],
          { concurrency: 1 },
        );
        return new PreparedActionStepV2({
          actionInvocationId: input.actionInvocationId,
          authority,
          command,
          requester: person,
          scope: input.scope,
          scopeHash: computeCanonicalValueHash(input.scope),
          source: original,
        });
      },
    );
    const propose: ActionApprovalLifecycleV2['propose'] = Effect.fn('ActionApproval.proposeV2')(
      function* propose(input) {
        const prepared = PreparedActionStepV2.read(input.preparation);
        if (
          prepared === undefined ||
          prepared.scopeHash !== computeCanonicalValueHash(input.scope) ||
          input.command.actionInvocationId === undefined ||
          input.command.actionInvocationId !== prepared.actionInvocationId ||
          input.command.actionKey !== prepared.command.actionKey ||
          input.command.scopeId !== prepared.authority.proof.scopeId ||
          input.command.tenantId !== input.scope.tenantId ||
          input.command.command.capabilityKey !== input.command.capabilityKey ||
          input.command.capabilityKey !== CapabilityKeySchema.make(prepared.command.declaration.key) ||
          input.command.command.target !== undefined ||
          input.command.target !== undefined ||
          !Predicate.isTagged(input.command.actor, 'Principal') ||
          input.command.actor.principalId !== prepared.requester.principalId ||
          input.command.commandDigest !== prepared.authority.proof.commandDigest ||
          computeCanonicalValueHash(input.command.command.payload) !== computeCanonicalValueHash(prepared.command)
        ) {
          return yield* refused('Proposal preparation belongs to another full command, invocation context or person');
        }
        const services = yield* joined(input.transaction);
        yield* lock({
          command: prepared.command,
          revision: prepared.source.revision,
          scope: input.scope,
          transaction: input.transaction,
        });
        const capability = yield* published(prepared.command, services);
        const person = yield* human(input.scope, input.transaction);
        const now = DateTime.toDateUtc(
          yield* trustedTransactionTime(input.transaction).pipe(Effect.mapError(scopeTimeUnavailable)),
        );
        const proof = yield* prepared.authority.recheck(now, input.transaction).pipe(Effect.mapError(authorityFailure));
        const proposal = yield* proposeActionV2({
          capability,
          command: prepared.command,
          now,
          proposalId: proposalIdForInvocation(input.command.tenantId, input.command.actionInvocationId),
          requester: person,
          requesterAuthority: proof,
          scopeId: proof.scopeId,
          tenantId: TenantIdSchema.make(input.scope.tenantId),
        }).pipe(Effect.catchTag('ActionPermissionCheckError', forwardProofFailure));
        const create = services.records.recordsFor(input.scope).createWithFrozenCommand;
        if (create === undefined) {
          return yield* unavailable('The joined immutable full-command writer is unavailable');
        }
        return yield* create({
          actionInvocationId: input.command.actionInvocationId,
          frozen: {
            actionKey: input.command.actionKey,
            command: input.command.command,
            commandDigest: proof.commandDigest,
            proposalId: proposal.id,
            scopeId: proposal.scopeId,
            tenantId: proposal.tenantId,
          },
          proposal,
          transaction: input.transaction,
        });
      },
    );
    const evaluateApproval = Effect.fn('ActionApproval.evaluateApprovalV2')(function* evaluateApproval(
      input: Parameters<ActionApprovalLifecycleV2['approve']>[0],
      operation: 'inspect' | 'approve',
    ) {
      if (
        !Predicate.isTagged(input.command.approver, 'Principal') ||
        input.command.approver.principalId !== input.scope.principalId ||
        input.command.tenantId !== input.scope.tenantId ||
        input.command.scopeId !== input.proposal.scopeId ||
        input.command.proposalId !== input.proposal.id
      ) {
        return yield* refused('The approver is not the trusted scope human');
      }
      const stored = yield* load({ ...input.command, scope: input.scope });
      if (!sameProposal(stored.proposal, input.proposal)) {
        return yield* new ApprovalStorageConflictError({
          code: 'approval_storage_conflict',
          reason: 'The proposal changed before approval preparation',
        });
      }
      const original = yield* source(stored.command, input.scope);
      yield* published(stored.command, ports.live);
      const person = yield* human(input.scope);
      const now = yield* DateTime.nowAsDate;
      const [request, approval] = yield* Effect.all(
        [
          requester({ command: stored.command, now, proposal: stored.proposal, scope: input.scope }),
          prepareActionAuthorityV2({
            command: stored.command,
            gate,
            now,
            phase: 'approver',
            scope: input.scope,
          }).pipe(Effect.mapError(authorityFailure)),
        ],
        { concurrency: 1 },
      );
      // Every remote question above completes before this native SQL transaction acquires a lease.
      return yield* ports.database.executor
        .transaction((transaction) =>
          Effect.gen(function* approveInTransaction() {
            yield* installOperationalScope(transaction, input.scope, ports.database.enrollment);
            const services = yield* joined(transaction);
            yield* lock({
              command: stored.command,
              operation: operation === 'inspect' ? 'read' : 'write',
              revision: original.revision,
              scope: input.scope,
              transaction,
            });
            const records = services.records.recordsFor(input.scope);
            const current = yield* records.load(input.command);
            if (Option.isNone(current) || !sameProposal(current.value, stored.proposal)) {
              return yield* new ApprovalStorageConflictError({
                code: 'approval_storage_conflict',
                reason: 'The proposal changed before the approval CAS',
              });
            }
            const capability = yield* published(stored.command, services);
            const currentPerson = yield* human(input.scope, transaction);
            if (currentPerson.principalId !== person.principalId) {
              return yield* refused('The approving person changed');
            }
            const at = DateTime.toDateUtc(
              yield* trustedTransactionTime(transaction).pipe(Effect.mapError(scopeTimeUnavailable)),
            );
            const currentRequesterAuthority = yield* request
              .recheck(at, transaction)
              .pipe(Effect.mapError(authorityFailure));
            const approverAuthority = yield* approval.recheck(at, transaction).pipe(Effect.mapError(authorityFailure));
            const approved = yield* approveActionV2({
              approver: currentPerson,
              approverAuthority,
              capability,
              command: stored.command,
              currentRequesterAuthority,
              now: at,
              policy: input.command.policy,
              proposal: current.value,
            }).pipe(Effect.catchTag('ActionPermissionCheckError', forwardProofFailure));
            if (operation === 'approve') {
              yield* records.save({ expectedStatus: 'pending', proposal: approved });
            }
            return approved;
          }).pipe(insideDatabaseTransaction(stored.command.actionKey)),
        )
        .pipe(
          recoverSqlTransactionError,
          Effect.catchTags({
            OperationContextUnavailable: (cause) => Effect.fail(unavailable('Approval scope is unavailable', cause)),
            SqlError: (cause) =>
              Effect.fail(
                new ApprovalStorageUnavailableError({ code: 'approval_storage_unavailable', reason: cause.message }),
              ),
          }),
        );
    });
    const approve: ActionApprovalLifecycleV2['approve'] = (input) => evaluateApproval(input, 'approve');
    const inspectApproval: ActionApprovalLifecycleV2['inspectApproval'] = (input) =>
      evaluateApproval(input, 'inspect').pipe(
        Effect.as(true),
        Effect.catchTags({
          ApprovalRefusedError: () => Effect.succeed(false),
          MandateRefusedError: () => Effect.succeed(false),
        }),
      );
    const prepareExecution: ActionApprovalLifecycleV2['prepareExecution'] = Effect.fn(
      'ActionApproval.prepareExecutionV2',
    )(function* prepareExecution(input) {
      const stored = yield* load(input);
      const original = yield* source(stored.command, input.scope);
      const { approval } = stored.proposal;
      if (
        original.registration !== input.registration ||
        stored.proposal.status !== 'approved' ||
        approval === undefined ||
        !('actionAuthority' in approval) ||
        approval.approverId !== input.scope.principalId
      ) {
        return yield* refused('Only the approving human executes the original forward registered Action');
      }
      yield* published(stored.command, ports.live);
      yield* human(input.scope);
      const now = yield* DateTime.nowAsDate;
      const [request, approver] = yield* Effect.all(
        [
          requester({ command: stored.command, now, proposal: stored.proposal, scope: input.scope }),
          prepareBoundActionAuthorityV2({
            command: stored.command,
            expectation: { phase: 'approver', principalId: approval.approverId, scopeId: stored.proposal.scopeId },
            now,
            ports: enforcement,
            proof: approval.actionAuthority,
            scope: input.scope,
          }).pipe(Effect.mapError(authorityFailure)),
        ],
        { concurrency: 1 },
      );
      return new PreparedActionStepV2({
        approver,
        command: stored.command,
        proposal: stored.proposal,
        requester: request,
        scope: input.scope,
        scopeHash: computeCanonicalValueHash(input.scope),
        source: original,
      });
    });
    const execute: ActionApprovalLifecycleV2['execute'] = Effect.fn('ActionApproval.executeV2')(
      function* execute(input) {
        const prepared = PreparedActionStepV2.read(input.preparation);
        if (
          prepared === undefined ||
          prepared.scopeHash !== computeCanonicalValueHash(input.scope) ||
          input.command.commandDigest !== prepared.proposal.commandDigest ||
          input.command.proposalId !== prepared.proposal.id ||
          input.command.scopeId !== prepared.proposal.scopeId ||
          input.command.tenantId !== input.scope.tenantId ||
          !Predicate.isTagged(input.command.actor, 'Principal') ||
          input.command.actor.principalId !== input.scope.principalId
        ) {
          return yield* refused('The mandate preparation is not bound to this full command and trusted context');
        }
        const services = yield* joined(input.transaction);
        yield* lock({
          command: prepared.command,
          revision: prepared.source.revision,
          scope: input.scope,
          transaction: input.transaction,
        });
        const records = services.records.recordsFor(input.scope);
        const current = yield* records.load(input.command);
        if (Option.isNone(current) || !sameProposal(current.value, prepared.proposal)) {
          return yield* refused('The approved proposal changed before owner execution');
        }
        yield* published(prepared.command, services);
        const person = yield* human(input.scope, input.transaction);
        const now = DateTime.toDateUtc(
          yield* trustedTransactionTime(input.transaction).pipe(Effect.mapError(scopeTimeUnavailable)),
        );
        const currentRequesterAuthority = yield* prepared.requester
          .recheck(now, input.transaction)
          .pipe(Effect.mapError(authorityFailure));
        const currentApproverAuthority = yield* prepared.approver
          .recheck(now, input.transaction)
          .pipe(Effect.mapError(authorityFailure));
        const executed = yield* executeActionV2({
          actionInvocationId: input.command.actionInvocationId,
          actor: person,
          command: prepared.command,
          currentApproverAuthority,
          currentRequesterAuthority,
          now,
          proposal: current.value,
        }).pipe(Effect.catchTag('ActionPermissionCheckError', forwardProofFailure));
        if (records.executeInTransaction === undefined) {
          return yield* unavailable('The native joined mandate CAS writer is unavailable');
        }
        yield* records.executeInTransaction({ expectedStatus: 'approved', proposal: executed }, input.transaction);
        return executed;
      },
    );
    const recheckAuthority: ActionApprovalLifecycleV2['recheckAuthority'] = Effect.fn(
      'ActionApproval.recheckAuthorityV2',
    )(function* recheckAuthority(input) {
      if (isProposalTerminal(input.proposal.status)) {
        return 'live';
      }
      const stored = yield* load({
        proposalId: input.proposal.id,
        scope: input.scope,
        scopeId: input.proposal.scopeId,
      });
      if (!sameProposal(stored.proposal, input.proposal)) {
        return yield* new ApprovalStorageConflictError({
          code: 'approval_storage_conflict',
          reason: 'The proposal changed before its full authority recheck',
        });
      }
      yield* source(stored.command, input.scope);
      const now = yield* DateTime.nowAsDate;
      const authority = Effect.gen(function* inspectEveryBoundAuthority() {
        yield* published(stored.command, ports.live);
        yield* requester({ command: stored.command, now, proposal: stored.proposal, scope: input.scope });
        const { approval } = stored.proposal;
        if (approval !== undefined) {
          if (!('actionAuthority' in approval)) {
            return yield* unavailable('A forward approval is missing its complete authority proof');
          }
          yield* human(input.scope, undefined, approval.approverId);
          yield* prepareBoundActionAuthorityV2({
            command: stored.command,
            expectation: { phase: 'approver', principalId: approval.approverId, scopeId: stored.proposal.scopeId },
            now,
            ports: enforcement,
            proof: approval.actionAuthority,
            scope: input.scope,
          }).pipe(Effect.mapError(authorityFailure));
        }
        return yield* Effect.void;
      });
      return yield* authority.pipe(
        Effect.as('live' as const),
        Effect.catchTags({
          ApprovalRefusedError: () => Effect.succeed('lost' as const),
          MandateRefusedError: () => Effect.succeed('lost' as const),
        }),
      );
    });
    return {
      lifecycle: Object.freeze({
        approve,
        execute,
        inspectApproval,
        prepareExecution,
        prepareProposal,
        propose,
        recheckAuthority,
      }),
      ports,
    };
  },
);

function constructActionApprovalLifecycleV2(): Effect.Effect<
  ConstructedActionApprovalLifecycleV2,
  never,
  ActionApprovalLifecycleV2Ports | AccessDecisionGate
>;
function constructActionApprovalLifecycleV2(
  configuration: OwnerActionApprovalConfiguration,
): Effect.Effect<ConstructedActionApprovalLifecycleV2, never, OwnerActionApprovalRequirements>;
function constructActionApprovalLifecycleV2(
  configuration?: OwnerActionApprovalConfiguration,
): Effect.Effect<
  ConstructedActionApprovalLifecycleV2,
  never,
  ActionApprovalLifecycleV2Ports | OwnerActionApprovalRequirements
> {
  return constructActionApprovalLifecycleV2Effect(configuration);
}

/** Existing contextual entrypoint for explicitly assembled native approval ports. */
export const makeActionApprovalLifecycleV2 = Effect.fn('ActionApproval.makeLifecycleV2')(
  function* makeActionApprovalLifecycleV2(): Effect.fn.Return<
    ActionApprovalLifecycleV2,
    never,
    ActionApprovalLifecycleV2Ports | AccessDecisionGate
  > {
    return (yield* constructActionApprovalLifecycleV2()).lifecycle;
  },
);

/** Owner-local construction takes only definition data and retains all real Context requirements. */
export const makeOwnerActionApprovalLifecycleV2 = Effect.fn('ActionApproval.makeOwnerLifecycleV2')(
  function* makeOwnerActionApprovalLifecycleV2(configuration: OwnerActionApprovalConfiguration) {
    return yield* constructActionApprovalLifecycleV2(configuration);
  },
);
