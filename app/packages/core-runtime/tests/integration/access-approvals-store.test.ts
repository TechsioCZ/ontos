import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, DateTime, Deferred, Effect, Option, Ref, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeDrizzleApprovalStore } from '../../src/access/approvals/drizzle-store.ts';
import type { ApprovalDecisionEvidence } from '../../src/access/approvals/service.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type {
  AssignmentIncarnationId,
  CapabilityKey,
  GrantIncarnationId,
  PrincipalId,
  ProposalId,
  TenantId,
} from '../../src/access/ids.ts';
import { ActionInvocationRefSchema } from '../../src/access/approvals/execution.ts';
import type { AccessMode, AuthorityWitness, Holder, Proposal, WitnessPurpose } from '../../src/access/model.ts';
import { CellSchema } from '../../src/access/model.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import {
  createTemplateDatabase,
  insertTenantStatement,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * The approvals store is the only writer of a proposal's lifecycle, of the approval record that makes
 * it a mandate and of the single execution receipt it carries (O52, guarantee 5). This suite runs it
 * against a real PostgreSQL: it applies the whole committed migration set to a database of its own in
 * every case, seeds the assignments and grant incarnations a witness binds, and then drives the port the
 * approvals service calls.
 *
 * The store runs as `ontos_runtime` — the role the row-level security policies name — so tenant
 * isolation is part of every assertion instead of an assumption, and the fixtures are seeded with the
 * administrative login the rest of the Core integration suites use.
 */
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const TENANT = TenantIdSchema.make(uid(1));
const SCOPE = AccessScopeIdSchema.make(uid(2));
const JANA = PrincipalIdSchema.make(uid(3));
const EVA = PrincipalIdSchema.make(uid(4));
const JANA_AGENT = PrincipalIdSchema.make(uid(5));
const CATALOG_SNAPSHOT = uid(6);
const ROLE = uid(7);
const ROLE_REVISION = uid(8);
const JANA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(9));
const EVA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(10));
const VOID_KEY = CapabilityKeySchema.make('finance.invoice.void');
const READ_KEY = CapabilityKeySchema.make('finance.invoice.read');
const COMMAND_DIGEST = CommandDigestSchema.make('b'.repeat(64));
const APPROVED_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T10:05:00.000Z'));
const APPROVAL_EXPIRES_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T11:05:00.000Z'));
const CREATED_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T10:00:00.000Z'));
const EXECUTED_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T10:30:00.000Z'));
const PROPOSAL_EXPIRES_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-10T10:00:00.000Z'));

const cellJson = Schema.encodeSync(Schema.fromJsonString(CellSchema));
const cellsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CellSchema)));

interface Fixtures {
  readonly grants: {
    readonly 'read:run': GrantIncarnationId;
    readonly 'void:approve': GrantIncarnationId;
    readonly 'void:propose': GrantIncarnationId;
    readonly 'void:run': GrantIncarnationId;
  };
}

const fixtureOf = (grants: Fixtures['grants']): Fixtures => ({ grants });

/** One tenant, one tenant-context scope, one role revision with the cells a mandate binds. */
const seedFixtures = (admin: PgClient.PgClient): Effect.Effect<Fixtures> =>
  Effect.gen(function* seedAccessApprovalsFixtures() {
    const fixtures = fixtureOf({
      'read:run': GrantIncarnationIdSchema.make(uid(20)),
      'void:approve': GrantIncarnationIdSchema.make(uid(21)),
      'void:propose': GrantIncarnationIdSchema.make(uid(22)),
      'void:run': GrantIncarnationIdSchema.make(uid(23)),
    });
    const cells = [
      { capabilityKey: READ_KEY, grant: fixtures.grants['read:run'], mode: 'run' },
      { capabilityKey: VOID_KEY, grant: fixtures.grants['void:approve'], mode: 'approve' },
      { capabilityKey: VOID_KEY, grant: fixtures.grants['void:propose'], mode: 'propose' },
      { capabilityKey: VOID_KEY, grant: fixtures.grants['void:run'], mode: 'run' },
    ] as const;
    const cellOf = (cell: (typeof cells)[number]) => ({
      capabilityKey: cell.capabilityKey,
      mode: cell.mode,
      selector: { _tag: 'all' as const },
    });
    const statements = [
      insertTenantStatement(TENANT),
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${TENANT}', '${JANA}', 'human', 'Jana', 'active'),
         ('${TENANT}', '${EVA}', 'human', 'Eva', 'active'),
         ('${TENANT}', '${JANA_AGENT}', 'agent', 'Janin agent', 'active')`,
      `insert into core.access_catalog_snapshots (catalog_snapshot_id, digest, published_at)
         values ('${CATALOG_SNAPSHOT}', '${'a'.repeat(64)}', now())`,
      `insert into core.access_catalog_entries (catalog_snapshot_id, capability_key, entry_json) values
         ('${CATALOG_SNAPSHOT}', '${VOID_KEY}', '{"key": "${VOID_KEY}"}'::jsonb),
         ('${CATALOG_SNAPSHOT}', '${READ_KEY}', '{"key": "${READ_KEY}"}'::jsonb)`,
      `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id)
         values ('${SCOPE}', '${TENANT}', '${TENANT}')`,
      `insert into core.access_roles (role_id, tenant_id, created_by, name)
         values ('${ROLE}', '${TENANT}', '${JANA}', 'Účetní')`,
      `insert into core.access_role_revisions
         (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
         values ('${ROLE_REVISION}', '${TENANT}', '${ROLE}', 1, '${CATALOG_SNAPSHOT}',
                 '${cellsJson(cells.map(cellOf))}'::jsonb, '${JANA}', 'manual')`,
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
         values ('${JANA_ASSIGNMENT}', '${TENANT}', '${SCOPE}', '${ROLE}', '${ROLE_REVISION}', '${JANA}', '${EVA}', 'active', now()),
                ('${EVA_ASSIGNMENT}', '${TENANT}', '${SCOPE}', '${ROLE}', '${ROLE_REVISION}', '${EVA}', '${EVA}', 'active', now())`,
      ...cells.map(
        (cell) =>
          `insert into core.access_grant_incarnations
             (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
             values ('${cell.grant}', '${TENANT}', '${SCOPE}', '${ROLE}', '${cell.capabilityKey}', '${cell.mode}',
                     'all', '${cellJson(cellOf(cell))}'::jsonb, 'active')`,
      ),
    ];
    yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie), {
      concurrency: 1,
      discard: true,
    });
    return fixtures;
  });

