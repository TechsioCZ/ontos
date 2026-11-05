import type { OperationalScope } from '@app/core-runtime';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { AccessAmount, GateInput, TestAccessDecisionSpec } from '@app/core-runtime/access/enforcement';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CurrencyCodeSchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
} from '@app/core-runtime/access/ids';
import { Context, DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  AccessAdminProblem,
  DecideAccessApprovalPayload,
  ExecuteAccessApprovalPayload,
  ListAccessApprovalsPayload,
} from '../../shared/access-admin-api.ts';
import { AccessProposalIdSchema } from '../../shared/access-admin-api.ts';
import type { AccessApprovalsAuthority } from '../../api/access-admin/approvals-authority.ts';
import type { AccessApprovalsCommandsService } from '../../api/access-admin/approvals-commands.ts';
import type { ApprovalCommandPreview, ApprovalRecord } from '../../api/access-admin/approvals-contract.ts';
import {
  accessApprovalRevision,
  accessApprovalWitnesses,
  accessApprovalsDeclarations,
  makeAccessApprovalsBff,
} from '../../api/access-admin/approvals.ts';
import { AccessApprovalsAuthoritySource } from '../../api/access-admin/approvals-authority.ts';
import { ApprovalPortUnavailableSchema } from '../../api/access-admin/approvals-contract.ts';
import { AccessApprovalsCommands } from '../../api/access-admin/approvals-commands.ts';
import { AccessAdminSession, accessAdminAuthenticationRequiredProblem } from '../../api/access-admin/session.ts';
import type { AccessAdminSessionService } from '../../api/access-admin/session.ts';

/*
 * "Ke schválení", unit level: the BFF's own decisions. Which capability each operation is decided by,
 * what a caller may send, which authority a decision carries, and which refusal becomes which status.
 * Core owns the proposal lifecycle, the mandate rules and the frozen command; here that seam is a
 * scripted port, so a failure of the BFF's own wiring cannot hide behind Core's.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const SCOPE_ID = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const BYSTANDER = '55555555-5555-4555-8555-555555555555';
const AUTH_BINDING = '66666666-6666-4666-8666-666666666666';
const PROPOSAL = '77777777-7777-4777-8777-777777777777';
const CAPABILITY = 'finance.invoice.void';
const DIGEST = 'a'.repeat(64);
const RECORD = 'invoice-118';
const APPROVAL_ASSIGNMENT = '88888888-8888-4888-8888-888888888888';
const APPROVAL_GRANT = '99999999-9999-4999-8999-999999999999';

const brand = <Value>(schema: Schema.Codec<Value, string>, value: string): Value => Schema.decodeSync(schema)(value);

const scopeFor = (principalId: string): OperationalScope => ({
  authBindingId: AUTH_BINDING,
  authContextRef: 'better-auth-session:unit-test',
  authMethod: 'session',
  correlationId: 'unit-test-correlation',
  principalId,
  tenantId: TENANT,
});

const record = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  capabilityKey: CAPABILITY,
  commandDigest: DIGEST,
  createdAt: new Date('2026-11-03T09:00:00.000Z'),
  expiresAt: new Date('2026-11-10T09:00:00.000Z'),
  id: PROPOSAL,
  requester: { _tag: 'Principal', principalId: brand(PrincipalIdSchema, REQUESTER) },
  scopeId: SCOPE_ID,
  status: 'pending',
  tenantId: TENANT,
  ...overrides,
});

const preview = (): ApprovalCommandPreview => ({
  actionKey: 'finance.invoice.void',
  capabilityKey: CAPABILITY,
  digestShort: DIGEST.slice(0, 12),
  fields: [{ label: 'Částka', value: '1 250,00 Kč' }],
  frozenAt: new Date('2026-11-03T09:00:00.000Z'),
  redactedFieldCount: 1,
  target: { recordKey: RECORD },
});

/** One bound witness of the approving person, the shape Core binds to a mandate (O49, O63). */
const witness = (side: 'agent' | 'principal' = 'principal') => ({
  assignedAt: new Date('2026-10-01T09:00:00.000Z'),
  assignedBy: brand(PrincipalIdSchema, APPROVER),
  mode: 'approve' as const,
  roleId: brand(RoleIdSchema, APPROVER),
  roleRevisionId: brand(RoleRevisionIdSchema, APPROVER),
  selector: 'all' as const,
  side,
  witness: {
    assignmentIncarnationId: brand(AssignmentIncarnationIdSchema, APPROVAL_ASSIGNMENT),
    capabilityKey: brand(CapabilityKeySchema, CAPABILITY),
    grantIncarnationId: brand(GrantIncarnationIdSchema, APPROVAL_GRANT),
    holderId: { _tag: 'Principal' as const, principalId: brand(PrincipalIdSchema, APPROVER) },
    mode: 'approve' as const,
    purpose: 'approval' as const,
    scopeId: brand(AccessScopeIdSchema, SCOPE_ID),
  },
});

const ALLOWING: TestAccessDecisionSpec = {
  defaultAnswer: { evidence: [witness()], outcome: 'ALLOWED' },
};

