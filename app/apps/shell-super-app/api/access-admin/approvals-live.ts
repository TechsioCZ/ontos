import type { OperationalScope } from '@app/core-runtime';
import { frozenCommandAmount } from '@app/core-runtime/access/approvals/governed-amount';
import type { GovernedAmountDescriptor } from '@app/core-runtime/access/approvals/governed-amount';
import { AccessApprovalsInbox } from '@app/core-runtime/access/approvals/inbox';
import type { AccessApprovalsInboxService } from '@app/core-runtime/access/approvals/inbox';
import type { FrozenCommandRecord } from '@app/core-runtime/access/approvals/frozen-command';
import { AccessChangesCommands } from '@app/core-runtime/access/changes/commands';
import type { AccessAmount } from '@app/core-runtime/access/enforcement';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
} from '@app/core-runtime/access/ids';
import { AccessPeopleDirectory } from '@app/core-runtime/access/intent/people-directory';
import { Context, Effect, Layer, Match, Option, Predicate, Schema } from 'effect';

import { AccessApprovalsAuthoritySource } from './approvals-authority.ts';
import type { AccessApprovalsAuthority } from './approvals-authority.ts';
import { AccessApprovalsCommands } from './approvals-commands.ts';
import type { AccessApprovalsCommandsService } from './approvals-commands.ts';
import type {
  ApprovalCommandFailure,
  ApprovalCommandPreview,
  ApprovalPortUnavailable,
  ApprovalRecord,
  ApprovalWitness,
} from './approvals-contract.ts';
import { publishedDeclaration, releaseReader } from './explain.ts';

/*
 * The live Core seam of "Ke schválení": the two ports the BFF (`approvals.ts`) is written against,
 * answered by Core's approvals inbox (`access/approvals/inbox.ts`), the published release, the people
 * directory and the Action registrations this process holds. Nothing here decides authority: the BFF
 * asks the gate, Core re-checks every witness, and this module only translates between the two.
 *
 * Three limits are deliberate:
 *
 * - **Execution stays closed.** The inbox binds no owner transaction, so Core's `execute` is
 *   unavailable from here, and the BFF refuses execution before it would ask (P6).
 * - **The preview shows no payload field.** Core does not yet publish which fields of a frozen command
 *   are safe to show, so every field is counted as redacted and the screen shows the Action, the
 *   capability, the digest and the target. Nothing a person could misread as the full command is shown.
 * - **The governed amount comes from the owner Action** (O18). A command whose Action this process
 *   registers is resolved by `frozenCommandAmount` with that registration. A command of an Action this
 *   process does not hold is resolved only when the published declaration names no amount at all;
 *   otherwise the amount is unknown here, which is unavailability and never "no amount".
 */

/* ------------------------------------------------------------------------------------------------
 * The Action registrations whose governed amount this process can resolve (O18)
 * ---------------------------------------------------------------------------------------------- */

/** One owner Action whose frozen commands this process can resolve the governed amount of. */
export interface AccessApprovalAction {
  readonly actionKey: string;
  readonly amountOf: (
    record: FrozenCommandRecord,
    scope: OperationalScope,
  ) => Effect.Effect<Option.Option<AccessAmount>, { readonly reason: string }>;
}

/** An Action registration as the registry holds it: its own rule, bound to its own payload schema. */
export const approvalActionOf = <PayloadSchema extends Schema.ConstraintDecoder<unknown>>(
  descriptor: GovernedAmountDescriptor<PayloadSchema>,
): AccessApprovalAction => ({
  actionKey: descriptor.actionKey,
  amountOf: (record, scope) => frozenCommandAmount({ descriptor, record, scope }),
});

export interface AccessApprovalActionsService {
  readonly actionOf: (actionKey: string) => Option.Option<AccessApprovalAction>;
}

