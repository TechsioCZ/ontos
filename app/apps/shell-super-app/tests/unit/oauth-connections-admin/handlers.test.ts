import type {
  AgentWritePolicy,
  ConnectionLimits,
  ConnectionSummary,
  PrincipalRef,
} from '@app/shared-contracts/agent-access';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  CompanyAgent,
  CompanyDirectoryPort,
  ConnectionsAdminDeps,
  ConnectionsCaller,
  GrantAdminPort,
} from '../../../api/oauth-connections-admin/ports.ts';
import {
  agentConnectionsOverview,
  listForAdmin,
  listMine,
  replaceAgentOperators,
  revokeConnection,
  updateConnection,
} from '../../../api/oauth-connections-admin/handlers.ts';

const tenantId = 'tenant-1';
const companyA = { legalEntityId: 'company-a', legalName: 'Firma A' };
const companyB = { legalEntityId: 'company-b', legalName: 'Firma B' };

const limits: ConnectionLimits = {
  maxWritePolicy: 'approval',
  modules: [
    { label: 'Sklad', moduleId: 'warehouse', read: true, write: true },
    { label: 'Účetnictví', moduleId: 'finance', read: true, write: false },
  ],
};

const summary = (overrides: Partial<ConnectionSummary> = {}): ConnectionSummary => ({
  acting: { displayName: 'Agent Sklad', kind: 'agent', principalId: 'agent-1' },
  allModules: false,
  client: { clientId: 'client-a', host: 'claude.ai', kind: 'cimd', logoUri: null, name: 'Claude' },
  createdAt: '2026-10-01T10:00:00.000Z',
  delegatedBy: { displayName: 'Jana Nováková', principalId: 'person-1' },
  grantId: 'g1',
  granted: {
    modules: [
      { access: 'write', moduleId: 'warehouse' },
      { access: 'read', moduleId: 'finance' },
    ],
    writePolicy: 'approval',
  },
  lastUsedAt: null,
  legalEntityId: companyA.legalEntityId,
  legalName: companyA.legalName,
  limits,
  modules: [],
  profileId: 'profile-1',
  revokedAt: null,
  revokeNote: null,
  revokeReason: null,
  status: 'active',
  tenantId,
  user: { displayName: 'Jana Nováková', principalId: 'person-1' },
  writePolicy: 'approval',
  ...overrides,
});

type Person = PrincipalRef & { readonly legalEntityId: string };
type Agent = CompanyAgent & { readonly legalEntityId: string };

interface Fixture {
  readonly agents: Agent[];
  readonly connections: ConnectionSummary[];
  readonly operators: Record<string, string[]>;
  readonly people: Person[];
}

const caller = (overrides: Partial<ConnectionsCaller>): ConnectionsCaller => ({
  isCompanyAdmin: false,
  legalEntityId: companyA.legalEntityId,
  legalName: companyA.legalName,
  principalId: 'person-1',
  tenantId,
  ...overrides,
});

const fixture = (): Fixture => ({
  agents: [
    {
      description: null,
      displayName: 'Agent Sklad',
      legalEntityId: companyA.legalEntityId,
      modules: [{ access: 'read', moduleId: 'warehouse' }],
      ownerPrincipalId: null,
      principalId: 'agent-1',
      seeded: false,
      status: 'active',
      writePolicy: 'approval',
    },
    {
      description: null,
      displayName: 'Agent Účet',
      legalEntityId: companyA.legalEntityId,
      modules: [{ access: 'read', moduleId: 'finance' }],
      ownerPrincipalId: null,
      principalId: 'agent-2',
      seeded: true,
      status: 'active',
      writePolicy: 'direct',
    },
    {
      description: null,
      displayName: 'Agent B',
      legalEntityId: companyB.legalEntityId,
      modules: [],
      ownerPrincipalId: null,
      principalId: 'agent-b',
      seeded: false,
      status: 'active',
      writePolicy: 'read_only',
    },
  ],
  connections: [
    summary({ grantId: 'g1' }),
    summary({ grantId: 'g2', revokedAt: '2026-10-02T10:00:00.000Z', status: 'revoked' }),
    summary({
      acting: { displayName: 'Agent Účet', kind: 'agent', principalId: 'agent-2' },
      delegatedBy: { displayName: 'Petr Svoboda', principalId: 'person-2' },
      grantId: 'g3',
      user: { displayName: 'Petr Svoboda', principalId: 'person-2' },
      writePolicy: 'direct',
    }),
    summary({
      grantId: 'g4',
      legalEntityId: companyB.legalEntityId,
      legalName: companyB.legalName,
      user: { displayName: 'Karel Černý', principalId: 'person-3' },
    }),
  ],
  operators: { 'agent-1': ['person-1'], 'agent-2': [] },
  people: [
    { displayName: 'Jana Nováková', legalEntityId: companyA.legalEntityId, principalId: 'person-1' },
    { displayName: 'Petr Svoboda', legalEntityId: companyA.legalEntityId, principalId: 'person-2' },
    { displayName: 'Karel Černý', legalEntityId: companyB.legalEntityId, principalId: 'person-3' },
  ],
});

