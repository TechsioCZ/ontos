import type { AccessDeclaration, LegalEntityScope, OperationalScope } from '@app/core-runtime';
import { declaredAccessCarrier, defineSystemModuleEntrypoint } from '@app/core-runtime';
import type { AccessAmount, AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema, ModuleKeySchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Effect, Layer, Option, Predicate, Result, Schema } from 'effect';
import type { Headers as EffectHeaders } from 'effect/http/Headers';

import type {
  AccessAdminProblem,
  AccessApproval,
  DecideAccessApprovalPayload,
  ExecuteAccessApprovalPayload,
  ListAccessApprovalsPayload,
  ListAccessApprovalsResponse,
} from '../../shared/access-admin-api.ts';
import { AccessApprovalSchema } from '../../shared/access-admin-api.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import type { AccessApprovalsAuthority } from './approvals-authority.ts';
import { AccessApprovalsAuthoritySource } from './approvals-authority.ts';
import type { AccessApprovalsCommandsService } from './approvals-commands.ts';
import { AccessApprovalsCommands } from './approvals-commands.ts';
import { approvalRecordRevision } from './approvals-contract.ts';
import type {
  ApprovalCommandFailure,
  ApprovalEligibility,
  ApprovalPortUnavailable,
  ApprovalRecord,
  ApprovalScopeView,
  ApprovalWitness,
} from './approvals-contract.ts';
import { readableCompanies } from './role-read-scope.ts';
import type { AccessAdminSessionService } from './session.ts';
import {
  AccessAdminSession,
  accessAdminConflictProblem,
  accessAdminForbiddenProblem,
  accessAdminInternalProblem,
  accessAdminUnprocessableProblem,
  accessAdminUnavailableProblem,
} from './session.ts';

/*
 * "Ke schválení": the approval inbox and the human decisions on it, as the Shell BFF serves them.
 *
 * Four rules shape this module and nothing else does.
 *
 *   1. **The one gate decides, including this BFF.** Every operation carries its own declared
 *      `shell-super-app.access-approvals.*` capability and asks `AccessDecisionGate` with the request's
 *      trusted tenant context and a Core-minted instant. Administration never needs a selected
 *      company (O28), and a management title is never a body flag.
 *   2. **Facts come from ports, never from the caller** (O64). Whether this person may approve,
 *      reject or withdraw is resolved from the published catalog, their own decision evidence and
 *      the tenant's administration. The request names a proposal, a decision and the status it saw.
 *   3. **A command is never supplied by a browser.** Approval is over the command Core froze for the
 *      proposal; the preview is a server-rendered, field-filtered projection of that stored command,
 *      and execution dispatches the stored command (P5, P6, O80).
 *   4. **Only the approving human executes** (O63), and only once P6 proved exactly-once dispatch.
 *      The execution operation therefore exists and refuses with a typed 403 instead of being
 *      hidden: the read model says why, so the UI shows a disabled control with a reason.
 *   5. **Tenant admission is not company authority** (O88). A proposal in a company's scope is that
 *      company's data — its command, its target and its people — so after the tenant-context answer
 *      the company is asked the same declaration in its own required scope, as the Role editor asks
 *      (`role-read-scope.ts`). A proposal the company does not admit, or whose scope cannot be named,
 *      is withheld from the inbox and refused exactly like a proposal that does not exist. Its own
 *      approve and run authority is asked in that same company scope, never in tenant context.
 */

const MODULE_KEY = 'shell-super-app';
const GROUP = 'access';

/** The three entrypoints of the surface, each with its own capability (O27, O62). */
export const accessApprovalsEntrypoints = Object.freeze({
  decide: defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-approvals.decide',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  execute: defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-approvals.execute',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  list: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-approvals.list',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
});

type ApprovalsEntrypoint = (typeof accessApprovalsEntrypoints)[keyof typeof accessApprovalsEntrypoints];

/**
 * Reading the inbox, deciding a proposal and executing a mandate are administrative work, never
 * business data, so every capability is `kind: 'admin'` in tenant context with no record selector —
 * and Core refuses a routine admin declaration. `declaredAccessCarrier` validates each declaration
 * against its own entrypoint at definition time, so a wrong classification fails here instead of
 * becoming a silently weaker capability (O5, O62).
 */
