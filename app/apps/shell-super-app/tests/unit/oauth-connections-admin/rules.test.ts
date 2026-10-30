import {
  AgentAccessClientIdSchema,
  AgentAccessGrantIdSchema,
  ConnectionSummarySchema,
} from '@app/shared-contracts/agent-access';
import { AgentModuleKeySchema, AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { Schema } from 'effect';
import type { ConnectionLimits, ConnectionSummary } from '@app/shared-contracts/agent-access';
import { expect, it } from 'effect-rstest';

import {
  adminFilterOptions,
  adminStats,
  matchesAdminFilter,
  policyRank,
  uniqueIds,
  wideningProblem,
  writePolicyLabel,
} from '../../../api/oauth-connections-admin/rules.ts';

const limits: ConnectionLimits = {
  maxWritePolicy: 'approval',
  modules: [
    { label: 'Sklad', moduleId: AgentModuleKeySchema.make('warehouse'), read: true, write: true },
    { label: 'Účetnictví', moduleId: AgentModuleKeySchema.make('finance'), read: true, write: false },
  ],
};

/** A connection approved for everything with direct writes, so only the live limits constrain it. */
const approvedAll = { allModules: true, granted: { modules: [], writePolicy: 'direct' as const }, limits };

const summary = (overrides: Partial<typeof ConnectionSummarySchema.Encoded> = {}): ConnectionSummary =>
  Schema.decodeUnknownSync(ConnectionSummarySchema)({
    acting: { displayName: 'Agent Sklad', kind: 'agent', principalId: AgentPrincipalIdSchema.make('agent-1') },
    allModules: false,
    client: {
      clientId: AgentAccessClientIdSchema.make('client-a'),
      host: 'claude.ai',
      kind: 'cimd',
      logoUri: null,
      name: 'Claude',
    },
    createdAt: '2026-10-01T10:00:00.000Z',
    delegatedBy: null,
    granted: { modules: [], writePolicy: 'direct' },
    grantId: AgentAccessGrantIdSchema.make('grant-1'),
    lastUsedAt: null,
    legalEntityId: 'company-a',
    legalName: 'Firma A',
    limits,
    modules: [],
    profileId: 'profile-1',
    revokedAt: null,
    revokeNote: null,
    revokeReason: null,
    status: 'active',
    tenantId: 'tenant-1',
    user: { displayName: 'Jana Nováková', principalId: AgentPrincipalIdSchema.make('person-1') },
    writePolicy: 'approval',
    ...overrides,
  });

it('orders write policies from strictest to loosest', () => {
  expect(policyRank('read_only')).toBe(0);
  expect(policyRank('approval')).toBe(1);
  expect(policyRank('direct')).toBe(2);
  expect(writePolicyLabel.direct).toBe('Přímo');
});

it('rejects allModules combined with explicit modules', () => {
  expect(
    wideningProblem(
      {
        allModules: true,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('warehouse') }],
        writePolicy: 'approval',
      },
      approvedAll,
    ),
  ).toBe('Při volbě „Vše“ nevybírejte jednotlivé moduly.');
});

it('rejects an empty module list without allModules', () => {
  expect(wideningProblem({ allModules: false, modules: [], writePolicy: 'approval' }, approvedAll)).toBe(
    'Vyberte alespoň jeden modul.',
  );
});

it('rejects a module that is not in the limits', () => {
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('hr') }],
        writePolicy: 'read_only',
      },
      approvedAll,
    ),
  ).toBe('Modul hr nemáte k dispozici.');
});

it('rejects a write on a module the caller may only read', () => {
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [{ access: 'write', moduleId: AgentModuleKeySchema.make('finance') }],
        writePolicy: 'read_only',
      },
      approvedAll,
    ),
  ).toBe('Do modulu Účetnictví nesmíte zapisovat.');
});

it('rejects a module listed twice', () => {
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [
          { access: 'read', moduleId: AgentModuleKeySchema.make('warehouse') },
          { access: 'write', moduleId: AgentModuleKeySchema.make('warehouse') },
        ],
        writePolicy: 'read_only',
      },
      approvedAll,
    ),
  ).toBe('Každý modul vyberte jen jednou.');
});

it('rejects a write policy above the maximum', () => {
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('warehouse') }],
        writePolicy: 'direct',
      },
      approvedAll,
    ),
  ).toBe('Nejvýš můžete zvolit režim „Ke schválení“.');
});

it('accepts a valid narrowing', () => {
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('finance') }],
        writePolicy: 'read_only',
      },
      approvedAll,
    ),
  ).toBe(undefined);
});