export class AccessApprovalActions extends Context.Service<AccessApprovalActions, AccessApprovalActionsService>()(
  '@app/shell-super-app/api/access-admin/approvals-live/AccessApprovalActions',
) {}

/** The registrations a composition hands over, keyed by their own Action key. */
export const accessApprovalActionsLayer = (
  actions: readonly AccessApprovalAction[],
): Layer.Layer<AccessApprovalActions> => {
  const byKey = new Map(actions.map((action) => [action.actionKey, action] as const));
  return Layer.succeed(AccessApprovalActions, {
    actionOf: (actionKey) => Option.fromUndefinedOr(byKey.get(actionKey)),
  });
};

/* ------------------------------------------------------------------------------------------------
 * Core's answers in the BFF's vocabulary
 * ---------------------------------------------------------------------------------------------- */

type InboxApprovals = ReturnType<AccessApprovalsInboxService['approvals']>;
type Proposal = Effect.Success<ReturnType<AccessApprovalsInboxService['open']>>[number];
type ApprovalsFailure = Effect.Error<ReturnType<InboxApprovals['approve']>>;
type BoundWitness = Parameters<InboxApprovals['reject']>[0]['approveAuthority'][number];

const portUnavailable = (reason: string): ApprovalPortUnavailable => ({ _tag: 'ApprovalPortUnavailable', reason });

const refused = (code: string, reason: string, retryable = false): ApprovalCommandFailure => ({
  _tag: 'ApprovalCommandRefused',
  code,
  reason,
  retryable,
});

/** A storage failure is a retry; Core's own refusal keeps its code, so the BFF maps the rule once. */
const commandFailureOf = (failure: ApprovalsFailure): ApprovalCommandFailure =>
  Match.value(failure).pipe(
    Match.tag('ApprovalStorageUnavailableError', ({ reason }) => portUnavailable(reason)),
    Match.tag('ApprovalAuthorityUnavailableError', ({ reason }) => refused('authority_unavailable', reason, true)),
    Match.tag('ApprovalStorageConflictError', ({ reason }) => refused('storage_conflict', reason)),
    Match.tag('ProposalIntegrityError', 'CommandNotCanonicalError', ({ reason }) =>
      refused('command_integrity', reason, true),
    ),
    Match.tag('ApprovalRefusedError', 'MandateRefusedError', 'ProposalRefusedError', ({ code, reason }) =>
      refused(code, reason),
    ),
    Match.exhaustive,
  );

/** One stored proposal as the BFF's record: plain identifiers, the requester's own tag (guarantee 4). */
const recordOf = (proposal: Proposal): ApprovalRecord => {
  const requester: ApprovalRecord['requester'] = Predicate.isTagged(proposal.requester, 'Agent')
    ? { _tag: 'Agent', agentId: proposal.requester.agentId, principalId: proposal.requester.principalId }
    : { _tag: 'Principal', principalId: proposal.requester.principalId };
  const base: ApprovalRecord = {
    capabilityKey: proposal.capabilityKey,
    commandDigest: proposal.commandDigest,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    id: proposal.id,
    requester,
    scopeId: proposal.scopeId,
    status: proposal.status,
    tenantId: proposal.tenantId,
  };
  const { approval, endedAt, execution, rejectedBy, target } = proposal;
  // Each optional fact is added only when the stored proposal carries it.
  const approved =
    approval === undefined
      ? base
      : {
          ...base,
          approval: { approvedAt: approval.approvedAt, approverId: approval.approverId, expiresAt: approval.expiresAt },
        };
  const executed =
    execution === undefined
      ? approved
      : {
          ...approved,
          execution: { actionInvocationId: execution.actionInvocationId, executedAt: execution.executedAt },
        };
  const ended = endedAt === undefined ? executed : { ...executed, endedAt };
  const rejected = rejectedBy === undefined ? ended : { ...ended, rejectedBy };
  return target === undefined ? rejected : { ...rejected, target };
};