const declaredDeclaration = (key: string, entrypoint: ApprovalsEntrypoint, level: 'extended' | 'manage') => {
  const carrier = declaredAccessCarrier({
    accessDeclaration: {
      key,
      kind: 'admin',
      modes: ['run'],
      placement: { group: GROUP, level },
      risk: 'sensitive',
      selectors: [],
    },
    entrypoint,
  });
  // A carrier the definition-time validation refused has no declaration, which is a module-level
  // bug: the module cannot describe its own entrypoint, so it does not load.
  return Option.getOrThrow(Option.fromUndefinedOr(carrier.accessDeclaration));
};

/** Published with the Shell module's own declarations by P1; never a private allow of this file. */
export const accessApprovalsDeclarations = Object.freeze({
  decide: declaredDeclaration('shell-super-app.access-approvals.decide', accessApprovalsEntrypoints.decide, 'manage'),
  execute: declaredDeclaration(
    'shell-super-app.access-approvals.execute',
    accessApprovalsEntrypoints.execute,
    'manage',
  ),
  list: declaredDeclaration('shell-super-app.access-approvals.list', accessApprovalsEntrypoints.list, 'extended'),
});

/** An administration surface is tenant work: it never needs a selected company (O28, P3). */
const ADMIN_LEGAL_ENTITY_SCOPE = 'optional' as const;

/**
 * The context a proposal's own business capability is asked in. Admission stays tenant work, but a
 * company proposal's approve and run authority is that company's: it is asked in the company's
 * required scope, so its witnesses name the scope Core validates them against (O88).
 */
interface ProposalContext {
  readonly legalEntityScope: LegalEntityScope;
  readonly scope: OperationalScope;
}

const proposalContextOf = (admitted: OperationalScope, view: ApprovalScopeView): ProposalContext =>
  view.legalEntityId === undefined
    ? { legalEntityScope: ADMIN_LEGAL_ENTITY_SCOPE, scope: admitted }
    : {
        legalEntityScope: 'required',
        scope: Object.freeze({ ...admitted, legalEntityId: LegalEntityIdSchema.make(view.legalEntityId) }),
      };

const APPROVALS_FORBIDDEN = 'Ke schválení is not available to this person.';

/** A denial is 403 — an inbox read or a decision is never "approved" into existence. */
export const accessApprovalsGateProblem = (outcome: 'DENIED' | 'NEEDS_APPROVAL' | 'UNAVAILABLE'): AccessAdminProblem =>
  outcome === 'UNAVAILABLE' ? accessAdminUnavailableProblem() : accessAdminForbiddenProblem(APPROVALS_FORBIDDEN);

/**
 * The execution refusal of this wave: P6 must prove that an approved command runs exactly once before
 * a person may click "Schválit a provést mými právy". Not a transient failure — a product gate — so
 * it is a 403 with its own code and never a retryable 503.
 */
export const accessApprovalsExecutionDisabledProblem = (): AccessAdminProblem =>
  accessAdminForbiddenProblem(
    'approval_execution_disabled: an approved command cannot be executed until the mandate runner proves exactly-once dispatch',
  );

/**
 * The decision refusals, mapped once. A missing authority is a denial. A proposal that moved, a stale
 * revision or a lost compare-and-set is a 409 the caller repairs by re-reading. An unusable request
 * is 422. An unreachable port is the retryable 503 — never a denial (O48).
 */
export const accessApprovalsFailureProblem = (failure: {
  readonly code: string;
  readonly reason: string;
}): AccessAdminProblem => {
  const text = `${failure.code}: ${failure.reason}`;
  if (
    failure.code === 'access_approvals_agent_forbidden' ||
    failure.code === 'access_approvals_approval_authority_missing' ||
    failure.code === 'access_approvals_execution_not_permitted' ||
    failure.code === 'access_approvals_proposal_not_found' ||
    failure.code === 'access_approvals_rejection_not_permitted' ||
    failure.code === 'access_approvals_requester_cannot_reject' ||
    failure.code === 'access_approvals_self_approval_forbidden' ||
    failure.code === 'access_approvals_withdrawal_not_permitted'
  ) {
    return accessAdminForbiddenProblem(text);
  }
  if (
    failure.code === 'access_approvals_already_executed' ||
    failure.code === 'access_approvals_command_changed' ||
    failure.code === 'access_approvals_proposal_expired' ||
    failure.code === 'access_approvals_proposal_not_pending' ||
    failure.code === 'access_approvals_revision_stale' ||
    failure.code === 'access_approvals_storage_conflict'
  ) {
    return accessAdminConflictProblem(text);
  }
  if (
    failure.code === 'access_approvals_authority_lost' ||
    failure.code === 'access_approvals_authority_unavailable' ||
    failure.code === 'access_approvals_command_integrity' ||
    failure.code === 'access_approvals_command_unavailable' ||
    failure.code === 'access_approvals_store_unavailable'
  ) {
    return accessAdminUnavailableProblem();
  }
  return accessAdminUnprocessableProblem(text);
};