/** A gate that answers every declaration with one scripted outcome and this person's evidence. */
const gate = (spec?: TestAccessDecisionSpec) => makeTestAccessDecision(spec ?? ALLOWING);

const authority = (overrides: Partial<AccessApprovalsAuthority> = {}): AccessApprovalsAuthority => ({
  capability: () =>
    Effect.succeed(
      Option.some({
        declaration: {
          key: brand(Schema.String.pipe(Schema.brand('AccessKey')), CAPABILITY),
          kind: 'action' as const,
          modes: ['run', 'propose', 'approve'] as const,
          placement: { group: 'finance', level: 'extended' as const },
          risk: 'sensitive' as const,
          selectors: ['all'] as const,
        },
        label: 'Stornovat fakturu',
        moduleKey: 'finance',
      }),
    ),
  isAdministrator: () => Effect.succeed(false),
  person: () => Effect.succeed(Option.some({ displayName: 'Petr Glaser' })),
  principalKind: () => Effect.succeed(Option.some('human' as const)),
  scope: () => Effect.succeed(Option.some({ accessScopeId: SCOPE_ID, kind: 'tenant' as const })),
  ...overrides,
});

const scriptedCommands = (
  options: {
    readonly amount?: AccessAmount;
    readonly loaded?: ApprovalRecord;
    readonly open?: readonly ApprovalRecord[];
    readonly preview?: ApprovalCommandPreview | null;
  } = {},
) => {
  const rejected = record({ endedAt: new Date('2026-11-03T10:00:00.000Z'), status: 'rejected' });
  const approved = record({ status: 'approved' });
  const service: AccessApprovalsCommandsService = {
    approve: () => Effect.succeed(approved),
    governedAmount: () => Effect.succeed(Option.fromUndefinedOr(options.amount)),
    load: (_scope: OperationalScope, proposalId: string) =>
      Effect.succeed(proposalId === PROPOSAL ? Option.some(options.loaded ?? record()) : Option.none()),
    open: () => Effect.succeed(options.open ?? [record()]),
    preview: () => Effect.succeed(options.preview === null ? Option.none() : Option.some(options.preview ?? preview())),
    reject: () => Effect.succeed(rejected),
    withdraw: () => Effect.succeed(rejected),
  };
  return service;
};

const sessionOf = (scope: OperationalScope = scopeFor(APPROVER)): AccessAdminSessionService => ({
  requireTenantContext: () => Effect.succeed(scope),
});

const bffOf = (
  options: {
    readonly authority?: AccessApprovalsAuthority;
    readonly commands?: AccessApprovalsCommandsService;
    readonly gate?: ReturnType<typeof gate>;
    readonly session?: AccessAdminSessionService;
  } = {},
) =>
  makeAccessApprovalsBff(
    Context.make(AccessApprovalsCommands, options.commands ?? scriptedCommands()).pipe(
      Context.add(AccessApprovalsAuthoritySource, options.authority ?? authority()),
      Context.add(AccessDecisionGate, options.gate ?? gate()),
      Context.add(AccessAdminSession, options.session ?? sessionOf()),
    ),
  );

const headers = (): Headers => new Headers();

const listPayload = (overrides: Partial<ListAccessApprovalsPayload> = {}): ListAccessApprovalsPayload => ({
  limit: 20,
  ...overrides,
});

const decidePayload = (overrides: Partial<DecideAccessApprovalPayload> = {}): DecideAccessApprovalPayload => ({
  decision: 'approve',
  expectedStatus: 'pending',
  proposalId: brand(AccessProposalIdSchema, PROPOSAL),
  ...overrides,
});

const executePayload = (): ExecuteAccessApprovalPayload => ({
  expectedStatus: 'approved',
  proposalId: brand(AccessProposalIdSchema, PROPOSAL),
});

/** The problem an effect refused with; a test asserts on it instead of on a thrown value. */
const problemOf = (effect: Effect.Effect<unknown, AccessAdminProblem>) => Effect.flip(effect);

/* ------------------------------------------------------------------------------------------------
 * The gate: one declared capability per operation, always in tenant context (O28).
 * ---------------------------------------------------------------------------------------------- */

it.effect('decides every approvals operation by its own declared capability in tenant context', () =>
  Effect.gen(function* decidesByOwnCapability() {
    const answering = gate();
    const bff = bffOf({ gate: answering });
    yield* bff.list(headers(), listPayload());
    yield* bff.execute(headers(), executePayload()).pipe(Effect.flip);
    const askedKeys = answering.askedDecisions.map((ask) => ask.carrier.accessDeclaration?.key);
    expect(askedKeys).toContain(accessApprovalsDeclarations.list.key);
    expect(askedKeys).toContain(accessApprovalsDeclarations.execute.key);
    const [listAsk] = answering.askedDecisions;
    // A management title is not a company grant: administration is decided in tenant context (O28).
    expect(listAsk?.legalEntityScope).toBe('optional');
    expect(listAsk?.scope.tenantId).toBe(TENANT);
    expect(listAsk?.scope.legalEntityId).toBeUndefined();
  }),
);

