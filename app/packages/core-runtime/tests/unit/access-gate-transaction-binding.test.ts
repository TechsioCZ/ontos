import { NodeCrypto } from '@effect/platform-node';
import { Cause, Context, Crypto, Effect, Exit, Fiber, Layer, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import type { AccessDecisionLogEntry } from '../../src/access/enforcement/decision-log.ts';
import { AccessDecisionLog, makeDrizzleAccessDecisionLog } from '../../src/access/enforcement/decision-log.ts';
import { AccessPrincipalKindSource, makeDrizzleAccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import type { AccessDecisionPorts, GateInput } from '../../src/access/enforcement/contract.ts';
import {
  LegalEntityCandidates,
  makeDrizzleLegalEntityCandidates,
} from '../../src/access/enforcement/legal-entities.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { AccessIntentLive, decisionAuthorityOf } from '../../src/access/enforcement/intent-reader.ts';
import { AccessIntent } from '../../src/access/decision/authority.ts';
import type { AccessIntentSource } from '../../src/access/decision/authority.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import {
  TenantIntentLoader,
  makeJoinedTenantIntentLoader,
  makeTenantIntentLoader,
} from '../../src/access/intent/tenant-intent-loader.ts';
import { makeDrizzleAccessWorkloadBindings } from '../../src/access/workloads/bindings.ts';
import { AccessScopeIdSchema } from '../../src/access/ids.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import {
  IoInsideDatabaseTransaction,
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../src/db/transaction-io-guard.ts';
import {
  bindAccessGate,
  bindLiveAccessGate,
  bindLiveActionAccessGate,
  joinAccessEnforcementPorts,
} from '../../src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { at, cell, makeAuthority, makeCheck, person, principalHolder, tenant } from './access-decision-support.ts';

/**
 * O75: the canonical gate must join the owner Action's transaction instead of opening a second
 * connection. These proofs run the shipped adapters — the Drizzle actor, evidence, company and
 * workload readers, and the intent loader's own `joined` factory — so a regression in the transaction
 * routing is visible as a real nested transaction (a `BEGIN`/`SAVEPOINT`/`SET TRANSACTION`) rather
 * than as a source-text assertion. The defect this proves fixed opened
 * `set transaction isolation level repeatable read` inside the owner transaction, which PostgreSQL
 * refuses once a query has run.
 */

const ACTION_OWNER = {
  access: 'write',
  authorization: { kind: 'protected' },
  moduleKey: 'finance',
  role: 'action',
} as const;

const CAPABILITY = 'finance.invoice.void';
const scope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:access-gate-transaction-binding',
    authMethod: 'session',
    principalId: person,
    tenantId: tenant,
  }),
  correlationId: 'access-gate-transaction-binding',
});
const now = at('2026-11-03T12:00:00Z');

const declaration = decodeAccessDeclarationOrThrow(
  {
    key: CAPABILITY,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'finance', level: 'extended' },
    risk: 'sensitive',
    selectors: [],
  },
  ACTION_OWNER,
);

const gateInput: GateInput = {
  carrier: { accessDeclaration: declaration },
  legalEntityScope: 'forbidden',
  now,
  scope,
};

const decisionEntry: AccessDecisionLogEntry = {
  actor: { _tag: 'Principal', principalId: person },
  capability: capabilityPolicyOf(declaration),
  decidedAt: now,
  mode: 'run',
  outcome: 'DENIED',
  reasons: [{ code: 'deny.insufficient_grant' }],
  scope,
  scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000003'),
};

const SCOPE_INSTALL = 'current_user';

/** A scripted connection: the scope install verifies, every other statement answers no rows. */
const scripted =
  (statements: string[]) =>
  (statement: string): Effect.Effect<readonly object[]> => {
    statements.push(statement);
    return statement.includes(SCOPE_INSTALL)
      ? Effect.succeed([
          { legal_entity_id: scope.legalEntityId ?? '', role: 'ontos_runtime', tenant_id: scope.tenantId },
        ])
      : Effect.succeed([]);
  };