/** A witness the gate just resolved for this person, branded for Core, which re-checks it (O49). */
const boundOf = (witness: ApprovalWitness): BoundWitness => ({
  assignmentIncarnationId: AssignmentIncarnationIdSchema.make(witness.assignmentIncarnationId),
  capabilityKey: CapabilityKeySchema.make(witness.capabilityKey),
  grantIncarnationId: GrantIncarnationIdSchema.make(witness.grantIncarnationId),
  holderId: { _tag: 'Principal', principalId: PrincipalIdSchema.make(witness.holderId.principalId) },
  scopeId: AccessScopeIdSchema.make(witness.scopeId),
});

/** A frozen payload's top-level fields; each one is counted as redacted on the screen. */
const decodePayloadFields = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

/* ------------------------------------------------------------------------------------------------
 * The two live ports
 * ---------------------------------------------------------------------------------------------- */

const liveCommands = Effect.gen(function* liveApprovalsCommands() {
  const actions = yield* AccessApprovalActions;
  const directory = yield* AccessPeopleDirectory;
  const inbox = yield* AccessApprovalsInbox;
  const release = releaseReader(yield* AccessChangesCommands);

  const open: AccessApprovalsCommandsService['open'] = (scope) =>
    inbox.open(scope).pipe(
      Effect.map((proposals) => proposals.map(recordOf)),
      Effect.mapError(({ reason }) => portUnavailable(reason)),
    );

  /** The open proposal with this id; an ended or foreign one is absent, like one that never existed. */
  const openProposal = (scope: OperationalScope, proposalId: string) =>
    inbox.open(scope).pipe(
      Effect.map((proposals) => Option.fromUndefinedOr(proposals.find((proposal) => proposal.id === proposalId))),
      Effect.mapError(({ reason }) => portUnavailable(reason)),
    );

  const load: AccessApprovalsCommandsService['load'] = (scope, proposalId) =>
    openProposal(scope, proposalId).pipe(Effect.map(Option.map(recordOf)));

  /** The acting person's own kind, from Core identity: only a verified human decides (O46). */
  const actorKind = Effect.fn('AccessApprovalsLive.actorKind')(function* actorKindOf(scope: OperationalScope) {
    const principalId = PrincipalIdSchema.make(scope.principalId);
    const [person] = yield* directory
      .people(scope, [principalId])
      .pipe(Effect.mapError(({ reason }) => portUnavailable(reason)));
    if (person === undefined) {
      return yield* Effect.fail(refused('approver_not_human', 'The acting person is not a principal of this tenant'));
    }
    return Schema.is(Schema.Literals(['agent', 'human', 'integration', 'service', 'system']))(person.kind)
      ? person.kind
      : yield* Effect.fail(refused('approver_not_human', 'The acting principal has no kind Core can decide for'));
  });

  /** The proposal a decision names, with the facts every decision command carries. */
  const decisionFacts = Effect.fn('AccessApprovalsLive.decisionFacts')(function* decisionFactsOf(
    scope: OperationalScope,
    proposalId: string,
  ) {
    const proposal = yield* openProposal(scope, proposalId);
    if (Option.isNone(proposal)) {
      return yield* Effect.fail(refused('proposal_not_found', 'No open proposal with this id exists in this tenant'));
    }
    const kind = yield* actorKind(scope);
    return {
      actor: { _tag: 'Principal' as const, principalId: PrincipalIdSchema.make(scope.principalId) },
      kind,
      proposalId: proposal.value.id,
      scopeId: proposal.value.scopeId,
      tenantId: proposal.value.tenantId,
    };
  });

  const approve: AccessApprovalsCommandsService['approve'] = Effect.fn('AccessApprovalsLive.approve')(
    function* approveProposal(scope, input) {
      const facts = yield* decisionFacts(scope, input.proposalId);
      const approved = yield* inbox
        .approvals(scope)
        .approve({
          approver: facts.actor,
          approverKind: facts.kind,
          authority: {
            approval: boundOf(input.approval),
            execution: boundOf(input.execution),
            parentRecordRead: input.parentRecordRead.map(boundOf),
          },
          // A command is confirmed by somebody else; the BFF refuses a self-approval before it asks.
          policy: { selfApproval: 'forbidden' },
          proposalId: facts.proposalId,
          scopeId: facts.scopeId,
          tenantId: facts.tenantId,
        })
        .pipe(Effect.mapError(commandFailureOf));
      return recordOf(approved);
    },
  );

  const reject: AccessApprovalsCommandsService['reject'] = Effect.fn('AccessApprovalsLive.reject')(
    function* rejectProposal(scope, input) {
      const facts = yield* decisionFacts(scope, input.proposalId);
      const rejected = yield* inbox
        .approvals(scope)
        .reject({
          approveAuthority: input.approveAuthority.map(boundOf),
          approver: facts.actor,
          approverKind: facts.kind,
          proposalId: facts.proposalId,
          scopeId: facts.scopeId,
          tenantId: facts.tenantId,
        })
        .pipe(Effect.mapError(commandFailureOf));
      return recordOf(rejected);
    },
  );

  const withdraw: AccessApprovalsCommandsService['withdraw'] = Effect.fn('AccessApprovalsLive.withdraw')(
    function* withdrawProposal(scope, input) {
      const facts = yield* decisionFacts(scope, input.proposalId);
      const withdrawn = yield* inbox
        .approvals(scope)
        .withdraw({
          actor: facts.actor,
          proposalId: facts.proposalId,
          scopeId: facts.scopeId,
          tenantId: facts.tenantId,
          withdrawAuthority: input.approveAuthority.map(boundOf),
        })
        .pipe(Effect.mapError(commandFailureOf));
      return recordOf(withdrawn);
    },
  );

  /** The stored command a proposal froze, or none; an unreadable or corrupt one is unavailable. */
  const frozenCommand = (scope: OperationalScope, input: { readonly proposalId: string; readonly scopeId: string }) =>
    inbox
      .frozenCommand(scope, {
        proposalId: ProposalIdSchema.make(input.proposalId),
        scopeId: AccessScopeIdSchema.make(input.scopeId),
      })
      .pipe(Effect.mapError(({ reason }) => portUnavailable(reason)));

  const preview: AccessApprovalsCommandsService['preview'] = Effect.fn('AccessApprovalsLive.preview')(
    function* previewCommand(scope, input) {
      const stored = yield* frozenCommand(scope, input);
      if (Option.isNone(stored) || stored.value.frozenAt === undefined) {
        // Without the instant Core froze it, the screen could not say what is being approved.
        return Option.none<ApprovalCommandPreview>();
      }
      const record = stored.value;
      const base: ApprovalCommandPreview = {
        actionKey: record.actionKey,
        capabilityKey: record.command.capabilityKey,
        digestShort: record.commandDigest.slice(0, 12),
        fields: [],
        frozenAt: stored.value.frozenAt,
        redactedFieldCount: Option.match(decodePayloadFields(record.command.payload), {
          onNone: () => 1,
          onSome: (fields) => Object.keys(fields).length,
        }),
      };
      const { target } = record.command;
      return Option.some(target === undefined ? base : { ...base, target: { recordKey: target } });
    },
  );

  const governedAmount: AccessApprovalsCommandsService['governedAmount'] = Effect.fn(
    'AccessApprovalsLive.governedAmount',
  )(function* governedAmountOf(scope, input) {
    const stored = yield* frozenCommand(scope, input);
    if (Option.isNone(stored)) {
      return yield* Effect.fail(portUnavailable('the frozen command of this proposal cannot be read'));
    }
    const record = stored.value;
    const action = actions.actionOf(record.actionKey);
    if (Option.isSome(action)) {
      return yield* action.value.amountOf(record, scope).pipe(Effect.mapError(({ reason }) => portUnavailable(reason)));
    }
    const published = yield* release().pipe(Effect.mapError(({ reason }) => portUnavailable(reason)));
    const capability = published.find(({ declaration }) => declaration.key === record.command.capabilityKey);
    if (capability === undefined) {
      return yield* Effect.fail(portUnavailable('the capability of this command is not in the published release'));
    }
    if (capability.declaration.amountInput === undefined) {
      // The published declaration governs no amount, so no Action rule could name one (O18).
      return Option.none<AccessAmount>();
    }
    return yield* Effect.fail(
      portUnavailable(`the owner Action ${record.actionKey} that resolves this amount is not registered here`),
    );
  });

  const commands: AccessApprovalsCommandsService = { approve, governedAmount, load, open, preview, reject, withdraw };
  return Object.freeze(commands);
});