const makeDeps = (state: Fixture) => {
  const calls = {
    operatorReplacements: [] as Parameters<CompanyDirectoryPort<never>['replaceOperators']>[0][],
    revokes: [] as Parameters<GrantAdminPort<never>['revoke']>[0][],
    updates: [] as Parameters<GrantAdminPort<never>['update']>[0][],
  };
  const directory: CompanyDirectoryPort<never> = {
    agents: (_tenant, legalEntityId) =>
      Effect.succeed(state.agents.filter((agent) => agent.legalEntityId === legalEntityId)),
    operatorsOf: (agentPrincipalId) => Effect.succeed(state.operators[agentPrincipalId] ?? []),
    people: (_tenant, legalEntityId) =>
      Effect.succeed(
        state.people
          .filter((person) => person.legalEntityId === legalEntityId)
          .map(({ displayName, principalId }) => ({ displayName, principalId })),
      ),
    replaceOperators: (input) => {
      calls.operatorReplacements.push(input);
      state.operators[input.agentPrincipalId] = [...input.operatorPrincipalIds];
      return Effect.void;
    },
  };
  const grants: GrantAdminPort<never> = {
    get: (grantId) => Effect.succeed(state.connections.find((connection) => connection.grantId === grantId)),
    list: (filter) =>
      Effect.succeed(
        state.connections.filter(
          (connection) =>
            connection.tenantId === filter.tenantId &&
            filter.statuses.includes(connection.status) &&
            (filter.legalEntityId === undefined || connection.legalEntityId === filter.legalEntityId) &&
            (filter.userPrincipalId === undefined || connection.user.principalId === filter.userPrincipalId) &&
            (filter.actingPrincipalId === undefined || connection.acting.principalId === filter.actingPrincipalId),
        ),
      ),
    revoke: (input) => {
      calls.revokes.push(input);
      return Effect.void;
    },
    update: (input) => {
      calls.updates.push(input);
      return Effect.void;
    },
  };
  const deps: ConnectionsAdminDeps<never> = {
    directory,
    grants,
    mcpUrl: 'http://localhost:3090/mcp',
  };
  return { calls, deps };
};

const narrowing = (overrides: Partial<Parameters<typeof updateConnection>[2]> = {}) => ({
  allModules: false,
  grantId: 'g1',
  modules: [{ access: 'read' as const, moduleId: 'warehouse' }],
  writePolicy: 'read_only' as AgentWritePolicy,
  ...overrides,
});

it.effect('lists only the caller active connections with the MCP URL', () =>
  Effect.gen(function* listMineTest() {
    const { deps } = makeDeps(fixture());
    const response = yield* listMine(caller({}), deps);
    expect(response.connections.map((connection) => connection.grantId)).toEqual(['g1']);
    expect(response.mcpUrl).toBe('http://localhost:3090/mcp');
  }),
);

it.effect('refuses the company list to a person who is not a company admin', () =>
  Effect.gen(function* forbiddenListTest() {
    const { deps } = makeDeps(fixture());
    const error = yield* Effect.flip(listForAdmin(caller({}), deps, { filter: {} }));
    expect(error._tag).toBe('ConnectionsForbidden');
  }),
);

it.effect('filters the company list and counts the active tiles', () =>
  Effect.gen(function* adminListTest() {
    const { deps } = makeDeps(fixture());
    const response = yield* listForAdmin(caller({ isCompanyAdmin: true }), deps, { filter: { status: 'active' } });
    expect(response.company).toEqual(companyA);
    expect(response.connections.map((connection) => connection.grantId)).toEqual(['g1', 'g3']);
    expect(response.stats).toEqual({ active: 2, agentsConnected: 2, directWrite: 1 });
    expect(response.filterOptions.people.map((person) => person.principalId)).toEqual(['person-1', 'person-2']);
  }),
);

it.effect('rejects a write on a module the connection may only read', () =>
  Effect.gen(function* readOnlyModuleTest() {
    const state = fixture();
    const { calls, deps } = makeDeps(state);
    const error = yield* Effect.flip(
      updateConnection(caller({}), deps, narrowing({ modules: [{ access: 'write', moduleId: 'finance' }] })),
    );
    expect(error._tag).toBe('ConnectionsInvalid');
    expect(calls.updates.length).toBe(0);
  }),
);