/**
 * A database of this case's own, with the committed schema applied as the first thing that ever touches
 * it. Dropping it is the cleanup: no other suite shares a row with this one.
 */
const approvalsDatabase = Effect.gen(function* approvalsDatabaseEffect() {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const crypto = yield* Crypto.Crypto;
  // Two connections per client: the suite creates one database per test, so the pools stay small
  // enough that every test can hold its own fixture without starving the server's connection budget.
  const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  const name = `access_approvals_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  yield* bootstrap.unsafe(`create database "${name}"`).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() =>
    bootstrap.unsafe(`drop database if exists "${name}" with (force)`).pipe(Effect.orDie),
  );
  const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, name), {
    maxConnections: 2,
  });
  yield* createTemplateDatabase(admin);
  const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, name), {
    maxConnections: 2,
  });
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  const store = makeDrizzleApprovalStore(
    { enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor: database },
    crypto,
  );
  return { admin, store };
});

/** The trusted request scope a store call runs in: one acting person of one tenant (O66). */
const scopeFor = (principalId: PrincipalId, tenantId: TenantId = TENANT): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    // A background Core path: no session, no impersonation, one safe job reference.
    authContextRef: 'job:access-approvals-store:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-approvals-store' })),
    Effect.orDie,
  );

const modeOfPurpose = (purpose: WitnessPurpose): AccessMode => {
  if (purpose === 'approval') {
    return 'approve';
  }
  return purpose === 'requester' ? 'propose' : 'run';
};

const holder = (principalId: PrincipalId): Holder => ({ _tag: 'Principal', principalId });

const witness = (input: {
  readonly assignmentIncarnationId: AssignmentIncarnationId;
  readonly capabilityKey: CapabilityKey;
  readonly grantIncarnationId: GrantIncarnationId;
  readonly holderId: Holder;
  readonly purpose: WitnessPurpose;
}): AuthorityWitness => ({
  assignmentIncarnationId: input.assignmentIncarnationId,
  capabilityKey: input.capabilityKey,
  grantIncarnationId: input.grantIncarnationId,
  holderId: input.holderId,
  mode: modeOfPurpose(input.purpose),
  purpose: input.purpose,
  scopeId: SCOPE,
});

/** The requester's own propose cell: the witness a pending proposal binds. */
const requesterWitness = (fixtures: Fixtures): AuthorityWitness =>
  witness({
    assignmentIncarnationId: JANA_ASSIGNMENT,
    capabilityKey: VOID_KEY,
    grantIncarnationId: fixtures.grants['void:propose'],
    holderId: holder(JANA),
    purpose: 'requester',
  });

/** The approve-mode witness an eligible approver's decision names. */
const approvalWitness = (fixtures: Fixtures): AuthorityWitness =>
  witness({
    assignmentIncarnationId: EVA_ASSIGNMENT,
    capabilityKey: VOID_KEY,
    grantIncarnationId: fixtures.grants['void:approve'],
    holderId: holder(EVA),
    purpose: 'approval',
  });

/** The run-mode witness the approver executes the command with. */
const executionWitness = (fixtures: Fixtures): AuthorityWitness =>
  witness({
    assignmentIncarnationId: EVA_ASSIGNMENT,
    capabilityKey: VOID_KEY,
    grantIncarnationId: fixtures.grants['void:run'],
    holderId: holder(EVA),
    purpose: 'execution',
  });

/** The read of the parent record the command changes; a mandate binds it like any other witness. */
const parentReadWitness = (fixtures: Fixtures): AuthorityWitness =>
  witness({
    assignmentIncarnationId: EVA_ASSIGNMENT,
    capabilityKey: READ_KEY,
    grantIncarnationId: fixtures.grants['read:run'],
    holderId: holder(EVA),
    purpose: 'parent_record_read',
  });

const pendingProposal = (input: {
  readonly fixtures: Fixtures;
  readonly proposalId: ProposalId;
  readonly tenantId: TenantId;
}): Proposal => ({
  capabilityKey: VOID_KEY,
  commandDigest: COMMAND_DIGEST,
  createdAt: CREATED_AT,
  expiresAt: PROPOSAL_EXPIRES_AT,
  id: input.proposalId,
  requester: { _tag: 'Principal', principalId: JANA },
  scopeId: SCOPE,
  status: 'pending',
  tenantId: input.tenantId,
  witnesses: [requesterWitness(input.fixtures)],
});

const allWitnesses = (fixtures: Fixtures): readonly [AuthorityWitness, ...AuthorityWitness[]] => [
  requesterWitness(fixtures),
  approvalWitness(fixtures),
  executionWitness(fixtures),
  parentReadWitness(fixtures),
];

const approvedProposal = (input: { readonly fixtures: Fixtures; readonly proposalId: ProposalId }): Proposal => ({
  ...pendingProposal({ ...input, tenantId: TENANT }),
  approval: {
    approvalAssignmentIncarnationId: EVA_ASSIGNMENT,
    approvedAt: APPROVED_AT,
    approverId: EVA,
    executionAssignmentIncarnationId: EVA_ASSIGNMENT,
    expiresAt: APPROVAL_EXPIRES_AT,
  },
  status: 'approved',
  witnesses: allWitnesses(input.fixtures),
});

const executedProposal = (input: {
  readonly fixtures: Fixtures;
  readonly invocation: string;
  readonly proposalId: ProposalId;
}): Proposal => ({
  ...approvedProposal(input),
  execution: { actionInvocationId: ActionInvocationRefSchema.make(input.invocation), executedAt: EXECUTED_AT },
  status: 'executed',
});

/**
 * The same witness list with one purpose replaced. A proposal the model would refuse is exactly what a
 * hand-written authority check can produce, and only the database guards refuse it; the tuple keeps
 * its non-empty shape so the record is still a `Proposal` the store accepts to write.
 */
const swapWitness = (
  proposal: Proposal,
  purpose: WitnessPurpose,
  change: (entry: AuthorityWitness) => AuthorityWitness,
): readonly [AuthorityWitness, ...AuthorityWitness[]] => {
  const replaced = proposal.witnesses.map((entry) => (entry.purpose === purpose ? change(entry) : entry));
  const [first, ...rest] = replaced;
  if (first === undefined) {
    throw new Error('A proposal always binds at least one witness');
  }
  return [first, ...rest];
};

/**
 * The same witness list without one purpose. Removing the execution witness leaves a record SQL refuses
 * only at COMMIT time, which is exactly the refusal that used to reach Core as unavailability (R4-M1).
 */
const withoutWitness = (
  proposal: Proposal,
  purpose: WitnessPurpose,
): readonly [AuthorityWitness, ...AuthorityWitness[]] => {
  const [first, ...rest] = proposal.witnesses.filter((entry) => entry.purpose !== purpose);
  if (first === undefined) {
    throw new Error('The remaining witnesses are never empty');
  }
  return [first, ...rest];
};

const nextProposalId = Effect.gen(function* nextProposalIdEffect() {
  const crypto = yield* Crypto.Crypto;
  return ProposalIdSchema.make(yield* crypto.randomUUIDv4());
});

const rejectedEvidence = (fixtures: Fixtures): ApprovalDecisionEvidence => ({
  basis: 'approver',
  decidedBy: EVA,
  witnesses: [approvalWitness(fixtures)],
});

interface DecisionRow {
  readonly actor_principal_id: string;
  readonly capability_key: string;
  readonly correlation_id: string;
  readonly mode: string;
  readonly outcome: string;
  readonly reasons: readonly { readonly code: string }[];
  readonly scope_target: string | null;
}

const decisionsOf = (admin: PgClient.PgClient): Effect.Effect<readonly DecisionRow[]> =>
  admin
    .unsafe<DecisionRow>(
      `select actor_principal_id, capability_key, correlation_id, mode, outcome, reasons_json as reasons,
              target as scope_target
         from core.access_decision_logs order by decided_at, decision_log_id`,
    )
    .pipe(Effect.orDie);

const mandateCount = (admin: PgClient.PgClient): Effect.Effect<number> =>
  admin.unsafe<{ count: string }>('select count(*)::text as count from core.access_mandates').pipe(
    Effect.orDie,
    Effect.map((rows) => Number(rows[0]?.count ?? '0')),
  );

const witnessPurposes = (admin: PgClient.PgClient): Effect.Effect<readonly string[]> =>
  admin.unsafe<{ purpose: string }>('select purpose from core.access_mandate_grants order by purpose').pipe(
    Effect.orDie,
    Effect.map((rows) => rows.map(({ purpose }) => purpose)),
  );

const storedExecution = (admin: PgClient.PgClient): Effect.Effect<Option.Option<string>> =>
  admin
    .unsafe<{ execution_operation_id: string | null }>('select execution_operation_id from core.access_proposals')
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.execution_operation_id)),
    );

it.layer(NodeServices.layer)('access approvals store', (suite) => {
  suite.effect('walks a proposal from propose through approve to one execution receipt', () =>
    Effect.gen(function* approvalFlow() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const records = store.recordsFor(yield* scopeFor(JANA));
      const approverRecords = store.recordsFor(yield* scopeFor(EVA));
      const proposalId = yield* nextProposalId;
      const pending = pendingProposal({ fixtures, proposalId, tenantId: TENANT });
      yield* records.create(pending);
      const scopeOf = { proposalId, scopeId: SCOPE, tenantId: TENANT };
      expect(Option.getOrThrow(yield* records.load(scopeOf))).toEqual(pending);
      expect(yield* records.listOpen({ scopeId: SCOPE, tenantId: TENANT })).toEqual([pending]);
      expect(yield* mandateCount(admin)).toBe(0);

      // The approval stores the record and one witness row per bound witness, all in one transaction,
      // and only the approving person's own scope may write it (R4-H1).
      const approved = approvedProposal({ fixtures, proposalId });
      yield* approverRecords.save({ expectedStatus: 'pending', proposal: approved });
      expect(Option.getOrThrow(yield* records.load(scopeOf))).toEqual(approved);
      expect(yield* mandateCount(admin)).toBe(1);
      // NEGATIVE CONTROL for R4-L2: the approval binds only the approving person's own witnesses. The
      // requester's authority was frozen on the proposal row when the request was made, so no approval
      // witness row can re-bind it — and the read below still reports exactly that frozen authority.
      expect(yield* witnessPurposes(admin)).toEqual(['approval', 'execution', 'parent_record_read']);
      expect(
        Option.getOrThrow(yield* records.load(scopeOf)).witnesses.filter(({ purpose }) => purpose === 'requester'),
      ).toEqual(pending.witnesses);

      // One execution, and the receipt the proposal carries is the one SQL stores.
      const executed = executedProposal({ fixtures, invocation: uid(30), proposalId });
      yield* approverRecords.save({ expectedStatus: 'approved', proposal: executed });
      expect(Option.getOrThrow(yield* records.load(scopeOf))).toEqual(executed);
      expect(Option.getOrThrow(yield* storedExecution(admin))).toBe(uid(30));
      expect(yield* records.listOpen({ scopeId: SCOPE, tenantId: TENANT })).toEqual([]);
      // A second execution of the same mandate loses the compare-and-set instead of running twice.
      const second = yield* Effect.flip(
        approverRecords.save({
          expectedStatus: 'approved',
          proposal: {
            ...executed,
            execution: { actionInvocationId: ActionInvocationRefSchema.make(uid(31)), executedAt: EXECUTED_AT },
          },
        }),
      );
      expect(second.code).toBe('approval_storage_conflict');
      expect(yield* mandateCount(admin)).toBe(1);
      expect(Option.getOrThrow(yield* storedExecution(admin))).toBe(uid(30));
    }),
  );

  suite.effect('lets exactly one of two racing executions of one mandate win', () =>
    Effect.gen(function* racingExecutions() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const records = store.recordsFor(yield* scopeFor(JANA));
      const approverRecords = store.recordsFor(yield* scopeFor(EVA));
      const proposalId = yield* nextProposalId;
      yield* records.create(pendingProposal({ fixtures, proposalId, tenantId: TENANT }));
      yield* approverRecords.save({
        expectedStatus: 'pending',
        proposal: approvedProposal({ fixtures, proposalId }),
      });
      const scopeOf = { proposalId, scopeId: SCOPE, tenantId: TENANT };
      // Both writers read the same approved proposal and hand in their own invocation, exactly as two
      // concurrent "run it now" requests do. Only one compare-and-set can match the stored status.
      const race = (invocation: string) =>
        approverRecords
          .save({ expectedStatus: 'approved', proposal: executedProposal({ fixtures, invocation, proposalId }) })
          .pipe(Effect.result);
      // Both writers enter the store together, so their compare-and-set really races for one row instead
      // of the test hoping the pool schedules them closely enough (R4-L7).
      const bothReady = yield* Deferred.make<null>();
      const ready = yield* Ref.make(0);
      const joinRace = Ref.updateAndGet(ready, (count) => count + 1).pipe(
        Effect.flatMap((count) => (count >= 2 ? Deferred.succeed(bothReady, null) : Effect.succeed(false))),
        Effect.asVoid,
        Effect.andThen(Deferred.await(bothReady)),
      );
      const results = yield* Effect.all(
        [race(uid(40)), race(uid(41))].map((entry) => joinRace.pipe(Effect.andThen(entry))),
        { concurrency: 2 },
      );

      const succeeded = results.filter(Result.isSuccess);
      const refused = results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []));
      expect(succeeded).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.code).toBe('approval_storage_conflict');
      const stored = yield* storedExecution(admin);
      expect([uid(40), uid(41)]).toContain(Option.getOrThrow(stored));
      // The loser left no receipt, no second approval record and no decision of its own.
      expect(yield* mandateCount(admin)).toBe(1);
      expect(yield* decisionsOf(admin)).toEqual([]);
      expect(Option.getOrThrow(yield* records.load(scopeOf)).status).toBe('executed');
    }),
  );

  suite.effect('records who rejected a proposal, on what basis and with which witness', () =>
    Effect.gen(function* rejectionEvidence() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const records = store.recordsFor(yield* scopeFor(JANA));
      const approverRecords = store.recordsFor(yield* scopeFor(EVA));
      const proposalId = yield* nextProposalId;
      const pending = pendingProposal({ fixtures, proposalId, tenantId: TENANT });
      yield* records.create(pending);
      const rejected: Proposal = {
        ...pending,
        endedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T10:20:00.000Z')),
        rejectedBy: EVA,
        status: 'rejected',
      };
      yield* approverRecords.save({
        evidence: rejectedEvidence(fixtures),
        expectedStatus: 'pending',
        proposal: rejected,
        reason: 'proposal_rejected',
      });
      expect(Option.getOrThrow(yield* records.load({ proposalId, scopeId: SCOPE, tenantId: TENANT }))).toEqual(
        rejected,
      );
      // A rejection carries no approval record: the proposal never reached one.
      expect(yield* mandateCount(admin)).toBe(0);
      // A decision is recorded only by the person this request runs as (O66): the requester's own
      // scope cannot store somebody else's rejection.
      const otherDecider = yield* Effect.flip(
        records.save({
          evidence: rejectedEvidence(fixtures),
          expectedStatus: 'pending',
          proposal: rejected,
          reason: 'proposal_rejected',
        }),
      );
      expect(otherDecider.code).toBe('approval_storage_conflict');
      const [decision] = yield* decisionsOf(admin);
      expect(decision).toEqual({
        actor_principal_id: EVA,
        capability_key: VOID_KEY,
        correlation_id: `access-approvals:${proposalId}:rejected`,
        mode: 'approve',
        outcome: 'DENIED',
        reasons: [
          { code: 'decider.approver' },
          { code: 'proposal_rejected' },
          {
            assignmentIncarnationId: EVA_ASSIGNMENT,
            capabilityKey: VOID_KEY,
            code: 'rejection.witness',
            grantIncarnationId: fixtures.grants['void:approve'],
          },
        ],
        scope_target: null,
      });
    }),
  );

  suite.effect('records why a mandate lapsed and why a proposal expired', () =>
    Effect.gen(function* lapseAndExpiry() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const records = store.recordsFor(yield* scopeFor(JANA));
      const approverRecords = store.recordsFor(yield* scopeFor(EVA));
      const lapsedId = yield* nextProposalId;
      yield* records.create(pendingProposal({ fixtures, proposalId: lapsedId, tenantId: TENANT }));
      yield* approverRecords.save({
        expectedStatus: 'pending',
        proposal: approvedProposal({ fixtures, proposalId: lapsedId }),
      });
      const lapsed: Proposal = {
        ...approvedProposal({ fixtures, proposalId: lapsedId }),
        endedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T10:40:00.000Z')),
        status: 'lapsed',
      };
      // A deadline or a lost authority is nobody's decision, so it is stored by the workload's own
      // method and never by the person's (R4-H1).
      yield* records.recordEnd({ expectedStatus: 'approved', proposal: lapsed, reason: 'role_lost' });

      const expiredId = yield* nextProposalId;
      yield* records.create(pendingProposal({ fixtures, proposalId: expiredId, tenantId: TENANT }));
      const expired: Proposal = {
        ...pendingProposal({ fixtures, proposalId: expiredId, tenantId: TENANT }),
        endedAt: PROPOSAL_EXPIRES_AT,
        status: 'expired',
      };
      yield* records.recordEnd({ expectedStatus: 'pending', proposal: expired, reason: 'proposal_expired' });

      // The lapse keeps the approval record: the decision that was withdrawn stays as the audit trail.
      expect(yield* mandateCount(admin)).toBe(1);
      const decisions = yield* decisionsOf(admin);
      expect(decisions.map(({ correlation_id }) => correlation_id)).toEqual([
        `access-approvals:${lapsedId}:lapsed`,
        `access-approvals:${expiredId}:expired`,
      ]);
      expect(decisions.map(({ reasons }) => reasons)).toEqual([
        [{ code: 'role_lost' }],
        [{ code: 'proposal_expired' }],
      ]);
      expect(yield* records.listOpen({ scopeId: SCOPE, tenantId: TENANT })).toEqual([]);
    }),
  );

  suite.effect('refuses a transition the model forbids and a writer whose status is stale', () =>
    Effect.gen(function* refusedTransitions() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const records = store.recordsFor(yield* scopeFor(JANA));
      const approverRecords = store.recordsFor(yield* scopeFor(EVA));
      const proposalId = yield* nextProposalId;
      yield* records.create(pendingProposal({ fixtures, proposalId, tenantId: TENANT }));

      // The model's own transition table: a pending proposal never jumps to executed.
      const illegal = yield* Effect.flip(
        approverRecords.save({
          expectedStatus: 'pending',
          proposal: executedProposal({ fixtures, invocation: uid(50), proposalId }),
        }),
      );
      expect(illegal.code).toBe('approval_storage_conflict');
      // A writer that read an approval somebody else has not stored yet finds the status moved.
      const stale = yield* Effect.flip(
        approverRecords.save({
          expectedStatus: 'approved',
          proposal: executedProposal({ fixtures, invocation: uid(51), proposalId }),
        }),
      );
      expect(stale.code).toBe('approval_storage_conflict');
      // Neither refusal wrote anything: the proposal is still pending with one frozen command.
      expect(Option.getOrThrow(yield* records.load({ proposalId, scopeId: SCOPE, tenantId: TENANT })).status).toBe(
        'pending',
      );
      expect(yield* mandateCount(admin)).toBe(0);
      expect(Option.isNone(yield* storedExecution(admin))).toBe(true);
    }),
  );

  suite.effect('surfaces a refusal PostgreSQL proves as a tagged storage error, never a defect', () =>
    Effect.gen(function* databaseRefusals() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const records = store.recordsFor(yield* scopeFor(JANA));
      const approverRecords = store.recordsFor(yield* scopeFor(EVA));

      // An approval witness held by somebody other than the approving person: the row is the same
      // shape and the assignment exists, so the witness guard of the approval record is what refuses
      // it. That refusal can never be satisfied by retrying, so it reaches Core as a non-retryable
      // storage refusal — NEGATIVE CONTROL for R4-M1, which reported it as unavailability.
      const wrongWitnessId = yield* nextProposalId;
      yield* records.create(pendingProposal({ fixtures, proposalId: wrongWitnessId, tenantId: TENANT }));
      const wrongWitness = approvedProposal({ fixtures, proposalId: wrongWitnessId });
      const refused = yield* Effect.flip(
        approverRecords.save({
          expectedStatus: 'pending',
          proposal: {
            ...wrongWitness,
            witnesses: swapWitness(wrongWitness, 'approval', (entry) => ({
              ...entry,
              assignmentIncarnationId: JANA_ASSIGNMENT,
            })),
          },
        }),
      );
      expect(refused.code).toBe('approval_storage_conflict');
      expect(yield* mandateCount(admin)).toBe(0);

      // A witness whose grant cell does not exist cannot be bound either; the same refusal.
      const unknownGrantId = yield* nextProposalId;
      yield* records.create(pendingProposal({ fixtures, proposalId: unknownGrantId, tenantId: TENANT }));
      const unknownGrant = approvedProposal({ fixtures, proposalId: unknownGrantId });
      const orphan = yield* Effect.flip(
        approverRecords.save({
          expectedStatus: 'pending',
          proposal: {
            ...unknownGrant,
            witnesses: swapWitness(unknownGrant, 'execution', (entry) => ({
              ...entry,
              grantIncarnationId: GrantIncarnationIdSchema.make(uid(99)),
            })),
          },
        }),
      );
      expect(orphan.code).toBe('approval_storage_conflict');
      expect(yield* mandateCount(admin)).toBe(0);
      // The refused transactions rolled back whole: no proposal of the failed attempts kept a status.
      expect(
        Option.getOrThrow(yield* records.load({ proposalId: wrongWitnessId, scopeId: SCOPE, tenantId: TENANT })).status,
      ).toBe('pending');
    }),
  );

  suite.effect('binds the acting person of every transition to the status it writes', () =>
    Effect.gen(function* actingPersonPerStatus() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const requester = store.recordsFor(yield* scopeFor(JANA));
      const approver = store.recordsFor(yield* scopeFor(EVA));
      const requesterAgent = store.recordsFor(yield* scopeFor(JANA_AGENT));
      const statusOf = (proposalId: ProposalId) =>
        requester
          .load({ proposalId, scopeId: SCOPE, tenantId: TENANT })
          .pipe(Effect.map((stored) => Option.getOrThrow(stored).status));

      // NEGATIVE CONTROL 1: approving is the approving person's own write. The requester's scope
      // carries the same proposal and names the same approver, and it is still refused, because the
      // acting person of this request is not the person the approval binds (R4-H1).
      const approvedId = yield* nextProposalId;
      yield* requester.create(pendingProposal({ fixtures, proposalId: approvedId, tenantId: TENANT }));
      const bystanderApproval = yield* Effect.flip(
        requester.save({ expectedStatus: 'pending', proposal: approvedProposal({ fixtures, proposalId: approvedId }) }),
      );
      expect(bystanderApproval.code).toBe('approval_storage_conflict');
      expect(yield* mandateCount(admin)).toBe(0);
      expect(yield* statusOf(approvedId)).toBe('pending');
      yield* approver.save({
        expectedStatus: 'pending',
        proposal: approvedProposal({ fixtures, proposalId: approvedId }),
      });
      expect(yield* mandateCount(admin)).toBe(1);

      // NEGATIVE CONTROL 2: the requester never executes its own mandate. The approval row is what
      // the store compares with, so the request that planned the work cannot run it (O63, R4-H1).
      const requesterRun = yield* Effect.flip(
        requester.save({
          expectedStatus: 'approved',
          proposal: executedProposal({ fixtures, invocation: uid(60), proposalId: approvedId }),
        }),
      );
      expect(requesterRun.code).toBe('approval_storage_conflict');
      expect(Option.isNone(yield* storedExecution(admin))).toBe(true);
      expect(yield* statusOf(approvedId)).toBe('approved');

      // NEGATIVE CONTROL 3: neither does the requester's agent, whoever it works for. A mandate is
      // executed by its approving human and by nobody else (O63).
      const agentRun = yield* Effect.flip(
        requesterAgent.save({
          expectedStatus: 'approved',
          proposal: executedProposal({ fixtures, invocation: uid(61), proposalId: approvedId }),
        }),
      );
      expect(agentRun.code).toBe('approval_storage_conflict');
      expect(Option.isNone(yield* storedExecution(admin))).toBe(true);
      // The approving person's own scope stores it.
      yield* approver.save({
        expectedStatus: 'approved',
        proposal: executedProposal({ fixtures, invocation: uid(62), proposalId: approvedId }),
      });
      expect(Option.getOrThrow(yield* storedExecution(admin))).toBe(uid(62));

      // NEGATIVE CONTROL 4: a rejection names the person who took it, and only that person's scope
      // writes it. A scope that runs as somebody else writes nothing (O61, R4-H1).
      const rejectedId = yield* nextProposalId;
      const pending = pendingProposal({ fixtures, proposalId: rejectedId, tenantId: TENANT });
      yield* requester.create(pending);
      const somebodyElsesRejection: Proposal = {
        ...pending,
        endedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T10:20:00.000Z')),
        rejectedBy: JANA,
        status: 'rejected',
      };
      const foreignRejection = yield* Effect.flip(
        approver.save({ expectedStatus: 'pending', proposal: somebodyElsesRejection, reason: 'proposal_rejected' }),
      );
      expect(foreignRejection.code).toBe('approval_storage_conflict');
      expect(yield* decisionsOf(admin)).toEqual([]);
      expect(yield* statusOf(rejectedId)).toBe('pending');

      // NEGATIVE CONTROL 5: a mandate lapses only through its requester's own withdrawal or through
      // the workload. A scope that runs as somebody else cannot lapse it (O57, R4-H1).
      const lapseId = yield* nextProposalId;
      yield* requester.create(pendingProposal({ fixtures, proposalId: lapseId, tenantId: TENANT }));
      yield* approver.save({
        expectedStatus: 'pending',
        proposal: approvedProposal({ fixtures, proposalId: lapseId }),
      });
      const foreignLapse = yield* Effect.flip(
        approver.save({
          expectedStatus: 'approved',
          proposal: { ...approvedProposal({ fixtures, proposalId: lapseId }), endedAt: EXECUTED_AT, status: 'lapsed' },
        }),
      );
      expect(foreignLapse.code).toBe('approval_storage_conflict');
      expect(yield* statusOf(lapseId)).toBe('approved');
      // The requester's own withdrawal is its own act and is stored, keeping the approval record.
      yield* requester.save({
        expectedStatus: 'approved',
        proposal: { ...approvedProposal({ fixtures, proposalId: lapseId }), endedAt: EXECUTED_AT, status: 'lapsed' },
        reason: 'proposal_withdrawn',
      });
      expect(yield* statusOf(lapseId)).toBe('lapsed');

      // NEGATIVE CONTROL 6: an expiry is the clock's, never a person's. The person's path refuses it
      // even for the requester that owns the proposal, and the workload's method stores it.
      const expiryId = yield* nextProposalId;
      yield* requester.create(pendingProposal({ fixtures, proposalId: expiryId, tenantId: TENANT }));
      const expired: Proposal = {
        ...pendingProposal({ fixtures, proposalId: expiryId, tenantId: TENANT }),
        endedAt: PROPOSAL_EXPIRES_AT,
        status: 'expired',
      };
      const personExpiry = yield* Effect.flip(
        requester.save({ expectedStatus: 'pending', proposal: expired, reason: 'proposal_expired' }),
      );
      expect(personExpiry.code).toBe('approval_storage_conflict');
      expect(yield* statusOf(expiryId)).toBe('pending');
      yield* requester.recordEnd({ expectedStatus: 'pending', proposal: expired, reason: 'proposal_expired' });
      expect(yield* statusOf(expiryId)).toBe('expired');

      // NEGATIVE CONTROL 7: the workload's method writes only the two ends no person decides, so it
      // is not a second door to an approval or a rejection.
      const workloadApprovalId = yield* nextProposalId;
      yield* requester.create(pendingProposal({ fixtures, proposalId: workloadApprovalId, tenantId: TENANT }));
      const workloadApproval = yield* Effect.flip(
        requester.recordEnd({
          expectedStatus: 'pending',
          proposal: approvedProposal({ fixtures, proposalId: workloadApprovalId }),
          reason: 'role_lost',
        }),
      );
      expect(workloadApproval.code).toBe('approval_storage_conflict');
      expect(yield* statusOf(workloadApprovalId)).toBe('pending');
      // NEGATIVE CONTROL 8: and it is still bound by the scope's tenant.
      yield* admin.unsafe(insertTenantStatement(uid(72))).pipe(Effect.orDie);
      const foreignEnd = yield* Effect.flip(
        requester.recordEnd({
          expectedStatus: 'pending',
          proposal: { ...expired, id: workloadApprovalId, tenantId: TenantIdSchema.make(uid(72)) },
          reason: 'proposal_expired',
        }),
      );
      expect(foreignEnd.code).toBe('approval_storage_conflict');
      expect(yield* statusOf(workloadApprovalId)).toBe('pending');
    }),
  );

  suite.effect('refuses a half-approved pair at commit as a permanent refusal, never as unavailability', () =>
    Effect.gen(function* deferredRefusal() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const requester = store.recordsFor(yield* scopeFor(JANA));
      const approver = store.recordsFor(yield* scopeFor(EVA));
      const proposalId = yield* nextProposalId;
      yield* requester.create(pendingProposal({ fixtures, proposalId, tenantId: TENANT }));
      const approved = approvedProposal({ fixtures, proposalId });
      // An approval that binds no execution witness passes every BEFORE trigger: the pairing of a
      // proposal with exactly one approval and both approver witnesses is required at COMMIT, by a
      // deferred constraint trigger. Its refusal therefore arrives from the commit, not from a
      // statement, and it must still reach Core as a refusal rather than as retryable unavailability.
      const halfApproved: Proposal = { ...approved, witnesses: withoutWitness(approved, 'execution') };
      const refused = yield* Effect.flip(approver.save({ expectedStatus: 'pending', proposal: halfApproved }));
      expect(refused.code).toBe('approval_storage_conflict');
      // Nothing of the refused transaction survived: no approval record, no proposal move.
      expect(yield* mandateCount(admin)).toBe(0);
      expect(yield* witnessPurposes(admin)).toEqual([]);
      expect(yield* requester.load({ proposalId, scopeId: SCOPE, tenantId: TENANT })).toEqual(
        Option.some(pendingProposal({ fixtures, proposalId, tenantId: TENANT })),
      );
      // The same approval with the witness it owes is stored, so the refusal above is about the
      // missing witness and never about the record shape.
      yield* approver.save({ expectedStatus: 'pending', proposal: approved });
      expect(yield* mandateCount(admin)).toBe(1);
    }),
  );

  suite.effect('keeps another tenant out of a proposal, its approval and its witness rows', () =>
    Effect.gen(function* tenantIsolation() {
      const { admin, store } = yield* approvalsDatabase;
      const fixtures = yield* seedFixtures(admin);
      const records = store.recordsFor(yield* scopeFor(JANA));
      const approverRecords = store.recordsFor(yield* scopeFor(EVA));
      yield* admin.unsafe(insertTenantStatement(uid(70))).pipe(Effect.orDie);
      const otherTenant = TenantIdSchema.make(uid(70));
      const foreign = store.recordsFor(yield* scopeFor(JANA, otherTenant));
      const foreignApprover = store.recordsFor(yield* scopeFor(EVA, otherTenant));
      const proposalId = yield* nextProposalId;
      yield* records.create(pendingProposal({ fixtures, proposalId, tenantId: TENANT }));
      yield* approverRecords.save({ expectedStatus: 'pending', proposal: approvedProposal({ fixtures, proposalId }) });

      // The row-level security policies hide the proposal from a tenant that does not own it.
      expect(Option.isNone(yield* foreign.load({ proposalId, scopeId: SCOPE, tenantId: otherTenant }))).toBe(true);
      expect(yield* foreign.listOpen({ tenantId: otherTenant })).toEqual([]);
      // Naming this scope under the other tenant still reaches no row, so no writer moves it.
      const foreignSave = yield* Effect.flip(
        foreignApprover.save({
          expectedStatus: 'approved',
          proposal: { ...executedProposal({ fixtures, invocation: uid(71), proposalId }), tenantId: otherTenant },
        }),
      );
      expect(foreignSave.code).toBe('approval_storage_conflict');
      // The store refuses to write another tenant's record under this request's scope (O66)…
      const foreignRecord = yield* Effect.flip(
        records.create(pendingProposal({ fixtures, proposalId: yield* nextProposalId, tenantId: otherTenant })),
      );
      expect(foreignRecord.code).toBe('approval_storage_conflict');
      // …and a scope of one tenant is never a scope of another, which the access tables themselves
      // prove: the row's (tenant, scope) pair does not exist, so PostgreSQL refuses the write with a
      // foreign-key violation — a permanent refusal, never retryable unavailability (R4-M1).
      const foreignInsert = yield* Effect.flip(
        foreign.create(pendingProposal({ fixtures, proposalId: yield* nextProposalId, tenantId: otherTenant })),
      );
      expect(foreignInsert.code).toBe('approval_storage_conflict');
      // The owner's row is untouched, and the other tenant wrote nothing it can see.
      expect(Option.getOrThrow(yield* records.load({ proposalId, scopeId: SCOPE, tenantId: TENANT })).status).toBe(
        'approved',
      );
      expect(yield* mandateCount(admin)).toBe(1);
    }),
  );
});