const opensOwnTransaction = (statement: string): boolean =>
  /(?:^|\s)(?:begin|savepoint|set transaction)(?:\s|$)/iu.test(statement);

/** `writerLocks`: how many fence locks an access writer answers Changing before it gives the fence back. */
const nativeActionBinding = (writerLocks = 0) =>
  Effect.gen(function* nativeActionBindingFixture() {
    let changingLocks = writerLocks;
    const grant = cell({ capability: CAPABILITY, deadline: at('2026-11-03T13:00:00Z') });
    const request = makeAuthority({ cells: [grant] });
    let joined = makeAuthority({ cells: [grant] });
    let revision = 7;
    let remoteCalls = 0;
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes(SCOPE_INSTALL)) {
        return Effect.succeed([
          { legal_entity_id: scope.legalEntityId ?? '', role: 'ontos_runtime', tenant_id: scope.tenantId },
        ]);
      }
      if (statement.includes('lock_access_scope_fence')) {
        if (changingLocks > 0) {
          changingLocks -= 1;
          return Effect.succeed([{ state: 'Changing' }]);
        }
        return Effect.succeed([{ state: 'Ready' }]);
      }
      if (statement.includes('"access_scope_fences"')) {
        return Effect.succeed([{ revision, scope_id: decisionEntry.scopeId, state: 'Ready' }]);
      }
      if (statement.includes('"access_scopes"')) {
        return Effect.succeed([{ scope_id: decisionEntry.scopeId }]);
      }
      return Effect.succeed([]);
    });
    const engine = makeCheck({ authority: { cells: [grant] } });
    const check = {
      checkBulk: (items: Parameters<typeof engine.port.checkBulk>[0]) =>
        Effect.gen(function* guardedEngineCheck() {
          yield* refuseInsideDatabaseTransaction('spicedb', 'CheckBulkPermissions');
          remoteCalls += 1;
          return yield* engine.port.checkBulk(items);
        }),
    };
    const intent: AccessIntentSource = {
      authorityFor: () => request.port,
      joined: () => ({ authorityFor: () => joined.port }),
    };
    const decisionLog = { record: () => Effect.void };
    const candidates = { listCandidateIds: () => Effect.succeed([]) };
    const principalKinds = { readKind: () => Effect.succeed(Option.some('human' as const)) };
    const gate = makeAccessDecisionService({
      authorityFor: intent.authorityFor,
      check,
      decisionLog,
      legalEntities: candidates,
      principalKinds,
    });
    const context = Context.make(AccessDecisionGate, gate).pipe(
      Context.add(AccessIntent, intent),
      Context.add(DecisionCheck, check),
      Context.add(AccessDecisionLog, decisionLog),
      Context.add(LegalEntityCandidates, candidates),
      Context.add(AccessPrincipalKindSource, principalKinds),
      Context.add(CoreDatabase, { executor }),
      Context.add(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
    );
    return {
      actionGate: yield* bindLiveActionAccessGate.pipe(Effect.provideContext(context)),
      advanceRevision: () => {
        revision += 2;
      },
      executor,
      expireAt: at('2026-11-03T13:00:00Z'),
      readGate: yield* bindLiveAccessGate.pipe(Effect.provideContext(context)),
      remoteCalls: () => remoteCalls,
      request,
      revoke: () => {
        joined = makeAuthority({ cells: [] });
      },
      statements,
    };
  });