const liveAuthority = Effect.gen(function* liveApprovalsAuthority() {
  const directory = yield* AccessPeopleDirectory;
  const inbox = yield* AccessApprovalsInbox;
  const release = releaseReader(yield* AccessChangesCommands);

  const capability: AccessApprovalsAuthority['capability'] = (capabilityKey) =>
    release().pipe(
      Effect.mapError(({ reason }) => portUnavailable(reason)),
      Effect.map((published) => {
        const entry = published.find(({ declaration }) => declaration.key === capabilityKey);
        const declaration = publishedDeclaration(entry);
        return entry === undefined || declaration === undefined
          ? Option.none()
          : Option.some({ declaration, label: entry.declaration.key, moduleKey: entry.moduleKey });
      }),
    );

  const person = (principalId: string, scope: OperationalScope) =>
    directory.people(scope, [PrincipalIdSchema.make(principalId)]).pipe(
      Effect.mapError(({ reason }) => portUnavailable(reason)),
      Effect.map(([row]) => Option.fromUndefinedOr(row)),
    );

  const authority: AccessApprovalsAuthority = {
    capability,
    isAdministrator: (input) =>
      inbox
        .isAdministrator(input.scope, {
          principalId: PrincipalIdSchema.make(input.principalId),
          scopeId: AccessScopeIdSchema.make(input.scopeId),
        })
        .pipe(Effect.mapError(({ reason }) => portUnavailable(reason))),
    person: (principalId, scope) =>
      person(principalId, scope).pipe(Effect.map(Option.map(({ displayName }) => ({ displayName })))),
    principalKind: (principalId, scope) =>
      person(principalId, scope).pipe(
        Effect.map(
          Option.flatMap(({ kind }): Option.Option<'agent' | 'human'> =>
            kind === 'agent' || kind === 'human' ? Option.some(kind) : Option.none(),
          ),
        ),
      ),
    scope: (scopeId, scope) =>
      inbox.scopes(scope).pipe(
        Effect.mapError(({ reason }) => portUnavailable(reason)),
        Effect.map((rows) =>
          Option.map(Option.fromUndefinedOr(rows.find((row) => row.scopeId === scopeId)), (row) =>
            row.legalEntityId === null
              ? { accessScopeId: row.scopeId, kind: 'tenant' as const }
              : { accessScopeId: row.scopeId, kind: 'company' as const, legalEntityId: row.legalEntityId },
          ),
        ),
      ),
  };
  return Object.freeze(authority);
});

/** Both live ports over Core's inbox, the published release, the people directory and the registry. */
export const AccessApprovalsLive: Layer.Layer<
  AccessApprovalsAuthoritySource | AccessApprovalsCommands,
  never,
  AccessApprovalActions | AccessApprovalsInbox | AccessChangesCommands | AccessPeopleDirectory
> = Layer.mergeAll(
  Layer.effect(AccessApprovalsCommands, liveCommands),
  Layer.effect(AccessApprovalsAuthoritySource, liveAuthority),
);
