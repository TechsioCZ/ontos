import { Cause, DateTime, Effect, Exit, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  ActionMandateDispatch,
  ActionProposalParkInput,
  ActionProposalParked,
  MandatePrepared,
  MandateTransactionInput,
} from '../../src/access/approvals/action-mandate-dispatch.ts';
import { freezeActionCommandV2, resolveActionCommandV2 } from '../../src/access/approvals/action-command-v2.ts';
import type { DecisionReasonCode, GrantedAuthorityEvidence } from '../../src/access/decision/contract.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
} from '../../src/access/ids.ts';
import type { DecisionOutcome } from '../../src/access/model.ts';
import { ActionProposalAcceptedSchema } from '../../src/actions/proposal-accepted.ts';
import { ActionTransportMetadataSchema } from '../../src/actions/context.ts';
import type { ActionTransportMetadata } from '../../src/actions/context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionPermissionCheckError, ActionPermissionDenied } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

/** Module-operation admission refuses a non-Core Action with no bound owner registration. */
const shellOwner = makeTestOperationOwner({ moduleId: 'core.shell' }).ownerRegistration;

const mandateId = '00000000-0000-4000-8000-000000000123';
const decodeTransport = Schema.decodeUnknownResult(ActionTransportMetadataSchema);
const actionKey = 'core.shell.fixture.change';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:mandate-fixture',
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
});
const action = defineAction(
  {
    accessDeclaration: {
      key: actionKey,
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'fixtures', level: 'basic' },
      risk: 'sensitive',
      selectors: [],
    },
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${actionKey}.access.v1` },
    actionKey,
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: actionKey,
      moduleKey: 'core.shell',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'core.shell',
    payloadSchema: Schema.Struct({ amount: Schema.Finite }),
    policies: [],
    resultSchema: Schema.Struct({ total: Schema.Finite }),
    schemaVersion: '1',
  },
  (payload) => Effect.succeed({ total: payload.amount }),
  () => Effect.succeed(Object.freeze({})),
);

it.effect('accepts a UUID mandate locator without treating it as a grant', () =>
  Effect.sync(() => {
    const decoded = decodeTransport({ correlationId: 'mandate-transport', mandateId });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.mandateId).toBe(mandateId);
    }
  }),
);

it.effect('refuses malformed or empty mandate locators before Action dispatch', () =>
  Effect.sync(() => {
    for (const malformed of ['', 'a-browser-grant', '00000000-0000-4000-8000-00000000012g', 123]) {
      expect(Result.isFailure(decodeTransport({ correlationId: 'mandate-transport', mandateId: malformed }))).toBe(
        true,
      );
    }
  }),
);

it.effect('refuses a proposal intent combined with a mandate locator at the transport boundary', () =>
  Effect.sync(() => {
    expect(
      Result.isFailure(decodeTransport({ correlationId: 'mandate-transport', intent: 'propose', mandateId })),
    ).toBe(true);
    expect(Result.isSuccess(decodeTransport({ correlationId: 'mandate-transport', intent: 'propose' }))).toBe(true);
  }),
);

it.effect('a mandate locator never grants a direct run when no trusted dispatch adapter is installed', () =>
  Effect.gen(function* cannotGrantFromLocator() {
    const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: shellOwner });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: { correlationId: 'mandate-fixture', idempotencyKey: 'browser-key', mandateId },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.some(
          (reason) => Cause.isFailReason(reason) && Schema.is(ActionPermissionCheckError)(reason.error),
        ),
      ).toBe(true);
    }
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('a grant revoked after the first ALLOWED cannot reach the handler under the transaction fence', () =>
  Effect.gen(function* revokeBetweenDecisions() {
    const allowed = makeScriptedBoundAccessGate('allowed').bound;
    const denied = makeScriptedBoundAccessGate('denied').bound;
    let revoked = false;
    let checks = 0;
    const accessDecision: BoundAccessGate = {
      ...allowed,
      decide: (input) => {
        checks += 1;
        return (revoked ? denied : allowed).decide(input);
      },
    };
    const harness = yield* makeActionTestHarness({
      accessDecision,
      lockAccessExecutionFence: () =>
        Effect.sync(() => {
          revoked = true;
        }),
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: { correlationId: 'revoke-fixture', idempotencyKey: 'revoked-before-handler' },
      }),
    );
    expect(checks).toBe(2);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.some(
          (reason) => Cause.isFailReason(reason) && Schema.is(ActionPermissionDenied)(reason.error),
        ),
      ).toBe(true);
    }
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('a missing access fence fails closed before the owner handler', () =>
  Effect.gen(function* missingFenceRefused() {
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      lockAccessExecutionFence: () =>
        Effect.fail(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The access scope has no Ready fence',
          }),
        ),
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: { correlationId: 'missing-fence-fixture', idempotencyKey: 'missing-fence' },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.some(
          (reason) => Cause.isFailReason(reason) && Schema.is(ActionPermissionCheckError)(reason.error),
        ),
      ).toBe(true);
    }
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('an unreadable in-transaction decision is retryable and never runs the handler', () =>
  Effect.gen(function* unavailableBetweenDecisions() {
    const allowed = makeScriptedBoundAccessGate('allowed').bound;
    const unavailable = makeScriptedBoundAccessGate('unavailable').bound;
    let interrupted = false;
    const accessDecision: BoundAccessGate = {
      ...allowed,
      decide: (input) => (interrupted ? unavailable : allowed).decide(input),
    };
    const harness = yield* makeActionTestHarness({
      accessDecision,
      lockAccessExecutionFence: () =>
        Effect.sync(() => {
          interrupted = true;
        }),
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: { correlationId: 'unavailable-fixture', idempotencyKey: 'unavailable-before-handler' },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.some(
          (reason) => Cause.isFailReason(reason) && Schema.is(ActionPermissionCheckError)(reason.error),
        ),
      ).toBe(true);
    }
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('without a mandate, NEEDS_APPROVAL still refuses before any owner handler', () =>
  Effect.gen(function* mandateIsNotImplicit() {
    const harness = yield* makeActionTestHarness({ access: 'needs_approval', ownerRegistration: shellOwner });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: { correlationId: 'mandate-fixture', idempotencyKey: 'without-mandate' },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.some(
          (reason) => Cause.isFailReason(reason) && Schema.is(ActionPermissionDenied)(reason.error),
        ),
      ).toBe(true);
    }
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

const scopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-0000000000a1');
const parkedProposalId = ProposalIdSchema.make('00000000-0000-4000-8000-0000000000b2');
const parkedExpiresAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-10T12:00:00.000Z'));

/** The propose cell the gate resolved for the requesting person; the proposal binds exactly this. */
const requesterEvidence: GrantedAuthorityEvidence = {
  assignedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T00:00:00.000Z')),
  assignedBy: PrincipalIdSchema.make(principal.principalId),
  mode: 'propose',
  roleId: RoleIdSchema.make('00000000-0000-4000-8000-0000000000c3'),
  roleRevisionId: RoleRevisionIdSchema.make('00000000-0000-4000-8000-0000000000d4'),
  selector: 'all',
  side: 'principal',
  witness: {
    assignmentIncarnationId: AssignmentIncarnationIdSchema.make('00000000-0000-4000-8000-0000000000e5'),
    capabilityKey: CapabilityKeySchema.make(actionKey),
    grantIncarnationId: GrantIncarnationIdSchema.make('00000000-0000-4000-8000-0000000000f6'),
    holderId: { _tag: 'Principal', principalId: PrincipalIdSchema.make(principal.principalId) },
    mode: 'propose',
    purpose: 'requester',
    scopeId,
  },
};

const REASON_FOR = {
  ALLOWED: 'allow.granted',
  DENIED: 'deny.insufficient_grant',
  NEEDS_APPROVAL: 'approval.required',
  UNAVAILABLE: 'unavailable.intent',
} as const satisfies Readonly<Record<DecisionOutcome, DecisionReasonCode>>;

/** The one gate answer this request receives, with the evidence the real engine would return. */
const gateAnswering = (
  outcome: DecisionOutcome,
  evidence: readonly GrantedAuthorityEvidence[] = [],
): BoundAccessGate => ({
  ...makeScriptedBoundAccessGate('needs_approval').bound,
  decide: () => Effect.succeed({ evidence, outcome, reasons: [{ code: REASON_FOR[outcome] }], selectors: [] }),
});

interface DispatchCalls {
  readonly claim: MandateTransactionInput[];
  readonly commit: MandateTransactionInput[];
  readonly parkedLookups: string[];
  readonly parks: ActionProposalParkInput[];
}

interface DispatchOptions {
  readonly claimFailure?: ActionPermissionCheckError;
  readonly commitFailure?: ActionPermissionCheckError;
  /** Set once a park already happened, so a retry must read it instead of parking again. */
  readonly parked?: ActionProposalParked;
  readonly parkFailure?: ActionPermissionCheckError | ActionPermissionDenied;
}

/**
 * A recording approvals adapter. It never touches SQL, so the suite proves the runner's protocol —
 * which transaction it hands over, what it freezes, when it refuses — not the store's own CAS.
 */
const makeRecordingDispatch = (options: DispatchOptions = {}) => {
  const calls: DispatchCalls = { claim: [], commit: [], parkedLookups: [], parks: [] };
  const parked: ActionProposalParked = options.parked ?? { expiresAt: parkedExpiresAt, proposalId: parkedProposalId };
  const dispatch: ActionMandateDispatch = {
    claim: (input) => {
      calls.claim.push(input);
      return options.claimFailure === undefined ? Effect.void : Effect.fail(options.claimFailure);
    },
    commit: (input) => {
      calls.commit.push(input);
      return options.commitFailure === undefined ? Effect.void : Effect.fail(options.commitFailure);
    },
    loadParkedProposal: (input) => {
      calls.parkedLookups.push(input.actionInvocationId);
      return Effect.succeed(
        options.parked === undefined && calls.parks.length === 0 ? Option.none() : Option.some(parked),
      );
    },
    parkProposal: (input) => {
      calls.parks.push(input);
      return options.parkFailure === undefined ? Effect.succeed(parked) : Effect.fail(options.parkFailure);
    },
    prepare: (input) =>
      resolveActionCommandV2({ payload: { amount: 1 }, registration: action, scope: input.scope }).pipe(
        Effect.map(
          (command) =>
            ({
              approverId: input.scope.principalId,
              command: { capabilityKey: CapabilityKeySchema.make(input.capabilityKey), payload: command },
              commandDigest: Result.getOrThrow(freezeActionCommandV2(command)),
              mandateId: input.mandateId,
              proposalId: parkedProposalId,
              scopeId,
            }) satisfies MandatePrepared,
        ),
      ),
  };
  return { calls, dispatch };
};

/** The typed failure code a runner call settled on, or `undefined` when it succeeded. */
const failureCodeOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
  return Schema.is(Schema.Struct({ code: Schema.String }))(failure) ? failure.code : undefined;
};

/**
 * The one canonical runner with the fixture's 202 success contract declared (O85): a parked proposal is
 * only answerable where the transport's contract carries it, so the declaration is part of the call.
 */
const proposePayload = { amount: 1 };
const proposeRequest = (transport: ActionTransportMetadata, payload: { readonly amount: number } = proposePayload) => ({
  payload,
  principal,
  registration: action,
  successContract: 'result-or-proposal' as const,
  transport,
});

const proposalAction = defineAction(
  {
    accessDeclaration: {
      key: actionKey,
      kind: 'action',
      modes: ['run'],
      placement: { group: 'fixtures', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${actionKey}.access.v1` },
    actionKey,
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: actionKey,
      moduleKey: 'core.shell',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'core.shell',
    payloadSchema: Schema.Struct({ amount: Schema.Finite }),
    policies: [],
    resultSchema: Schema.Struct({ total: Schema.Finite }),
    schemaVersion: '1',
  },
  (payload) => Effect.succeed({ total: payload.amount }),
  () => Effect.succeed(Object.freeze({})),
);