it.effect('rejects a write policy above the connection maximum', () =>
  Effect.gen(function* policyAboveMaxTest() {
    const { calls, deps } = makeDeps(fixture());
    const error = yield* Effect.flip(updateConnection(caller({}), deps, narrowing({ writePolicy: 'direct' })));
    expect(error._tag).toBe('ConnectionsInvalid');
    expect(calls.updates.length).toBe(0);
  }),
);

it.effect('refuses to update a connection of another person', () =>
  Effect.gen(function* otherPersonUpdateTest() {
    const { calls, deps } = makeDeps(fixture());
    const error = yield* Effect.flip(updateConnection(caller({ principalId: 'person-2' }), deps, narrowing()));
    expect(error._tag).toBe('ConnectionsForbidden');
    expect(calls.updates.length).toBe(0);
  }),
);

it.effect('keeps "Vše" when the connection was approved for everything', () =>
  Effect.gen(function* allModulesKeptTest() {
    const state = fixture();
    state.connections[0] = summary({ allModules: true, granted: { modules: [], writePolicy: 'approval' } });
    const { calls, deps } = makeDeps(state);
    const response = yield* updateConnection(
      caller({}),
      deps,
      narrowing({ allModules: true, modules: [], writePolicy: 'read_only' }),
    );
    expect(response).toEqual({ grantId: 'g1', status: 'active' });
    expect(calls.updates.length).toBe(1);
    expect(calls.updates[0]?.modules).toBe('all');
    expect(calls.updates[0]?.writePolicy).toBe('read_only');
  }),
);

it.effect('refuses to widen a connection beyond what was approved, even within live rights', () =>
  Effect.gen(function* wideningTest() {
    const state = fixture();
    state.connections[0] = summary({
      granted: { modules: [{ access: 'read', moduleId: 'warehouse' }], writePolicy: 'read_only' },
    });
    const { calls, deps } = makeDeps(state);
    const attempts = [
      narrowing({ writePolicy: 'approval' }),
      narrowing({ allModules: true, modules: [] }),
      narrowing({ modules: [{ access: 'write', moduleId: 'warehouse' }] }),
      narrowing({ modules: [{ access: 'read', moduleId: 'finance' }] }),
    ];
    for (const attempt of attempts) {
      const error = yield* Effect.flip(updateConnection(caller({}), deps, attempt));
      expect(error._tag).toBe('ConnectionsInvalid');
    }
    expect(calls.updates.length).toBe(0);
    yield* updateConnection(caller({}), deps, narrowing());
    expect(calls.updates.length).toBe(1);
  }),
);

it.effect('answers a stale update or revoke with ConnectionsGone', () =>
  Effect.gen(function* staleTest() {
    const { calls, deps } = makeDeps(fixture());
    const update = yield* Effect.flip(updateConnection(caller({}), deps, narrowing({ grantId: 'g2' })));
    expect(update._tag).toBe('ConnectionsGone');
    const revoke = yield* Effect.flip(revokeConnection(caller({}), deps, { grantId: 'g2' }));
    expect(revoke._tag).toBe('ConnectionsGone');
    expect(calls.updates.length + calls.revokes.length).toBe(0);
  }),
);

it.effect('rejects an over-long revoke reason and an unknown status filter with Czech messages', () =>
  Effect.gen(function* validationTest() {
    const { calls, deps } = makeDeps(fixture());
    const long = yield* Effect.flip(revokeConnection(caller({}), deps, { grantId: 'g1', reason: 'x'.repeat(501) }));
    expect(long._tag).toBe('ConnectionsInvalid');
    expect(calls.revokes.length).toBe(0);
    const status = yield* Effect.flip(
      listForAdmin(caller({ isCompanyAdmin: true }), deps, { filter: { status: 'draft' } }),
    );
    expect(status._tag).toBe('ConnectionsInvalid');
  }),
);

it.effect('keeps a company B admin from revoking a company A connection', () =>
  Effect.gen(function* crossCompanyRevokeTest() {
    const { calls, deps } = makeDeps(fixture());
    const error = yield* Effect.flip(
      revokeConnection(
        caller({
          isCompanyAdmin: true,
          legalEntityId: companyB.legalEntityId,
          legalName: companyB.legalName,
          principalId: 'person-3',
        }),
        deps,
        { grantId: 'g1', reason: 'Odebrání přístupu' },
      ),
    );
    expect(error._tag).toBe('ConnectionsForbidden');
    expect(calls.revokes.length).toBe(0);
  }),
);