it.effect('the live Action binding re-plans under the SQL fence without remote I/O or another connection', () =>
  Effect.gen(function* preparedActionBoundary() {
    const fixture = yield* nativeActionBinding();
    // Negative control: the Read binding reproduces the Core Media fixture's original owner-phase failure.
    const original = yield* fixture.executor
      .transaction((transaction) =>
        fixture.readGate.decide(gateInput, transaction).pipe(insideDatabaseTransaction(CAPABILITY)),
      )
      .pipe(Effect.exit);
    if (!Exit.isFailure(original)) {
      expect.unreachable('The Read binding must reproduce the forbidden remote check');
    }
    const defect = Cause.squash(original.cause);
    expect(defect).toBeInstanceOf(IoInsideDatabaseTransaction);
    expect(defect).toMatchObject({ io: 'spicedb', operationKey: CAPABILITY, target: 'CheckBulkPermissions' });
    const { prepare } = fixture.actionGate;
    if (prepare === undefined) {
      return yield* Effect.die('The production Action binding must prepare persisted authority');
    }
    const prepared = yield* prepare(gateInput);
    expect(prepared.decision.outcome).toBe('ALLOWED');
    const calls = fixture.remoteCalls();
    const requestReads = fixture.request.calls.readCells;
    yield* fixture.executor.transaction((transaction) =>
      Effect.gen(function* ownerRecheck() {
        const before = fixture.statements.length;
        const decision = yield* prepared.recheck(now, transaction);
        expect(decision.outcome).toBe('ALLOWED');
        const statements = fixture.statements.slice(before);
        expect(statements.some((statement) => statement.includes('lock_access_scope_fence'))).toBe(true);
        expect(statements.some(opensOwnTransaction)).toBe(false);
      }).pipe(insideDatabaseTransaction(CAPABILITY)),
    );
    expect(fixture.remoteCalls()).toBe(calls);
    expect(fixture.request.calls.readCells).toBe(requestReads);
    return yield* Effect.void;
  }),
);

it.effect('a protected Action waits for an access writer to give the fence back instead of answering 503', () =>
  Effect.gen(function* preparedActionWaitsForWriter() {
    const fixture = yield* nativeActionBinding(3);
    const { prepare } = fixture.actionGate;
    if (prepare === undefined) {
      return yield* Effect.die('The production Action binding must prepare persisted authority');
    }
    const waiting = yield* prepare(gateInput).pipe(Effect.forkChild);
    yield* TestClock.adjust('1 second');
    const prepared = yield* Fiber.join(waiting);
    expect(prepared.decision.outcome).toBe('ALLOWED');
    // The engine is asked once, from the Ready authority; the Changing rounds never reached it.
    expect(fixture.remoteCalls()).toBe(1);
    const decision = yield* fixture.executor.transaction((transaction) =>
      prepared.recheck(now, transaction).pipe(insideDatabaseTransaction(CAPABILITY)),
    );
    expect(decision.outcome).toBe('ALLOWED');
    return yield* Effect.void;
  }),
);

it.effect('a writer that keeps the fence past the wait still answers the retryable 503', () =>
  Effect.gen(function* preparedActionGivesUp() {
    const fixture = yield* nativeActionBinding(Infinity);
    const { prepare } = fixture.actionGate;
    if (prepare === undefined) {
      return yield* Effect.die('The production Action binding must prepare persisted authority');
    }
    const waiting = yield* prepare(gateInput).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust('21 seconds');
    expect(yield* Fiber.join(waiting)).toMatchObject({ failure: { _tag: 'AccessDecisionUnavailable' } });
    expect(fixture.remoteCalls()).toBe(0);
    return yield* Effect.void;
  }),
);

for (const change of ['revision', 'revocation', 'expiry'] as const) {
  it.effect(`prepared Action authority cannot outlive ${change}`, () =>
    Effect.gen(function* preparedActionRefusal() {
      const fixture = yield* nativeActionBinding();
      const { prepare } = fixture.actionGate;
      if (prepare === undefined) {
        return yield* Effect.die('The production Action binding must prepare persisted authority');
      }
      const prepared = yield* prepare(gateInput);
      expect(prepared.decision.outcome).toBe('ALLOWED');
      const calls = fixture.remoteCalls();
      if (change === 'revision') {
        fixture.advanceRevision();
      }
      if (change === 'revocation') {
        fixture.revoke();
      }
      const outcome = yield* fixture.executor.transaction((transaction) =>
        prepared
          .recheck(change === 'expiry' ? fixture.expireAt : now, transaction)
          .pipe(insideDatabaseTransaction(CAPABILITY), Effect.result),
      );
      if (change === 'revision') {
        expect(outcome).toMatchObject({ failure: { _tag: 'AccessDecisionUnavailable' } });
      } else {
        expect(outcome).toMatchObject({ success: { outcome: 'DENIED' } });
      }
      expect(fixture.remoteCalls()).toBe(calls);
      return yield* Effect.void;
    }),
  );
}