const withoutApprovalMode = (kind: 'action' | 'admin') =>
  defineAction(
    {
      ...action.descriptor,
      accessDeclaration: {
        key: actionKey,
        kind,
        modes: kind === 'admin' ? ['run'] : ['run', 'propose'],
        placement: { group: 'fixtures', level: 'basic' },
        risk: kind === 'admin' ? 'critical' : 'sensitive',
        selectors: [],
      },
    },
    (payload) => Effect.succeed({ total: payload.amount }),
    () => Effect.succeed(Object.freeze({})),
  );

for (const [label, registration] of [
  ['run-only', proposalAction],
  ['identity-bound', withoutApprovalMode('action')],
  ['run-only admin', withoutApprovalMode('admin')],
] as const) {
  it.effect(`refuses a mandate for a ${label} declaration before consulting the dispatch adapter`, () =>
    Effect.gen(function* mandateCannotWidenDeclaredModes() {
      const { calls, dispatch } = makeRecordingDispatch();
      let preparations = 0;
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        mandateDispatch: {
          ...dispatch,
          prepare: (input) => {
            preparations += 1;
            return dispatch.prepare(input);
          },
        },
        ownerRegistration: shellOwner,
      });
      const exit = yield* Effect.exit(
        harness.runtime.runAction({
          payload: null,
          principal,
          registration,
          transport: { correlationId: 'unsupported-mandate', mandateId },
        }),
      );
      expect(failureCodeOf(exit)).toBe('action_permission_denied');
      expect(preparations).toBe(0);
      expect(calls.claim).toEqual([]);
      expect(calls.commit).toEqual([]);
      expect(harness.snapshot().committed).toEqual([]);
      expect(harness.snapshot().stages).not.toContain('handler_executed');
    }),
  );
}