/** The revision a caller last saw; a display and stale-token aid, never the authoritative race. */
export const accessApprovalRevision = approvalRecordRevision;

/** The witnesses one decision carries, taken from this person's own side of the evidence (O63). */
export const accessApprovalWitnesses = (
  decision: Effect.Success<ReturnType<AccessDecisionService['decide']>>,
): readonly ApprovalWitness[] => {
  const witnesses: ApprovalWitness[] = [];
  for (const { side, witness } of decision.evidence) {
    if (side === 'principal' && Predicate.isTagged(witness.holderId, 'Principal')) {
      witnesses.push({
        assignmentIncarnationId: witness.assignmentIncarnationId,
        capabilityKey: witness.capabilityKey,
        grantIncarnationId: witness.grantIncarnationId,
        holderId: { _tag: 'Principal', principalId: witness.holderId.principalId },
        scopeId: witness.scopeId,
      });
    }
  }
  return witnesses;
};

/** Adds a member only when it is present, so no empty-object spread decides the wire shape. */
const withOptional = <Base extends object, Key extends PropertyKey, Value>(
  base: Base,
  key: Key,
  value: Value | undefined,
): Base & Partial<Record<Key, NonNullable<Value>>> => (value === undefined ? base : { ...base, [key]: value });

/** A person's display name travels only when the identity directory resolves one. */
const withDisplayName = <Base extends object>(
  base: Base,
  name: Option.Option<{ readonly displayName: string }>,
): Base & { readonly displayName?: string } =>
  Option.isSome(name) ? { ...base, displayName: name.value.displayName } : base;

const allowed = (): ApprovalEligibility => ({ allowed: true });
const notAllowed = (reason: string): ApprovalEligibility => ({ allowed: false, reason });

const commandFailureProblem = (failure: ApprovalCommandFailure): AccessAdminProblem =>
  Predicate.isTagged(failure, 'ApprovalPortUnavailable')
    ? accessAdminUnavailableProblem()
    : accessApprovalsFailureProblem({ code: `access_approvals_${failure.code}`, reason: failure.reason });

const portFailure = (failure: ApprovalPortUnavailable): AccessAdminProblem =>
  accessApprovalsFailureProblem({ code: 'access_approvals_store_unavailable', reason: failure.reason });

const contractFailure = (issue: { readonly message: string }): AccessAdminProblem =>
  accessAdminInternalProblem(`the approval answer did not match its published contract: ${issue.message}`);

/**
 * Every answer is built as plain data and decoded through the published schema, so the wire contract
 * is checked rather than assumed: an answer Core cannot express that way is an internal failure.
 */
/* Every item of a page is decoded on its own (`answerOf`); a page adds only the cursor to them. */

/** The one refusal for a proposal this person may not see: indistinguishable from no proposal at all. */
const proposalNotFound = (): AccessAdminProblem =>
  accessApprovalsFailureProblem({
    code: 'access_approvals_proposal_not_found',
    reason: 'no proposal with this id exists in this tenant',
  });

/** One proposal with the scope it lives in, resolved before anything of it is shaped (O88). */
interface ScopedRecord {
  readonly record: ApprovalRecord;
  readonly scope: ApprovalScopeView;
}

/** One proposal with its scope when the directory names one; an unnamed scope has no company to admit it. */
const scopedRecordOf = (record: ApprovalRecord, view: Option.Option<ApprovalScopeView>): readonly ScopedRecord[] =>
  Option.isSome(view) ? [{ record, scope: view.value }] : [];