it.effect('a bound decision reads the request authority until a transaction is named, then the joined one', () =>
  Effect.gen(function* explicitJoin() {
    const spec = { cells: [cell({ capability: CAPABILITY })] };
    const request = makeAuthority(spec);
    const joined = makeAuthority(spec);
    const check = makeCheck({ authority: spec });
    const decisionLog = { record: () => Effect.void };
    const legalEntities = { listCandidateIds: () => Effect.succeed([]) };
    const principalKinds = { readKind: () => Effect.succeed(Option.some('human' as const)) };
    const intent: AccessIntentSource = {
      authorityFor: () => request.port,
      joined: () => ({ authorityFor: () => joined.port }),
    };
    const ports: AccessDecisionPorts = {
      authorityFor: intent.authorityFor,
      check: check.port,
      decisionLog,
      legalEntities,
      principalKinds,
    };
    const bound = bindAccessGate(makeAccessDecisionService(ports), {
      candidates: legalEntities,
      check: check.port,
      decisionLog,
      intent,
      principalKinds,
    });

    // Preflight: no transaction is named, so the request authority answers.
    expect((yield* bound.decide(gateInput)).outcome).toBe('ALLOWED');
    const requestReads = request.calls.readScope;
    const requestCellReads = request.calls.readCells;
    expect(requestReads).toBeGreaterThan(0);
    expect(requestCellReads).toBeGreaterThan(0);
    expect(joined.calls.readScope).toBe(0);

    // Owner phase: the named transaction rebinds the gate to the joined authority.
    const executor = yield* makeTestDatabase(scripted([]));
    const ownerDecision = yield* executor.transaction((transaction) => bound.decide(gateInput, transaction));
    expect(ownerDecision.outcome).toBe('ALLOWED');
    expect(joined.calls.readScope).toBeGreaterThan(0);
    expect(joined.calls.readCells).toBeGreaterThan(0);
    const joinedReads = joined.calls.readScope;
    const decideMany = bound.decideMany ?? (() => Effect.die('The bound gate must answer joined batches'));
    const ownerBatch = yield* executor.transaction((transaction) => decideMany([gateInput, gateInput], transaction));
    expect(ownerBatch.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'ALLOWED']);
    expect(joined.calls.readScope).toBeGreaterThan(joinedReads);
    expect(request.calls.readScope).toBe(requestReads);
    expect(request.calls.readCells).toBe(requestCellReads);
  }),
);

