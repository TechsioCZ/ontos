import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessDecisionLogEntry } from '../../src/access/enforcement/decision-log.ts';
import { makeDrizzleAccessDecisionLog } from '../../src/access/enforcement/decision-log.ts';
import { makeDrizzleAccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import type { AccessDecisionPorts, GateInput } from '../../src/access/enforcement/contract.ts';
import { decisionAuthorityOf } from '../../src/access/enforcement/intent-reader.ts';
import type { AccessIntentSource } from '../../src/access/decision/authority.ts';
import { makeDrizzleLegalEntityCandidates } from '../../src/access/enforcement/legal-entities.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import { makeJoinedTenantIntentLoader, makeTenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import { makeDrizzleAccessWorkloadBindings } from '../../src/access/workloads/bindings.ts';
import { AccessScopeIdSchema } from '../../src/access/ids.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import { bindAccessGate, joinAccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabase } from '../support/database.ts';
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
    yield* decisionAuthorityOf(makeTenantIntentLoader({ executor }), scope).readScope(query);
    const requestReads = statements.slice(requestBefore);
    expect(
      requestReads.some((statement) => statement.includes('set transaction isolation level repeatable read')),
    ).toBe(true);

    const ownerReads = yield* executor.transaction((transaction) =>
      Effect.gen(function* readInsideOwner() {
        const before = statements.length;
        yield* decisionAuthorityOf(makeJoinedTenantIntentLoader(transaction), scope).readScope(query);
        return statements.slice(before);
      }),
    );
    // The joined read runs on the caller's snapshot: it neither opens a transaction nor claims an
    // isolation level, which is exactly the statement PostgreSQL refused after the owner fence query.
    expect(ownerReads.some((statement) => statement.includes('set transaction isolation level'))).toBe(false);
    expect(ownerReads.some(opensOwnTransaction)).toBe(false);
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
        const principalKinds = makeDrizzleAccessPrincipalKinds({ executor });
        const decisionLog = makeDrizzleAccessDecisionLog({ executor }, crypto);
        const candidates = makeDrizzleLegalEntityCandidates({ executor });
        const workloadBindings = makeDrizzleAccessWorkloadBindings({ executor });
        const ports: AccessEnforcementPorts = {
          candidates,
          check: { checkBulk: () => Effect.succeed([]) },
          decisionLog,
          intent: {
            authorityFor: () => ({
              readCells: () => Effect.succeed([]),
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
              yield* joinedWorkloads.readActiveWorkloadKeys({ principalId: person, scope, tenantId: tenant });
            }
            return statements.slice(before);
          }),
        );

        expect(joinedReads.some((statement) => statement.includes('principals'))).toBe(true);
        expect(joinedReads.some((statement) => statement.includes('access_decision_logs'))).toBe(true);
        expect(joinedReads.some((statement) => statement.includes('legal_entities'))).toBe(true);
        expect(joinedReads.some((statement) => statement.includes('access_workload_bindings'))).toBe(true);
        expect(joinedReads.some(opensOwnTransaction)).toBe(false);

        // Negative control: the same actor adapter with no transaction named opens one of its own.
        const before = statements.length;
        yield* principalKinds.readKind({ principalId: person, scope, tenantId: tenant });
        expect(statements.slice(before).some(opensOwnTransaction)).toBe(true);
      }),
    );
  },
);