/** The stale check a decision starts with; the authoritative race stays Core's status compare-and-set. */
const staleProblem = (record: ApprovalRecord, payload: DecideAccessApprovalPayload): AccessAdminProblem | undefined => {
  if (record.status !== payload.expectedStatus) {
    return accessAdminConflictProblem('the proposal changed since this page was rendered; reload Ke schválení');
  }
  if (payload.revision !== undefined && payload.revision !== accessApprovalRevision(record)) {
    return accessAdminConflictProblem('the proposal revision is no longer the one this screen read');
  }
  return undefined;
};

export interface AccessApprovalsBffService {
  readonly decide: (
    headers: Headers,
    payload: DecideAccessApprovalPayload,
  ) => Effect.Effect<AccessApproval, AccessAdminProblem>;
  readonly execute: (
    headers: Headers,
    payload: ExecuteAccessApprovalPayload,
  ) => Effect.Effect<AccessApproval, AccessAdminProblem>;
  readonly list: (
    headers: Headers,
    payload: ListAccessApprovalsPayload,
  ) => Effect.Effect<ListAccessApprovalsResponse, AccessAdminProblem>;
}

export class AccessApprovalsBff extends Context.Service<AccessApprovalsBff, AccessApprovalsBffService>()(
  '@app/shell-super-app/api/access-admin/approvals/AccessApprovalsBff',
) {}

/** The services this group needs, as the deployment composes them. */
export type AccessApprovalsServices =
  | AccessAdminSession
  | AccessDecisionGate
  | AccessApprovalsAuthoritySource
  | AccessApprovalsCommands;
export type AccessApprovalsContext = Context.Context<AccessApprovalsServices>;