it.effect('refuses a denied inbox with 403 and reads no proposal at all', () =>
  Effect.gen(function* deniesInbox() {
    const bff = bffOf({ gate: gate({ defaultAnswer: { outcome: 'DENIED' } }) });
    const problem = yield* problemOf(bff.list(headers(), listPayload()));
    expect(problem.status).toBe(403);
  }),
);

it.effect('answers an unavailable gate with the retryable 503, never a denial', () =>
  Effect.gen(function* keepsUnavailable() {
    const bff = bffOf({ gate: makeTestAccessDecision({ unavailable: true }) });
    const problem = yield* problemOf(bff.list(headers(), listPayload()));
    expect(problem.status).toBe(503);
  }),
);

it.effect('refuses an unauthenticated request before it asks the gate anything', () =>
  Effect.gen(function* refusesAnonymous() {
    const answering = gate();
    const bff = bffOf({
      gate: answering,
      session: { requireTenantContext: () => Effect.fail(accessAdminAuthenticationRequiredProblem()) },
    });
    const problem = yield* problemOf(bff.list(headers(), listPayload()));
    expect(problem.status).toBe(401);
    expect(answering.askedDecisions).toHaveLength(0);
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Eligibility: resolved facts about this caller, not flags they send (O61, O64).
 * ---------------------------------------------------------------------------------------------- */

it.effect('lets an eligible approver decide and tells the requester they withdraw instead', () =>
  Effect.gen(function* resolvesEligibility() {
    const inbox = yield* bffOf().list(headers(), listPayload());
    expect(inbox.items).toHaveLength(1);
    const [item] = inbox.items;
    expect(item?.permitted.approval.allowed).toBe(true);
    expect(item?.permitted.rejection.allowed).toBe(true);
    // Execution is a separate step and is not enabled in this wave (P6 proof pending).
    expect(item?.execution.available).toBe(false);

    const own = yield* bffOf({ session: sessionOf(scopeFor(REQUESTER)) }).list(headers(), listPayload());
    const [ownItem] = own.items;
    expect(ownItem?.permitted.approval).toEqual({ allowed: false, reason: 'requester_cannot_approve' });
    expect(ownItem?.permitted.rejection.allowed).toBe(false);
    expect(ownItem?.permitted.withdrawal.allowed).toBe(true);
  }),
);

it.effect('refuses to approve without approve authority and never calls Core', () =>
  Effect.gen(function* refusesMissingAuthority() {
    let approvals = 0;
    const service = scriptedCommands();
    const bff = bffOf({
      commands: {
        ...service,
        approve: () => {
          approvals += 1;
          return Effect.succeed(record({ status: 'approved' }));
        },
      },
      gate: gate({
        answers: { [accessApprovalsDeclarations.decide.key]: { outcome: 'ALLOWED' } },
        defaultAnswer: { outcome: 'DENIED' },
      }),
    });
    const problem = yield* problemOf(bff.decide(headers(), decidePayload()));
    expect(problem.status).toBe(403);
    expect(problem.detail).toContain('access_approvals_approval_authority_missing');
    expect(approvals).toBe(0);
  }),
);

it.effect('refuses self-approval of a command before asking for approval authority', () =>
  Effect.gen(function* refusesSelfApproval() {
    let approvals = 0;
    const service = scriptedCommands();
    const bff = bffOf({
      commands: {
        ...service,
        approve: () => {
          approvals += 1;
          return Effect.succeed(record({ status: 'approved' }));
        },
      },
      session: sessionOf(scopeFor(REQUESTER)),
    });
    const problem = yield* problemOf(bff.decide(headers(), decidePayload()));
    expect(problem.status).toBe(403);
    expect(problem.detail).toContain('access_approvals_self_approval_forbidden');
    expect(approvals).toBe(0);
  }),
);

it.effect('refuses an agent actor outright: an agent never decides an access proposal (O67-Q5)', () =>
  Effect.gen(function* refusesAgent() {
    const bff = bffOf({
      authority: authority({ principalKind: () => Effect.succeed(Option.some('agent' as const)) }),
    });
    const problem = yield* problemOf(bff.decide(headers(), decidePayload()));
    expect(problem.status).toBe(403);
    expect(problem.detail).toContain('access_approvals_agent_forbidden');
  }),
);

/* ------------------------------------------------------------------------------------------------
 * The approval itself: only this person's own authority travels, and never an agent's cell.
 * ---------------------------------------------------------------------------------------------- */

it.effect('carries exactly the acting person’s own-side witness into the approval', () =>
  Effect.gen(function* carriesOwnWitness() {
    const carried: Parameters<AccessApprovalsCommandsService['approve']>[1][] = [];
    const service = scriptedCommands();
    const bff = bffOf({
      commands: {
        ...service,
        approve: (_scope, input) => {
          carried.push(input);
          return Effect.succeed(record({ status: 'approved' }));
        },
      },
      gate: gate({ defaultAnswer: { evidence: [witness('principal'), witness('agent')], outcome: 'ALLOWED' } }),
    });
    const approved = yield* bff.decide(headers(), decidePayload());
    expect(approved.status).toBe('approved');
    const [call] = carried;
    expect(call?.approval.holderId).toBeDefined();
    expect(call?.approval.assignmentIncarnationId).toBe(APPROVAL_ASSIGNMENT);
    expect(call?.revision).toBe(accessApprovalRevision(record()));
    // The approval the person gives is theirs alone: an agent's cell never becomes a witness (O63).
    expect(Predicate.isTagged(call?.approval.holderId, 'Principal')).toBe(true);
  }),
);

it.effect('keeps an agent-side witness out of the derived authority', () =>
  Effect.gen(function* keepsAgentCellOut() {
    const answering = gate({
      defaultAnswer: { evidence: [witness('agent'), witness('principal')], outcome: 'ALLOWED' },
    });
    const decision = yield* answering.decide({
      carrier: { accessDeclaration: accessApprovalsDeclarations.list },
      legalEntityScope: 'optional',
      now: yield* DateTime.nowAsDate,
      scope: scopeFor(APPROVER),
    });
    const witnesses = accessApprovalWitnesses(decision);
    expect(witnesses).toHaveLength(1);
    expect(Predicate.isTagged(witnesses[0]?.holderId, 'Principal')).toBe(true);
  }),
);

/* ------------------------------------------------------------------------------------------------
 * A capped grant: the approve and run questions carry the frozen command's governed amount (O18).
 * ---------------------------------------------------------------------------------------------- */

/** The approver's approve and run grants of the proposal's capability, capped at 1 000,00 Kč. */
const CEILING_MINOR = 100_000;
const czk = (minor: number): AccessAmount => ({ currency: brand(CurrencyCodeSchema, 'CZK'), minor });

/** Whether a capped grant refuses this question: the proposal's capability without an amount or above it. */
const capped = (input: GateInput) =>
  input.carrier.accessDeclaration?.key === CAPABILITY &&
  (input.amount === undefined || input.amount.minor > CEILING_MINOR);

/**
 * A gate that answers the proposal's own capability as the engine answers a capped grant: a question
 * without an amount, or above the ceiling, is refused; everything else is answered as `ALLOWING`.
 */
const cappedGate = () => {
  const allowing = gate();
  const refusing = gate({ defaultAnswer: { outcome: 'DENIED', reasons: ['deny.amount_required'] } });
  return {
    ...allowing,
    decide: (input: GateInput) => (capped(input) ? refusing.decide(input) : allowing.decide(input)),
  };
};

it.effect('lets a capped approver approve a command below the ceiling, asked at the frozen amount', () =>
  Effect.gen(function* approvesBelowCeiling() {
    const answering = cappedGate();
    const bff = bffOf({ commands: scriptedCommands({ amount: czk(50_000) }), gate: answering });
    const inbox = yield* bff.list(headers(), listPayload());
    expect(inbox.items[0]?.permitted.approval).toEqual({ allowed: true });

    const approved = yield* bff.decide(headers(), decidePayload());
    expect(approved.status).toBe('approved');
    // Both of the approver's own questions name the amount the mandate will run with.
    const ownQuestions = answering.askedDecisions.filter((ask) => ask.carrier.accessDeclaration?.key === CAPABILITY);
    expect(ownQuestions.map((ask) => [ask.mode, ask.amount])).toEqual([
      ['approve', czk(50_000)],
      ['approve', czk(50_000)],
      ['run', czk(50_000)],
    ]);
  }),
);

it.effect('refuses a capped approver a command above the ceiling, in the inbox and on approve', () =>
  Effect.gen(function* refusesAboveCeiling() {
    let approvals = 0;
    const service = scriptedCommands({ amount: czk(150_000) });
    const bff = bffOf({
      commands: {
        ...service,
        approve: () => {
          approvals += 1;
          return Effect.succeed(record({ status: 'approved' }));
        },
      },
      gate: cappedGate(),
    });
    const inbox = yield* bff.list(headers(), listPayload());
    expect(inbox.items[0]?.permitted.approval).toEqual({ allowed: false, reason: 'approve_authority_missing' });

    const problem = yield* problemOf(bff.decide(headers(), decidePayload()));
    expect(problem.status).toBe(403);
    expect(problem.detail).toContain('access_approvals_approval_authority_missing');
    expect(approvals).toBe(0);
  }),
);

it.effect('lists a proposal whose amount cannot be resolved as not approvable, never failing the inbox', () =>
  Effect.gen(function* unreadableAmountKeepsTheInbox() {
    const service = scriptedCommands({ amount: czk(50_000) });
    const bff = bffOf({
      commands: {
        ...service,
        governedAmount: () =>
          Effect.fail(ApprovalPortUnavailableSchema.make({ reason: 'the owner amount rule is not loaded' })),
      },
      gate: cappedGate(),
    });
    const inbox = yield* bff.list(headers(), listPayload());
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.permitted.approval).toEqual({ allowed: false, reason: 'approval_amount_unavailable' });
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Staleness, rejection, withdrawal and execution.
 * ---------------------------------------------------------------------------------------------- */

it.effect('refuses a proposal that moved on with 409 and calls nothing', () =>
  Effect.gen(function* refusesStale() {
    const bff = bffOf();
    const problem = yield* problemOf(bff.decide(headers(), decidePayload({ expectedStatus: 'approved' })));
    expect(problem.status).toBe(409);
  }),
);

it.effect('lets a scope administrator reject without holding approve authority', () =>
  Effect.gen(function* rejectsAsAdministrator() {
    const rejections: Parameters<AccessApprovalsCommandsService['reject']>[1][] = [];
    const service = scriptedCommands();
    const bff = bffOf({
      authority: authority({ isAdministrator: () => Effect.succeed(true) }),
      commands: {
        ...service,
        reject: (_scope, input) => {
          rejections.push(input);
          return Effect.succeed(record({ status: 'rejected' }));
        },
      },
      gate: gate({
        answers: { [accessApprovalsDeclarations.decide.key]: { outcome: 'ALLOWED' } },
        defaultAnswer: { outcome: 'DENIED' },
      }),
      session: sessionOf(scopeFor(BYSTANDER)),
    });
    const rejected = yield* bff.decide(headers(), decidePayload({ decision: 'reject' }));
    expect(rejected.status).toBe('rejected');
    // A rejection needs no capability of its own (O35/O61): Core judges the administrator fact.
    expect(rejections[0]?.approveAuthority).toHaveLength(0);
  }),
);

it.effect('never offers approval of a proposal that changes one record, which no release can approve yet', () =>
  Effect.gen(function* recordProposalIsNotApprovable() {
    const targeted = record({ target: RECORD });
    const service = scriptedCommands({ loaded: targeted, open: [targeted] });
    const bff = bffOf({ commands: service, gate: cappedGate() });
    // The inbox says why instead of offering a button Core always refuses (D30) ...
    const inbox = yield* bff.list(headers(), listPayload());
    expect(inbox.items[0]?.permitted.approval).toEqual({ allowed: false, reason: 'approval_record_read_unpublished' });
    // ... and approving it anyway is refused before Core is asked.
    const problem = yield* problemOf(bff.decide(headers(), decidePayload({ decision: 'approve' })));
    expect(problem.status).toBe(422);
  }),
);

it.effect('lets a scope administrator reject a proposal whose amount cannot be resolved', () =>
  Effect.gen(function* rejectsWithoutAmount() {
    const rejections: Parameters<AccessApprovalsCommandsService['reject']>[1][] = [];
    const service = scriptedCommands({ amount: czk(50_000) });
    const bff = bffOf({
      authority: authority({ isAdministrator: () => Effect.succeed(true) }),
      commands: {
        ...service,
        governedAmount: () =>
          Effect.fail(ApprovalPortUnavailableSchema.make({ reason: 'the owner amount rule is not loaded' })),
        reject: (_scope, input) => {
          rejections.push(input);
          return Effect.succeed(record({ status: 'rejected' }));
        },
      },
      gate: gate({
        answers: { [accessApprovalsDeclarations.decide.key]: { outcome: 'ALLOWED' } },
        defaultAnswer: { outcome: 'DENIED' },
      }),
      session: sessionOf(scopeFor(BYSTANDER)),
    });
    // The inbox offers the rejection, and the rejection goes through on administrator authority alone.
    const rejected = yield* bff.decide(headers(), decidePayload({ decision: 'reject' }));
    expect(rejected.status).toBe('rejected');
    expect(rejections[0]?.approveAuthority).toHaveLength(0);
    // Approving still needs the amount, so it refuses instead of guessing one.
    const problem = yield* problemOf(bff.decide(headers(), decidePayload({ decision: 'approve' })));
    expect(problem.status).toBe(503);
  }),
);

it.effect('lets the requester withdraw their own proposal with no extra authority', () =>
  Effect.gen(function* withdrawsOwn() {
    const withdrawals: Parameters<AccessApprovalsCommandsService['withdraw']>[1][] = [];
    const service = scriptedCommands();
    const bff = bffOf({
      commands: {
        ...service,
        withdraw: (_scope, input) => {
          withdrawals.push(input);
          return Effect.succeed(record({ status: 'rejected' }));
        },
      },
      session: sessionOf(scopeFor(REQUESTER)),
    });
    const withdrawn = yield* bff.decide(headers(), decidePayload({ decision: 'withdraw' }));
    expect(withdrawn.status).toBe('rejected');
    expect(withdrawals[0]?.approveAuthority).toHaveLength(0);
  }),
);

it.effect('keeps execution disabled with its own 403 and dispatches nothing', () =>
  Effect.gen(function* keepsExecutionDisabled() {
    const bff = bffOf({
      commands: scriptedCommands({
        loaded: record({
          approval: {
            approvedAt: new Date('2026-11-03T10:00:00.000Z'),
            approverId: brand(PrincipalIdSchema, APPROVER),
            expiresAt: new Date('2026-11-04T10:00:00.000Z'),
          },
          status: 'approved',
        }),
      }),
    });
    const problem = yield* problemOf(bff.execute(headers(), executePayload()));
    expect(problem.status).toBe(403);
    expect(problem.detail).toContain('approval_execution_disabled');
  }),
);

/* ------------------------------------------------------------------------------------------------
 * The frozen command and paging.
 * ---------------------------------------------------------------------------------------------- */

it.effect('never renders an inbox whose frozen command cannot be read', () =>
  Effect.gen(function* refusesBlindApproval() {
    const bff = bffOf({ commands: scriptedCommands({ preview: null }) });
    const problem = yield* problemOf(bff.list(headers(), listPayload()));
    expect(problem.status).toBe(503);
  }),
);

it.effect('pages the inbox in the tenant’s own order and never past its end', () =>
  Effect.gen(function* pagesInbox() {
    const older = record({
      createdAt: new Date('2026-11-01T09:00:00.000Z'),
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const bff = bffOf({ commands: scriptedCommands({ open: [older, record()] }) });
    const first = yield* bff.list(headers(), listPayload({ limit: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe('1');
    const second = yield* bff.list(headers(), listPayload({ cursor: '1', limit: 1 }));
    expect(second.nextCursor).toBeNull();
  }),
);

it.effect('refuses a cursor it did not issue', () =>
  Effect.gen(function* refusesCursor() {
    const problem = yield* problemOf(bffOf().list(headers(), listPayload({ cursor: 'not-a-position' })));
    expect(problem.status).toBe(422);
  }),
);

/* ------------------------------------------------------------------------------------------------
 * The record shape the surface reads.
 * ---------------------------------------------------------------------------------------------- */

it.effect('publishes the stored revision and the stored deadlines rather than recomputing them', () =>
  Effect.gen(function* publishesStoredFacts() {
    const approved = record({
      approval: {
        approvedAt: new Date('2026-11-03T10:00:00.000Z'),
        approverId: brand(PrincipalIdSchema, APPROVER),
        expiresAt: new Date('2026-11-04T10:00:00.000Z'),
      },
      status: 'approved',
    });
    const inbox = yield* bffOf({ commands: scriptedCommands({ open: [approved] }) }).list(headers(), listPayload());
    const [item] = inbox.items;
    if (item === undefined) {
      expect.unreachable('the inbox must show the stored proposal');
    }
    expect(item.status).toBe('approved');
    expect(item.revision).toBe(accessApprovalRevision(approved));
    // The mandate deadline is the stored approval window (24 h, or 1 h for a critical command, O60).
    const approvalExpiresAt = item.approver?.approvalExpiresAt;
    expect(approvalExpiresAt).toBeDefined();
    expect(DateTime.formatIso(approvalExpiresAt ?? item.createdAt)).toBe('2026-11-04T10:00:00.000Z');
    expect(DateTime.formatIso(item.expiresAt)).toBe('2026-11-10T09:00:00.000Z');
  }),
);

it.effect('projects a tenant-context proposal without requiring a selected company (O28)', () =>
  Effect.gen(function* projectsTenantScope() {
    const inbox = yield* bffOf().list(headers(), listPayload());
    const scope = inbox.items[0]?.scope;
    expect(scope?.kind).toBe('tenant');
    expect(scope?.kind === 'company').toBe(false);
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Company authority: tenant admission never reaches another company's proposals (O88).
 * ---------------------------------------------------------------------------------------------- */

const COMPANY_A = 'a0000000-0000-4000-8000-00000000000a';
const COMPANY_B = 'b0000000-0000-4000-8000-00000000000b';
const A_SCOPE_ID = 'a1111111-1111-4111-8111-11111111111a';
const B_SCOPE_ID = 'b1111111-1111-4111-8111-11111111111b';
const A_PROPOSAL = 'a7777777-7777-4777-8777-77777777777a';
const B_PROPOSAL = 'b7777777-7777-4777-8777-77777777777b';
const UNKNOWN_PROPOSAL = 'c7777777-7777-4777-8777-77777777777c';
const B_RECORD = 'invoice-b-9001';

/** The company proposals beside the tenant one; B's proposal also names B's own record. */
const companyRecords = [
  record(),
  record({ id: A_PROPOSAL, scopeId: A_SCOPE_ID }),
  record({ id: B_PROPOSAL, scopeId: B_SCOPE_ID }),
];

const scopedAuthority = authority({
  scope: (scopeId) =>
    Effect.succeed(
      Option.fromUndefinedOr(
        {
          [A_SCOPE_ID]: { accessScopeId: A_SCOPE_ID, kind: 'company' as const, legalEntityId: COMPANY_A },
          [B_SCOPE_ID]: { accessScopeId: B_SCOPE_ID, kind: 'company' as const, legalEntityId: COMPANY_B },
          [SCOPE_ID]: { accessScopeId: SCOPE_ID, kind: 'tenant' as const },
        }[scopeId],
      ),
    ),
});

/** A gate that allows everything in the tenant context and in company A, and refuses in company B. */
const companyGate = (companyB: 'DENIED' | 'UNAVAILABLE' = 'DENIED') => {
  const inner = gate();
  // Company B is still asked through the double, so the suite sees every question in its scope.
  const decide: typeof inner.decide = (input) =>
    input.scope.legalEntityId === COMPANY_B
      ? inner.decide(input).pipe(
          Effect.as({
            evidence: [],
            outcome: companyB,
            reasons: [{ code: 'deny.insufficient_grant' }],
            selectors: [],
          }),
        )
      : inner.decide(input);
  return { ...inner, decide };
};

const proposalIdOf = (proposalId: string) => brand(AccessProposalIdSchema, proposalId);
const sortedIds = (values: readonly (string | undefined)[]) =>
  values.map((value) => value ?? '').toSorted((left, right) => left.localeCompare(right));

/** Every command call the suite counts, so a refused proposal is proved never to reach Core. */
const countedCommands = () => {
  const previewed: string[] = [];
  const calls = { approve: 0, preview: previewed, reject: 0, withdraw: 0 };
  const byId = new Map(companyRecords.map((one) => [one.id, one]));
  const service: AccessApprovalsCommandsService = {
    approve: (_scope, input) => {
      calls.approve += 1;
      return Effect.succeed({ ...(byId.get(input.proposalId) ?? record()), status: 'approved' as const });
    },
    governedAmount: () => Effect.succeed(Option.none()),
    load: (_scope, proposalId) => Effect.succeed(Option.fromUndefinedOr(byId.get(proposalId))),
    open: () => Effect.succeed(companyRecords),
    preview: (_scope, input) => {
      calls.preview.push(input.proposalId);
      return Effect.succeed(Option.some(preview()));
    },
    reject: (_scope, input) => {
      calls.reject += 1;
      return Effect.succeed({ ...(byId.get(input.proposalId) ?? record()), status: 'rejected' as const });
    },
    withdraw: (_scope, input) => {
      calls.withdraw += 1;
      return Effect.succeed({ ...(byId.get(input.proposalId) ?? record()), status: 'rejected' as const });
    },
  };
  return { calls, service };
};

it.effect('lists only the proposals whose company admitted the inbox, asked in that company’s scope', () =>
  Effect.gen(function* listsReadableProposals() {
    const commands = countedCommands();
    const answering = companyGate();
    const bff = bffOf({ authority: scopedAuthority, commands: commands.service, gate: answering });
    const inbox = yield* bff.list(headers(), listPayload());

    expect(sortedIds(inbox.items.map(({ proposalId }) => proposalId))).toEqual(sortedIds([A_PROPOSAL, PROPOSAL]));
    for (const secret of [B_PROPOSAL, B_SCOPE_ID, COMPANY_B, B_RECORD]) {
      expect(JSON.stringify(inbox)).not.toContain(secret);
    }
    // B's frozen command was never even rendered.
    expect(commands.calls.preview).not.toContain(B_PROPOSAL);
    const companyAsks = answering.askedDecisions.filter(({ legalEntityScope }) => legalEntityScope === 'required');
    const inboxAsks = companyAsks.filter(
      ({ carrier }) => carrier.accessDeclaration?.key === accessApprovalsDeclarations.list.key,
    );
    expect(sortedIds(inboxAsks.map(({ scope }) => scope.legalEntityId))).toEqual(sortedIds([COMPANY_A, COMPANY_B]));
    // Beside the inbox, only A's proposal is asked about, and in A's own scope: B's is never shaped.
    const proposalAsks = companyAsks.filter(({ carrier }) => carrier.accessDeclaration?.key === CAPABILITY);
    expect(proposalAsks.map(({ scope }) => scope.legalEntityId)).toEqual([COMPANY_A]);
    expect(inboxAsks.length + proposalAsks.length).toBe(companyAsks.length);

    // One proposal per page: the cursor counts the narrowed inbox, so B's proposal shifts no cursor.
    const first = yield* bff.list(headers(), listPayload({ limit: 1 }));
    const second = yield* bff.list(headers(), listPayload({ cursor: '1', limit: 1 }));
    expect(first.nextCursor).toBe('1');
    expect(second.nextCursor).toBeNull();
  }),
);

it.effect('refuses deciding or executing company B’s proposal exactly like a proposal that does not exist', () =>
  Effect.gen(function* refusesOtherCompanyProposal() {
    const commands = countedCommands();
    const bff = bffOf({ authority: scopedAuthority, commands: commands.service, gate: companyGate() });

    for (const decision of ['approve', 'reject', 'withdraw'] as const) {
      const missing = yield* problemOf(
        bff.decide(headers(), decidePayload({ decision, proposalId: proposalIdOf(UNKNOWN_PROPOSAL) })),
      );
      const refused = yield* problemOf(
        bff.decide(headers(), decidePayload({ decision, proposalId: proposalIdOf(B_PROPOSAL) })),
      );
      expect({ detail: refused.detail, status: refused.status }).toEqual({
        detail: missing.detail,
        status: missing.status,
      });
    }
    const missingRun = yield* problemOf(
      bff.execute(headers(), { ...executePayload(), proposalId: proposalIdOf(UNKNOWN_PROPOSAL) }),
    );
    const refusedRun = yield* problemOf(
      bff.execute(headers(), { ...executePayload(), proposalId: proposalIdOf(B_PROPOSAL) }),
    );
    expect({ detail: refusedRun.detail, status: refusedRun.status }).toEqual({
      detail: missingRun.detail,
      status: missingRun.status,
    });
    expect({ ...commands.calls, preview: commands.calls.preview.length }).toEqual({
      approve: 0,
      preview: 0,
      reject: 0,
      withdraw: 0,
    });

    // Company A's proposal is still this person's to decide.
    const settled = yield* bff.decide(
      headers(),
      decidePayload({ decision: 'reject', proposalId: proposalIdOf(A_PROPOSAL) }),
    );
    expect(settled.proposalId).toBe(A_PROPOSAL);
  }),
);

/** A gate that admits the surface everywhere and holds the proposal's own capability in one context only. */
const grantedOnlyIn = (granted: 'company' | 'tenant') => {
  const inner = gate();
  const companyWitness = {
    ...witness(),
    witness: { ...witness().witness, scopeId: brand(AccessScopeIdSchema, A_SCOPE_ID) },
  };
  const decide: typeof inner.decide = (input) => {
    if (input.carrier.accessDeclaration?.key !== CAPABILITY) {
      return inner.decide(input);
    }
    const inCompany = input.legalEntityScope === 'required' && input.scope.legalEntityId === COMPANY_A;
    const inTenant = input.legalEntityScope === 'optional' && input.scope.legalEntityId === undefined;
    const holds = granted === 'company' ? inCompany : inTenant;
    const answer: AccessDecision = holds
      ? {
          evidence: [granted === 'company' ? companyWitness : witness()],
          outcome: 'ALLOWED',
          reasons: [{ code: 'allow.granted' }],
          selectors: [],
        }
      : { evidence: [], outcome: 'DENIED', reasons: [{ code: 'deny.insufficient_grant' }], selectors: [] };
    return inner.decide(input).pipe(Effect.as(answer));
  };
  return { ...inner, decide };
};

it.effect('approves a company proposal with the approver’s grants in that company', () =>
  Effect.gen(function* approvesWithCompanyGrants() {
    const carried: Parameters<AccessApprovalsCommandsService['approve']>[1][] = [];
    const commands = countedCommands();
    const answering = grantedOnlyIn('company');
    const bff = bffOf({
      authority: scopedAuthority,
      commands: {
        ...commands.service,
        approve: (scope, input) => {
          carried.push(input);
          return commands.service.approve(scope, input);
        },
      },
      gate: answering,
    });

    const inbox = yield* bff.list(headers(), listPayload());
    const companyItem = inbox.items.find(({ proposalId }) => proposalId === A_PROPOSAL);
    expect(companyItem?.permitted.approval.allowed).toBe(true);

    const approved = yield* bff.decide(headers(), decidePayload({ proposalId: proposalIdOf(A_PROPOSAL) }));
    expect(approved.status).toBe('approved');
    const [call] = carried;
    expect(call?.approval.scopeId).toBe(A_SCOPE_ID);
    expect(call?.execution.scopeId).toBe(A_SCOPE_ID);
    // The surface itself is still admitted in tenant context; only the proposal's capability moves.
    const capabilityAsks = answering.askedDecisions.filter(
      ({ carrier }) => carrier.accessDeclaration?.key === CAPABILITY,
    );
    expect(capabilityAsks.length).toBeGreaterThan(0);
    expect(
      capabilityAsks
        .filter(({ scope }) => scope.legalEntityId === COMPANY_A)
        .every(({ legalEntityScope }) => legalEntityScope === 'required'),
    ).toBe(true);
    const admissions = answering.askedDecisions.filter(
      ({ carrier, scope }) =>
        carrier.accessDeclaration?.key === accessApprovalsDeclarations.decide.key && scope.legalEntityId === undefined,
    );
    expect(admissions.every(({ legalEntityScope }) => legalEntityScope === 'optional')).toBe(true);
  }),
);

it.effect('never lets a tenant-only grant approve a company proposal', () =>
  Effect.gen(function* tenantGrantIsNotCompanyAuthority() {
    const commands = countedCommands();
    const bff = bffOf({ authority: scopedAuthority, commands: commands.service, gate: grantedOnlyIn('tenant') });

    const inbox = yield* bff.list(headers(), listPayload());
    const companyItem = inbox.items.find(({ proposalId }) => proposalId === A_PROPOSAL);
    expect(companyItem?.permitted.approval).toEqual({ allowed: false, reason: 'approve_authority_missing' });
    const tenantItem = inbox.items.find(({ proposalId }) => proposalId === PROPOSAL);
    expect(tenantItem?.permitted.approval.allowed).toBe(true);

    const problem = yield* problemOf(bff.decide(headers(), decidePayload({ proposalId: proposalIdOf(A_PROPOSAL) })));
    expect(problem.status).toBe(403);
    expect(problem.detail).toContain('access_approvals_approval_authority_missing');
    expect(commands.calls.approve).toBe(0);
  }),
);

it.effect('answers 503 — never a shorter inbox — when a company’s authority cannot be read', () =>
  Effect.gen(function* companyUnavailable() {
    const bff = bffOf({
      authority: scopedAuthority,
      commands: countedCommands().service,
      gate: companyGate('UNAVAILABLE'),
    });
    const problem = yield* problemOf(bff.list(headers(), listPayload()));
    expect(problem.status).toBe(503);
  }),
);