it.effect('requires a reason when an admin revokes someone else connection', () =>
  Effect.gen(function* adminReasonTest() {
    const state = fixture();
    const { calls, deps } = makeDeps(state);
    const error = yield* Effect.flip(
      revokeConnection(caller({ isCompanyAdmin: true, principalId: 'person-4' }), deps, { grantId: 'g3' }),
    );
    expect(error._tag).toBe('ConnectionsInvalid');
    expect(calls.revokes.length).toBe(0);

    const response = yield* revokeConnection(caller({ isCompanyAdmin: true, principalId: 'person-4' }), deps, {
      grantId: 'g3',
      reason: '  Odchod z firmy  ',
    });
    expect(response).toEqual({ grantId: 'g3', status: 'revoked' });
    expect(calls.revokes[0]?.reasonCode).toBe('admin');
    expect(calls.revokes[0]?.reasonText).toBe('Odchod z firmy');
  }),
);

it.effect('records a self-service revoke as reason user', () =>
  Effect.gen(function* ownerRevokeTest() {
    const { calls, deps } = makeDeps(fixture());
    const response = yield* revokeConnection(caller({}), deps, { grantId: 'g1', reason: 'user' });
    expect(response).toEqual({ grantId: 'g1', status: 'revoked' });
    expect(calls.revokes[0]?.reasonCode).toBe('user');
    expect(calls.revokes[0]?.reasonText).toBe(null);
  }),
);

it.effect('refuses operator changes to a person who is not a company admin', () =>
  Effect.gen(function* operatorForbiddenTest() {
    const { deps } = makeDeps(fixture());
    const error = yield* Effect.flip(
      replaceAgentOperators(caller({}), deps, { agentPrincipalId: 'agent-1', operatorPrincipalIds: [] }),
    );
    expect(error._tag).toBe('ConnectionsForbidden');
  }),
);

it.effect('does not find an agent of another company', () =>
  Effect.gen(function* operatorAgentNotFoundTest() {
    const { deps } = makeDeps(fixture());
    const error = yield* Effect.flip(
      replaceAgentOperators(caller({ isCompanyAdmin: true }), deps, {
        agentPrincipalId: 'agent-b',
        operatorPrincipalIds: [],
      }),
    );
    expect(error._tag).toBe('ConnectionsNotFound');
  }),
);

it.effect('rejects an operator from another company', () =>
  Effect.gen(function* foreignOperatorTest() {
    const { deps } = makeDeps(fixture());
    const error = yield* Effect.flip(
      replaceAgentOperators(caller({ isCompanyAdmin: true }), deps, {
        agentPrincipalId: 'agent-1',
        operatorPrincipalIds: ['person-3'],
      }),
    );
    expect(error._tag).toBe('ConnectionsInvalid');
  }),
);

it.effect('revokes the delegated connection of a removed operator', () =>
  Effect.gen(function* removedOperatorTest() {
    const { calls, deps } = makeDeps(fixture());
    const response = yield* replaceAgentOperators(caller({ isCompanyAdmin: true }), deps, {
      agentPrincipalId: 'agent-1',
      operatorPrincipalIds: ['person-2', 'person-2'],
    });
    expect(response.operators.map((person) => person.principalId)).toEqual(['person-2']);
    expect(response.revokedConnections).toBe(1);
    expect(calls.revokes.map((revoke) => [revoke.grantId, revoke.reasonCode])).toEqual([['g1', 'operator_removed']]);
    expect(calls.operatorReplacements[0]?.operatorPrincipalIds).toEqual(['person-2']);
  }),
);

it.effect('maps operators and active connections onto each agent', () =>
  Effect.gen(function* overviewTest() {
    const { deps } = makeDeps(fixture());
    const overview = yield* agentConnectionsOverview(caller({ isCompanyAdmin: true }), deps);
    expect(overview.company).toEqual(companyA);
    expect(overview.members.map((person) => person.principalId)).toEqual(['person-1', 'person-2']);
    expect(overview.agents.map((agent) => agent.principalId)).toEqual(['agent-1', 'agent-2']);
    const [sklad, ucet] = overview.agents;
    expect(sklad?.operators.map((person) => person.displayName)).toEqual(['Jana Nováková']);
    expect(sklad?.connections.map((connection) => connection.grantId)).toEqual(['g1']);
    expect(ucet?.operators).toEqual([]);
    expect(ucet?.connections.map((connection) => connection.grantId)).toEqual(['g3']);
  }),
);