export const makeAccessApprovalsBff = (context: AccessApprovalsContext): AccessApprovalsBffService => {
  const authority: AccessApprovalsAuthority = Context.get(context, AccessApprovalsAuthoritySource);
  const commands: AccessApprovalsCommandsService = Context.get(context, AccessApprovalsCommands);
  const gate: AccessDecisionService = Context.get(context, AccessDecisionGate);
  const session: AccessAdminSessionService = Context.get(context, AccessAdminSession);

  /**
   * The one hand-off every handler starts with: P1's trusted tenant context, then this operation's
   * own capability at a Core-minted instant. No handler trusts a body-supplied tenant, actor,
   * administrator flag or approval authority.
   */
  const admit = Effect.fn('AccessApprovalsBff.admit')(function* admitApprovalOperation(
    headers: Headers,
    declaration: AccessDeclaration,
  ) {
    const scope = yield* session.requireTenantContext(headers);
    const question: GateInput = {
      carrier: { accessDeclaration: declaration },
      legalEntityScope: ADMIN_LEGAL_ENTITY_SCOPE,
      now: yield* DateTime.nowAsDate,
      scope,
    };
    const decision = yield* gate.decide(question);
    if (decision.outcome !== 'ALLOWED') {
      return yield* Effect.fail(accessApprovalsGateProblem(decision.outcome));
    }
    return { now: question.now, scope };
  });

  /**
   * The proposals this person's company authority covers, each with the scope it lives in. A tenant
   * proposal is covered by the tenant-context admission already given; a company proposal only when
   * that company admits the same declaration in its own required scope. A scope the directory cannot
   * name has no company to admit it, so its proposal is withheld: unknown is never read as tenant.
   */
  const readableRecords = Effect.fn('AccessApprovalsBff.readableRecords')(function* readableApprovalRecords(
    admitted: { readonly now: Date; readonly scope: OperationalScope },
    declaration: AccessDeclaration,
    records: readonly ApprovalRecord[],
  ) {
    // One directory read per proposal, in the inbox's own order; each is independent of the others.
    const resolved = yield* Effect.forEach(
      records,
      (record) =>
        authority.scope(record.scopeId, admitted.scope).pipe(
          Effect.mapError(portFailure),
          Effect.map((view) => scopedRecordOf(record, view)),
        ),
      { concurrency: 1 },
    );
    const scoped = resolved.flat();
    const companies = yield* readableCompanies(gate.decide, {
      companies: scoped.flatMap(({ scope }) => (scope.legalEntityId === undefined ? [] : [scope.legalEntityId])),
      declaration,
      now: admitted.now,
      scope: admitted.scope,
    });
    return scoped.filter(({ scope }) =>
      scope.legalEntityId === undefined ? scope.kind === 'tenant' : companies.has(scope.legalEntityId),
    );
  });

  /** One proposal by id, refused like a missing one when it lies outside this person's authority. */
  const readableRecord = Effect.fn('AccessApprovalsBff.readableRecord')(function* readableApprovalRecord(
    admitted: { readonly now: Date; readonly scope: OperationalScope },
    declaration: AccessDeclaration,
    proposalId: string,
  ) {
    const loaded = yield* commands.load(admitted.scope, proposalId).pipe(Effect.mapError(portFailure));
    const [readable] = Option.isSome(loaded) ? yield* readableRecords(admitted, declaration, [loaded.value]) : [];
    return readable ?? (yield* Effect.fail(proposalNotFound()));
  });

  /**
   * One decision of the acting person about the proposal's own capability at the proposal's own
   * target and governed amount. The declaration comes from the published catalog, the target's module
   * from the same entry and the amount from the frozen command, so a caller cannot choose the question
   * or widen it.
   */
  const askOwnDecision = Effect.fn('AccessApprovalsBff.askOwnDecision')(function* askOwnDecisionEffect(input: {
    readonly amount: Option.Option<AccessAmount>;
    readonly context: ProposalContext;
    readonly declaration: AccessDeclaration;
    readonly mode: 'approve' | 'run';
    readonly moduleKey: string;
    readonly target?: string | undefined;
  }) {
    const question: GateInput = withOptional(
      {
        carrier: { accessDeclaration: input.declaration },
        legalEntityScope: input.context.legalEntityScope,
        mode: input.mode,
        now: yield* DateTime.nowAsDate,
        scope: input.context.scope,
      },
      'amount',
      Option.getOrUndefined(input.amount),
    );
    if (input.target === undefined) {
      return yield* gate.decide(question);
    }
    // The target's identifiers are branded facts, so they are decoded rather than asserted.
    const target = Schema.decodeResult(Schema.Struct({ moduleKey: ModuleKeySchema, recordKey: RecordKeySchema }))({
      moduleKey: input.moduleKey,
      recordKey: input.target,
    });
    if (Result.isFailure(target)) {
      return yield* Effect.fail(
        accessAdminUnprocessableProblem('the record this proposal changes is not a known module record'),
      );
    }
    return yield* gate.decide({ ...question, target: target.success });
  });

  /**
   * The stored command as the screen shows it. A proposal whose frozen command cannot be read cannot
   * be approved safely — its digest would prove nothing about a payload nobody can retrieve — so this
   * is a 503, never an empty preview a person might confirm blindly.
   */
  const previewOf = Effect.fn('AccessApprovalsBff.previewOf')(function* previewOfEffect(
    scope: OperationalScope,
    record: ApprovalRecord,
  ) {
    const preview = yield* commands
      .preview(scope, { proposalId: record.id, scopeId: record.scopeId })
      .pipe(Effect.mapError(portFailure));
    if (Option.isNone(preview)) {
      return yield* Effect.fail(
        accessApprovalsFailureProblem({
          code: 'access_approvals_command_unavailable',
          reason: 'the frozen command of this proposal cannot be read',
        }),
      );
    }
    return preview.value;
  });

  /**
   * The money value the proposal's frozen command is governed by, read server-side from the stored
   * command exactly as its mandate will be decided (O18). A capped approve or run grant is asked about
   * this amount; without it the engine would refuse the grant for a missing amount.
   */
  const governedAmountOf = (scope: OperationalScope, record: ApprovalRecord) =>
    commands
      .governedAmount(scope, { proposalId: record.id, scopeId: record.scopeId })
      .pipe(Effect.mapError(portFailure));

  /**
   * The three eligibility facts of one proposal. The requester withdraws their own request (O35); an
   * eligible approver or a scope administrator rejects (O61); and only somebody holding `approve`
   * authority — never the requester — approves it.
   */
  const eligibilityOf = Effect.fn('AccessApprovalsBff.eligibilityOf')(function* eligibilityOfEffect(input: {
    readonly context: ProposalContext;
    readonly entry: { readonly declaration: AccessDeclaration; readonly moduleKey: string };
    readonly headers: Headers;
    readonly principalId: string;
    readonly record: ApprovalRecord;
    readonly scope: OperationalScope;
  }) {
    const { record } = input;
    if (record.status !== 'pending') {
      const reason = `proposal_${record.status}`;
      return { approval: notAllowed(reason), rejection: notAllowed(reason), withdrawal: notAllowed(reason) };
    }
    if (Predicate.isTagged(record.requester, 'Principal') && record.requester.principalId === input.principalId) {
      return {
        approval: notAllowed('requester_cannot_approve'),
        rejection: notAllowed('requester_cannot_reject'),
        withdrawal: allowed(),
      };
    }
    const [administrator, inspection] = yield* Effect.all(
      [
        authority
          .isAdministrator({
            principalId: input.principalId,
            scope: input.scope,
            scopeId: record.scopeId,
            tenantId: record.tenantId,
          })
          .pipe(Effect.mapError(portFailure)),
        commands
          .inspect(input.scope, {
            headers: input.headers,
            proposalId: record.id,
            revision: accessApprovalRevision(record),
          })
          .pipe(Effect.result),
      ],
      { concurrency: 1 },
    );
    const approval = (() => {
      if (Result.isSuccess(inspection)) {
        return inspection.success ? allowed() : notAllowed('approval_not_permitted');
      }
      if (Predicate.isTagged(inspection.failure, 'ApprovalPortUnavailable') || inspection.failure.retryable) {
        return notAllowed('owner_approval_inspection_unavailable');
      }
      return notAllowed(inspection.failure.code);
    })();
    // A proposal whose governed amount cannot be resolved now cannot be approved now, but it stays one
    // row of the inbox: its unreadable amount never hides every other proposal behind a 503.
    const amount = yield* Effect.result(governedAmountOf(input.scope, record));
    if (Result.isFailure(amount)) {
      return {
        approval,
        rejection: administrator ? allowed() : notAllowed('rejection_not_permitted'),
        withdrawal: administrator ? allowed() : notAllowed('withdrawal_not_permitted'),
      };
    }
    const decision = yield* askOwnDecision({
      amount: amount.success,
      context: input.context,
      declaration: input.entry.declaration,
      mode: 'approve',
      moduleKey: input.entry.moduleKey,
      target: record.target,
    });
    const approver = decision.outcome === 'ALLOWED';
    const decider = approver || administrator;
    return {
      // Only the original owner can inspect the complete command and its original governing Read.
      approval,
      rejection: decider ? allowed() : notAllowed('rejection_not_permitted'),
      withdrawal: decider ? allowed() : notAllowed('withdrawal_not_permitted'),
    };
  });

  /** One stored proposal as the inbox shows it: labels and eligibility resolved, nothing invented. */
  const viewOf = Effect.fn('AccessApprovalsBff.viewOf')(function* viewOfEffect(input: {
    readonly headers: Headers;
    readonly principalId: string;
    readonly record: ApprovalRecord;
    readonly scope: OperationalScope;
    readonly scopeView: ApprovalScopeView;
  }) {
    const { record } = input;
    const entry = yield* authority.capability(record.capabilityKey).pipe(Effect.mapError(portFailure));
    if (Option.isNone(entry)) {
      return yield* Effect.fail(
        accessApprovalsFailureProblem({
          code: 'access_approvals_command_unavailable',
          reason: 'the capability of this proposal is not in the published catalog',
        }),
      );
    }
    const [requester, preview, eligibility] = yield* Effect.all(
      [
        authority.person(record.requester.principalId, input.scope),
        previewOf(input.scope, record),
        eligibilityOf({
          context: proposalContextOf(input.scope, input.scopeView),
          entry: entry.value,
          headers: input.headers,
          principalId: input.principalId,
          record,
          scope: input.scope,
        }),
      ],
      { concurrency: 1 },
    ).pipe(
      Effect.mapError((error) => (Predicate.isTagged(error, 'ApprovalPortUnavailable') ? portFailure(error) : error)),
    );
    const { approval } = record;
    const approverName =
      approval === undefined
        ? Option.none<{ readonly displayName: string }>()
        : yield* authority.person(approval.approverId, input.scope).pipe(Effect.mapError(portFailure));
    // The answer is built in the contract's own encoded form — instants as ISO strings — so the
    // published schema checks it instead of the answer being assumed to fit it.
    const answer = {
      capabilityKey: record.capabilityKey,
      capabilityLabel: entry.value.label,
      command: { ...preview, frozenAt: preview.frozenAt.toISOString() },
      commandDigest: record.commandDigest,
      createdAt: record.createdAt.toISOString(),
      execution: { available: false, reason: 'mandate_runner_unproven' },
      expiresAt: record.expiresAt.toISOString(),
      permitted: eligibility,
      proposalId: record.id,
      requester: withDisplayName(
        {
          kind: Predicate.isTagged(record.requester, 'Agent') ? ('agent' as const) : ('human' as const),
          principalId: record.requester.principalId,
        },
        requester,
      ),
      revision: accessApprovalRevision(record),
      risk: entry.value.declaration.risk,
      scope: input.scopeView,
      status: record.status,
    };
    const approvalRecord =
      approval === undefined
        ? undefined
        : withDisplayName(
            {
              approvalExpiresAt: approval.expiresAt.toISOString(),
              approvedAt: approval.approvedAt.toISOString(),
              principalId: approval.approverId,
            },
            approverName,
          );
    const plain: unknown = withOptional(
      withOptional(answer, 'endedAt', record.endedAt?.toISOString()),
      'approver',
      approvalRecord,
    );
    // The published schema is what turns this answer into the wire form, so the contract is checked.
    return yield* Schema.decodeUnknownEffect(AccessApprovalSchema)(plain).pipe(Effect.mapError(contractFailure));
  });

  const list = Effect.fn('AccessApprovalsBff.list')(function* listApprovals(
    headers: Headers,
    payload: ListAccessApprovalsPayload,
  ) {
    const admitted = yield* admit(headers, accessApprovalsDeclarations.list);
    const { scope } = admitted;
    const parsed = payload.cursor === undefined ? 0 : Math.trunc(Number(payload.cursor));
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return yield* Effect.fail(accessAdminUnprocessableProblem('the cursor of this page is not a known position'));
    }
    const records = yield* commands
      .open(scope, payload.status === undefined ? {} : { status: payload.status })
      .pipe(Effect.mapError(portFailure));
    // The page is cut after the narrowing: a withheld proposal shifts no cursor and names nobody.
    const readable = yield* readableRecords(
      admitted,
      accessApprovalsDeclarations.list,
      records.filter((record) => payload.status === undefined || record.status === payload.status),
    );
    const visible = readable.toSorted(
      (left, right) => right.record.createdAt.getTime() - left.record.createdAt.getTime(),
    );
    const next = parsed + payload.limit;
    const items = yield* Effect.forEach(
      visible.slice(parsed, next),
      (one) => viewOf({ headers, principalId: scope.principalId, record: one.record, scope, scopeView: one.scope }),
      { concurrency: 1 },
    );
    return { items, nextCursor: next < visible.length ? String(next) : null };
  });

  const decide = Effect.fn('AccessApprovalsBff.decide')(function* decideApproval(
    headers: Headers,
    payload: DecideAccessApprovalPayload,
  ) {
    const admitted = yield* admit(headers, accessApprovalsDeclarations.decide);
    const { scope } = admitted;
    // Company authority before any stale check, so a proposal outside it reads like a missing one.
    const { record, scope: scopeView } = yield* readableRecord(
      admitted,
      accessApprovalsDeclarations.decide,
      payload.proposalId,
    );
    const stale = staleProblem(record, payload);
    if (stale !== undefined) {
      return yield* Effect.fail(stale);
    }
    const kind = yield* authority.principalKind(scope.principalId, scope).pipe(Effect.mapError(portFailure));
    if (Option.isSome(kind) && kind.value === 'agent') {
      return yield* Effect.fail(
        accessApprovalsFailureProblem({
          code: 'access_approvals_agent_forbidden',
          reason: 'an agent never decides an access proposal in this release',
        }),
      );
    }
    const ownRequest =
      Predicate.isTagged(record.requester, 'Principal') && record.requester.principalId === scope.principalId;
    if (payload.decision === 'withdraw' && ownRequest) {
      const withdrawn = yield* commands
        .withdraw(scope, { approveAuthority: [], proposalId: record.id })
        .pipe(Effect.mapError(commandFailureProblem));
      return yield* viewOf({ headers, principalId: scope.principalId, record: withdrawn, scope, scopeView });
    }
    const entry = yield* authority.capability(record.capabilityKey).pipe(Effect.mapError(portFailure));
    if (Option.isNone(entry)) {
      return yield* Effect.fail(
        accessApprovalsFailureProblem({
          code: 'access_approvals_command_unavailable',
          reason: 'the capability of this proposal is not in the published catalog',
        }),
      );
    }
    if (payload.decision === 'approve') {
      if (ownRequest) {
        return yield* Effect.fail(
          accessApprovalsFailureProblem({
            code: 'access_approvals_self_approval_forbidden',
            reason: 'a proposal is confirmed by another person, never by its requester',
          }),
        );
      }
      const approved = yield* commands
        .approve(scope, {
          headers,
          proposalId: record.id,
          revision: accessApprovalRevision(record),
        })
        .pipe(Effect.mapError(commandFailureProblem));
      return yield* viewOf({ headers, principalId: scope.principalId, record: approved, scope, scopeView });
    }
    // Without a resolvable amount nobody can prove approve authority, but a scope administrator still
    // rejects or withdraws on their own authority, which Core checks without approval witnesses.
    const proposalContext = proposalContextOf(scope, scopeView);
    const governed = yield* Effect.result(governedAmountOf(scope, record));
    const approveAuthority = Result.isFailure(governed)
      ? []
      : accessApprovalWitnesses(
          yield* askOwnDecision({
            amount: governed.success,
            context: proposalContext,
            declaration: entry.value.declaration,
            mode: 'approve',
            moduleKey: entry.value.moduleKey,
            target: record.target,
          }),
        );
    const settled = yield* payload.decision === 'reject'
      ? commands
          .reject(scope, withOptional({ approveAuthority, proposalId: record.id }, 'reason', payload.reason))
          .pipe(Effect.mapError(commandFailureProblem))
      : commands
          .withdraw(scope, { approveAuthority, proposalId: record.id })
          .pipe(Effect.mapError(commandFailureProblem));
    return yield* viewOf({ headers, principalId: scope.principalId, record: settled, scope, scopeView });
  });

  /**
   * "Schválit a provést mými právy". The BFF names the proposal and never a payload, digest or
   * mandate: the runner resolves the stored command. Until P6 reports the exactly-once proof this
   * refuses with its own 403, so no deployment can enable it by wiring a different flag elsewhere.
   */
  const execute = Effect.fn('AccessApprovalsBff.execute')(function* executeApproval(
    headers: Headers,
    payload: ExecuteAccessApprovalPayload,
  ) {
    const admitted = yield* admit(headers, accessApprovalsDeclarations.execute);
    const { record } = yield* readableRecord(admitted, accessApprovalsDeclarations.execute, payload.proposalId);
    if (record.status !== payload.expectedStatus) {
      return yield* Effect.fail(
        accessAdminConflictProblem('the proposal changed since this page was rendered; reload Ke schválení'),
      );
    }
    return yield* Effect.fail(accessApprovalsExecutionDisabledProblem());
  });

  return Object.freeze({ decide, execute, list });
};