it('refuses to widen beyond the approved grant', () => {
  const approved = {
    allModules: false,
    granted: {
      modules: [{ access: 'read' as const, moduleId: AgentModuleKeySchema.make('warehouse') }],
      writePolicy: 'read_only' as const,
    },
    limits,
  };
  const widen = 'Přístup můžete jen zúžit. Pro větší přístup aplikaci odpojte a připojte znovu.';
  expect(wideningProblem({ allModules: true, modules: [], writePolicy: 'read_only' }, approved)).toBe(widen);
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('warehouse') }],
        writePolicy: 'approval',
      },
      approved,
    ),
  ).toBe(widen);
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [{ access: 'write', moduleId: AgentModuleKeySchema.make('warehouse') }],
        writePolicy: 'read_only',
      },
      approved,
    ),
  ).toBe(widen);
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('finance') }],
        writePolicy: 'read_only',
      },
      approved,
    ),
  ).toBe(widen);
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [{ access: 'read', moduleId: AgentModuleKeySchema.make('warehouse') }],
        writePolicy: 'read_only',
      },
      approved,
    ),
  ).toBe(undefined);
});

it('counts only active connections in the tiles, distinct agents once', () => {
  const stats = adminStats([
    summary({ grantId: AgentAccessGrantIdSchema.make('g1'), writePolicy: 'direct' }),
    summary({ grantId: AgentAccessGrantIdSchema.make('g2'), writePolicy: 'direct' }),
    summary({ grantId: AgentAccessGrantIdSchema.make('g3'), status: 'revoked', writePolicy: 'direct' }),
    summary({
      acting: { displayName: 'Agent Účet', kind: 'agent', principalId: AgentPrincipalIdSchema.make('agent-2') },
      grantId: AgentAccessGrantIdSchema.make('g4'),
      writePolicy: 'approval',
    }),
  ]);
  expect(stats).toEqual({ active: 3, agentsConnected: 2, directWrite: 2 });
});

it('matches only the defined filter fields', () => {
  const connection = summary();
  expect(matchesAdminFilter(connection, {})).toBe(true);
  expect(matchesAdminFilter(connection, { userPrincipalId: AgentPrincipalIdSchema.make('person-1') })).toBe(true);
  expect(matchesAdminFilter(connection, { userPrincipalId: AgentPrincipalIdSchema.make('person-2') })).toBe(false);
  expect(
    matchesAdminFilter(connection, {
      actingPrincipalId: AgentPrincipalIdSchema.make('agent-1'),
      clientId: AgentAccessClientIdSchema.make('client-a'),
    }),
  ).toBe(true);
  expect(matchesAdminFilter(connection, { clientId: AgentAccessClientIdSchema.make('client-b') })).toBe(false);
  expect(matchesAdminFilter(connection, { status: 'revoked' })).toBe(false);
});

it('lists distinct filter options sorted in Czech collation', () => {
  const options = adminFilterOptions([
    summary({
      client: {
        clientId: AgentAccessClientIdSchema.make('z'),
        host: 'z.test',
        kind: 'dcr',
        logoUri: null,
        name: 'Zeta',
      },
    }),
    summary({
      acting: { displayName: 'Agent Účet', kind: 'agent', principalId: AgentPrincipalIdSchema.make('agent-2') },
      client: {
        clientId: AgentAccessClientIdSchema.make('a'),
        host: 'a.test',
        kind: 'cimd',
        logoUri: null,
        name: 'Alfa',
      },
      grantId: AgentAccessGrantIdSchema.make('g2'),
      user: { displayName: 'Čeněk Dvořák', principalId: AgentPrincipalIdSchema.make('person-2') },
    }),
    summary({ grantId: AgentAccessGrantIdSchema.make('g3') }),
    summary({
      grantId: AgentAccessGrantIdSchema.make('g4'),
      user: { displayName: 'Bohumil Černý', principalId: AgentPrincipalIdSchema.make('person-3') },
    }),
  ]);
  expect(options.people.map((person) => person.displayName)).toEqual([
    'Bohumil Černý',
    'Čeněk Dvořák',
    'Jana Nováková',
  ]);
  expect(options.agents.map((agent) => agent.principalId)).toEqual(['agent-1', 'agent-2']);
  expect(options.clients.map((client) => client.name)).toEqual(['Alfa', 'Claude', 'Zeta']);
});

it('keeps the first occurrence of each id in order', () => {
  expect(uniqueIds(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
});