it.effect('a joined intent read opens no transaction of its own, while the request read does', () =>
  Effect.gen(function* joinedIntentReads() {
    const statements: string[] = [];
    const executor = yield* makeTestDatabase(scripted(statements));
    const query = { holders: [principalHolder()], tenantId: tenant };

    const requestBefore = statements.length;
    yield* decisionAuthorityOf(
      makeTenantIntentLoader({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor }),
      scope,
    ).readScope(query);
    const requestReads = statements.slice(requestBefore);
    expect(
      requestReads.some((statement) => statement.includes('set transaction isolation level repeatable read')),
    ).toBe(true);

    const ownerReads = yield* executor.transaction((transaction) =>
      Effect.gen(function* readInsideOwner() {
        const before = statements.length;
        yield* decisionAuthorityOf(
          makeJoinedTenantIntentLoader(transaction, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
          scope,
        ).readScope(query);
        return statements.slice(before);
      }),
    );
    // The joined read runs on the caller's snapshot: it neither opens a transaction nor claims an
    // isolation level, which is exactly the statement PostgreSQL refused after the owner fence query.
    expect(ownerReads.some((statement) => statement.includes('set transaction isolation level'))).toBe(false);
    expect(ownerReads.some(opensOwnTransaction)).toBe(false);
  }),
);

it.effect("marks only a joined intent source as reading through a caller's transaction", () =>
  Effect.gen(function* joinedMarker() {
    const executor = yield* makeTestDatabase(scripted([]));
    const loader = makeTenantIntentLoader({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor });
    const intent = yield* Layer.build(
      AccessIntentLive.pipe(Layer.provide(Layer.succeed(TenantIntentLoader, loader))),
    ).pipe(Effect.map(Context.get(AccessIntent)), Effect.scoped);
    // The request source reads on the shared pool and may overlap; the engine serialises the joined one.
    expect(intent.authorityFor(scope).readsThroughCallerTransaction).toBeUndefined();
    yield* executor.transaction((transaction) =>
      Effect.sync(() => {
        expect(intent.joined?.(transaction).authorityFor(scope).readsThroughCallerTransaction).toBe(true);
      }),
    );
  }),
);

it.layer(NodeCrypto.layer)(
  'live actor, evidence, company and workload adapters join the caller transaction',
  (suite) => {
    suite.effect('routes every adapter through the named transaction and opens none', () =>
      Effect.gen(function* joinedAdapters() {
        const crypto = yield* Crypto.Crypto;
        const statements: string[] = [];
        const executor = yield* makeTestDatabase(scripted(statements));
        const principalKinds = makeDrizzleAccessPrincipalKinds({
          enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          executor,
        });
        const decisionLog = makeDrizzleAccessDecisionLog(
          { enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor },
          crypto,
        );
        const candidates = makeDrizzleLegalEntityCandidates({
          enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          executor,
        });
        const workloadBindings = makeDrizzleAccessWorkloadBindings({
          enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          executor,
        });
        const ports: AccessEnforcementPorts = {
          candidates,
          check: { checkBulk: () => Effect.succeed([]) },
          decisionLog,
          intent: {
            authorityFor: () => ({
              readCells: () => Effect.succeed([]),
              readCompanyOwnership: () => Effect.succeed(false),
              readConfigureBases: () => Effect.succeed([]),
              readConnection: () => Effect.succeed(Option.none()),
              readScope: () => Effect.succeed(Option.none()),
              readTeamIds: () => Effect.succeed([]),
            }),
          },
          principalKinds,
          workloadBindings,
        };

        const joinedReads = yield* executor.transaction((transaction) =>
          Effect.gen(function* readInsideOwner() {
            const joined = joinAccessEnforcementPorts(ports, transaction);
            const before = statements.length;
            yield* joined.principalKinds.readKind({ principalId: person, scope, tenantId: tenant });
            yield* joined.decisionLog.record(decisionEntry);
            yield* joined.candidates.listCandidateIds(scope);
            const joinedWorkloads = joined.workloadBindings;
            expect(joinedWorkloads).toBeDefined();
            if (joinedWorkloads !== undefined) {
              // The keys and registered companies join the same transaction, so a prepared Action's recheck reads
              // them from the snapshot its receipt belongs to, never from a second connection (D6, O75).
              yield* joinedWorkloads.readWorkloadAuthority({ principalId: person, scope, tenantId: tenant });
            }
            return statements.slice(before);
          }),
        );

        expect(joinedReads.some((statement) => statement.includes('principals'))).toBe(true);
        expect(joinedReads.some((statement) => statement.includes('access_decision_logs'))).toBe(true);
        expect(joinedReads.some((statement) => statement.includes('legal_entities'))).toBe(true);
        expect(joinedReads.some((statement) => statement.includes('access_workload_bindings'))).toBe(true);
        expect(joinedReads.some((statement) => statement.includes('access_workload_company_bindings'))).toBe(true);
        expect(joinedReads.some(opensOwnTransaction)).toBe(false);

        // Negative control: the same actor adapter with no transaction named opens one of its own.
        const before = statements.length;
        yield* principalKinds.readKind({ principalId: person, scope, tenantId: tenant });
        expect(statements.slice(before).some(opensOwnTransaction)).toBe(true);
      }),
    );
  },
);