/** "Ke schválení" of this process, over the session, the gate and the two Core ports it is given. */
export const AccessApprovalsBffLive: Layer.Layer<AccessApprovalsBff, never, AccessApprovalsServices> = Layer.effect(
  AccessApprovalsBff,
  Effect.gen(function* accessApprovalsBffLayer() {
    const context = yield* Effect.context<AccessApprovalsServices>();
    return makeAccessApprovalsBff(context);
  }),
);

/** The handler's headers as the web `Headers` a session port reads, from the runtime's own domain type. */
const asHeaders = (input: EffectHeaders): Headers => new Headers(Object.entries(input));

export const accessAdminApprovalsGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'accessAdminApprovals',
  (handlers) =>
    handlers
      .handle('listAccessApprovals', ({ payload, request }) =>
        AccessApprovalsBff.pipe(Effect.flatMap((bff) => bff.list(asHeaders(request.headers), payload))),
      )
      .handle('decideAccessApproval', ({ payload, request }) =>
        AccessApprovalsBff.pipe(Effect.flatMap((bff) => bff.decide(asHeaders(request.headers), payload))),
      )
      .handle('executeAccessApproval', ({ payload, request }) =>
        AccessApprovalsBff.pipe(Effect.flatMap((bff) => bff.execute(asHeaders(request.headers), payload))),
      ),
);