it.effect('parks an explicitly proposed command as a 202 and never runs the owner handler (O80, O85)', () =>
  Effect.gen(function* parksProposal() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const accepted = yield* harness.runtime.runAction(
      proposeRequest({ correlationId: 'propose-fixture', idempotencyKey: 'propose-key', intent: 'propose' }),
    );
    expect(Schema.is(ActionProposalAcceptedSchema)(accepted)).toBe(true);
    if (Schema.is(ActionProposalAcceptedSchema)(accepted)) {
      expect(accepted.proposalId).toBe(parkedProposalId);
      expect(DateTime.toEpochMillis(accepted.expiresAt)).toBe(parkedExpiresAt.getTime());
    }
    expect(calls.parks).toHaveLength(1);
    const [park] = calls.parks;
    expect(park?.payload).toEqual({ amount: 1 });
    expect(park?.capabilityKey).toBe(actionKey);
    expect(park?.decision.outcome).toBe('NEEDS_APPROVAL');
    expect(park?.decision.evidence).toEqual([requesterEvidence]);
    expect(park?.transaction).toBeDefined();
    expect(calls.claim).toEqual([]);
    expect(calls.commit).toEqual([]);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
    expect(harness.snapshot().stages).not.toContain('invocation_running');
  }),
);

it.effect('refuses a propose intent on a transport whose success contract carries no 202 (O85)', () =>
  Effect.gen(function* narrowRunnerRefusesProposal() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: { correlationId: 'narrow-propose', idempotencyKey: 'narrow-propose', intent: 'propose' },
      }),
    );
    expect(failureCodeOf(exit)).toBe('action_permission_denied');
    expect(calls.parks).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('answers a retried propose request with the stored receipt and parks nothing new (O90)', () =>
  Effect.gen(function* retriedProposal() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const request = proposeRequest({
      correlationId: 'propose-retry',
      idempotencyKey: 'propose-retry-key',
      intent: 'propose',
    });
    const first = yield* harness.runtime.runAction(request);
    const second = yield* harness.runtime.runAction(request);
    expect(Schema.is(ActionProposalAcceptedSchema)(first) && Schema.is(ActionProposalAcceptedSchema)(second)).toBe(
      true,
    );
    if (Schema.is(ActionProposalAcceptedSchema)(first) && Schema.is(ActionProposalAcceptedSchema)(second)) {
      expect(second.proposalId).toBe(first.proposalId);
      expect(DateTime.toEpochMillis(second.expiresAt)).toBe(DateTime.toEpochMillis(first.expiresAt));
    }
    expect(calls.parks).toHaveLength(1);
    expect(calls.parkedLookups.length).toBeGreaterThanOrEqual(2);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('refuses changed payload on a retried proposal key before replaying its receipt (O90)', () =>
  Effect.gen(function* changedProposalRetry() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const request = proposeRequest({
      correlationId: 'changed-propose',
      idempotencyKey: 'changed-propose-key',
      intent: 'propose',
    });
    yield* harness.runtime.runAction(request);
    const replay = yield* Effect.exit(harness.runtime.runAction({ ...request, payload: { amount: 2 } }));
    expect(failureCodeOf(replay)).toBe('action_request_hash_conflict');
    expect(calls.parks).toHaveLength(1);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('refuses a proposal intent the gate already allows and parks nothing (O80)', () =>
  Effect.gen(function* proposalNotRequired() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('ALLOWED'),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction(
        proposeRequest({
          correlationId: 'propose-allowed',
          idempotencyKey: 'propose-allowed',
          intent: 'propose',
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureCodeOf(exit)).toBe('action_permission_denied');
    expect(calls.parks).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('refuses a proposal intent for a declaration without the propose mode', () =>
  Effect.gen(function* proposalUnsupported() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: proposalAction,
        successContract: 'result-or-proposal' as const,
        transport: { correlationId: 'propose-unsupported', idempotencyKey: 'propose-unsupported', intent: 'propose' },
      }),
    );
    expect(failureCodeOf(exit)).toBe('action_approval_required');
    expect(calls.parks).toEqual([]);
  }),
);

it.effect('answers an unavailable gate during a proposal with a retryable 503 and parks nothing (O48)', () =>
  Effect.gen(function* proposalUnavailable() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('UNAVAILABLE'),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction(
        proposeRequest({
          correlationId: 'propose-unavailable',
          idempotencyKey: 'propose-unavailable',
          intent: 'propose',
        }),
      ),
    );
    expect(failureCodeOf(exit)).toBe('action_permission_check_failed');
    expect(calls.parks).toEqual([]);
    expect(harness.snapshot().permissionDenials).toEqual([]);
  }),
);

it.effect('keeps the proposal path closed when no transaction-joining adapter is installed', () =>
  Effect.gen(function* proposalFailsClosed() {
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction(
        proposeRequest({
          correlationId: 'propose-no-adapter',
          idempotencyKey: 'propose-no-adapter',
          intent: 'propose',
        }),
      ),
    );
    expect(failureCodeOf(exit)).toBe('action_permission_check_failed');
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('rolls the whole proposal back when the park fails, so the same key may retry (O90)', () =>
  Effect.gen(function* proposalRollback() {
    const failing = makeRecordingDispatch({
      parkFailure: new ActionPermissionCheckError({
        code: 'action_permission_check_failed',
        reason: 'The approvals store is unavailable',
      }),
    });
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
      mandateDispatch: failing.dispatch,
      ownerRegistration: shellOwner,
    });
    const request = proposeRequest({
      correlationId: 'propose-rollback',
      idempotencyKey: 'propose-rollback',
      intent: 'propose',
    });
    const exit = yield* Effect.exit(harness.runtime.runAction(request));
    expect(failureCodeOf(exit)).toBe('action_permission_check_failed');
    expect(failing.calls.parks).toHaveLength(1);
    expect(harness.snapshot().committed).toEqual([]);

    const retry = makeRecordingDispatch();
    const retried = yield* makeActionTestHarness({
      accessDecision: gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
      mandateDispatch: retry.dispatch,
      ownerRegistration: shellOwner,
    });
    const accepted = yield* retried.runtime.runAction(request);
    expect(Schema.is(ActionProposalAcceptedSchema)(accepted)).toBe(true);
    expect(retry.calls.parks).toHaveLength(1);
  }),
);

it.effect('claims the mandate and commits its receipt inside the owner transaction (O75)', () =>
  Effect.gen(function* mandateTransaction() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('ALLOWED'),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const result = yield* harness.runtime.runAction({
      payload: null,
      principal,
      registration: action,
      transport: { correlationId: 'mandate-transaction', mandateId },
    });
    expect(result).toEqual({ total: 1 });
    expect(calls.claim).toHaveLength(1);
    expect(calls.commit).toHaveLength(1);
    expect(calls.claim[0]?.transaction).toBe(calls.commit[0]?.transaction);
    expect(calls.claim[0]?.actionInvocationId).toBe(calls.commit[0]?.actionInvocationId);
    expect(harness.snapshot().stages).toContain('handler_executed');
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('rolls a claimed mandate back when the owner write is refused, so it stays retryable (O75)', () =>
  Effect.gen(function* mandateRollback() {
    const { calls, dispatch } = makeRecordingDispatch();
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('ALLOWED'),
      mandateDispatch: dispatch,
      onOwnerAuthorization: () => 'denied',
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: null,
        principal,
        registration: action,
        transport: { correlationId: 'mandate-rollback', mandateId },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // The CAS runs before the owner write and is not durable without it: the receipt rolls back too.
    expect(calls.claim).toHaveLength(1);
    expect(calls.commit).toEqual([]);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('never commits a mandate receipt whose claim was refused inside the transaction', () =>
  Effect.gen(function* mandateClaimRefused() {
    const { calls, dispatch } = makeRecordingDispatch({
      claimFailure: new ActionPermissionCheckError({
        code: 'action_permission_check_failed',
        reason: 'The mandate could not be consumed safely',
      }),
    });
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('ALLOWED'),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: null,
        principal,
        registration: action,
        transport: { correlationId: 'mandate-claim-refused', mandateId },
      }),
    );
    expect(failureCodeOf(exit)).toBe('action_permission_check_failed');
    expect(calls.commit).toEqual([]);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }),
);

it.effect('rolls the owner write back when the mandate receipt cannot be confirmed (O75)', () =>
  Effect.gen(function* mandateCommitFailed() {
    const { calls, dispatch } = makeRecordingDispatch({
      commitFailure: new ActionPermissionCheckError({
        code: 'action_permission_check_failed',
        reason: 'The mandate receipt could not be confirmed',
      }),
    });
    const harness = yield* makeActionTestHarness({
      accessDecision: gateAnswering('ALLOWED'),
      mandateDispatch: dispatch,
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: null,
        principal,
        registration: action,
        transport: { correlationId: 'mandate-commit-failed', mandateId },
      }),
    );
    expect(failureCodeOf(exit)).toBe('action_permission_check_failed');
    expect(calls.commit).toHaveLength(1);
    expect(harness.snapshot().stages).toContain('handler_executed');
    expect(harness.snapshot().committed).toEqual([]);
  }),
);
