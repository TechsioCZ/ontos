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
    { label: 'Sklad', moduleId: 'warehouse', read: true, write: true },
    { label: 'Účetnictví', moduleId: 'finance', read: true, write: false },
  ],
};

const summary = (overrides: Partial<ConnectionSummary> = {}): ConnectionSummary => ({
  acting: { displayName: 'Agent Sklad', kind: 'agent', principalId: 'agent-1' },
  allModules: false,
  client: { clientId: 'client-a', host: 'claude.ai', kind: 'cimd', logoUri: null, name: 'Claude' },
  createdAt: '2026-10-01T10:00:00.000Z',
  delegatedBy: null,
  grantId: 'grant-1',
  lastUsedAt: null,
  legalEntityId: 'company-a',
  legalName: 'Firma A',
  limits,
  modules: [],
  profileId: 'profile-1',
  revokedAt: null,
  revokeReason: null,
  status: 'active',
  tenantId: 'tenant-1',
  user: { displayName: 'Jana Nováková', principalId: 'person-1' },
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
      { allModules: true, modules: [{ access: 'read', moduleId: 'warehouse' }], writePolicy: 'approval' },
      limits,
    ),
  ).toBe('Při volbě „Vše“ nevybírejte jednotlivé moduly.');
});

it('rejects an empty module list without allModules', () => {
  expect(wideningProblem({ allModules: false, modules: [], writePolicy: 'approval' }, limits)).toBe(
    'Vyberte alespoň jeden modul.',
  );
});

it('rejects a module that is not in the limits', () => {
  expect(
    wideningProblem(
      { allModules: false, modules: [{ access: 'read', moduleId: 'hr' }], writePolicy: 'read_only' },
      limits,
    ),
  ).toBe('Modul hr nemáte k dispozici.');
});

it('rejects a write on a module the caller may only read', () => {
  expect(
    wideningProblem(
      { allModules: false, modules: [{ access: 'write', moduleId: 'finance' }], writePolicy: 'read_only' },
      limits,
    ),
  ).toBe('Do modulu Účetnictví nesmíte zapisovat.');
});

it('rejects a module listed twice', () => {
  expect(
    wideningProblem(
      {
        allModules: false,
        modules: [
          { access: 'read', moduleId: 'warehouse' },
          { access: 'write', moduleId: 'warehouse' },
        ],
        writePolicy: 'read_only',
      },
      limits,
    ),
  ).toBe('Každý modul vyberte jen jednou.');
});

it('rejects a write policy above the maximum', () => {
  expect(
    wideningProblem(
      { allModules: false, modules: [{ access: 'read', moduleId: 'warehouse' }], writePolicy: 'direct' },
      limits,
    ),
  ).toBe('Nejvýš můžete zvolit režim „Ke schválení“.');
});

it('accepts a valid narrowing', () => {
  expect(
    wideningProblem(
      { allModules: false, modules: [{ access: 'read', moduleId: 'finance' }], writePolicy: 'read_only' },
      limits,
    ),
  ).toBe(undefined);
});

it('counts only active connections in the tiles, distinct agents once', () => {
  const stats = adminStats([
    summary({ grantId: 'g1', writePolicy: 'direct' }),
    summary({ grantId: 'g2', writePolicy: 'direct' }),
    summary({ grantId: 'g3', status: 'revoked', writePolicy: 'direct' }),
    summary({
      acting: { displayName: 'Agent Účet', kind: 'agent', principalId: 'agent-2' },
      grantId: 'g4',
      writePolicy: 'approval',
    }),
  ]);
  expect(stats).toEqual({ active: 3, agentsConnected: 2, directWrite: 2 });
});

it('matches only the defined filter fields', () => {
  const connection = summary();
  expect(matchesAdminFilter(connection, {})).toBe(true);
  expect(matchesAdminFilter(connection, { userPrincipalId: 'person-1' })).toBe(true);
  expect(matchesAdminFilter(connection, { userPrincipalId: 'person-2' })).toBe(false);
  expect(matchesAdminFilter(connection, { actingPrincipalId: 'agent-1', clientId: 'client-a' })).toBe(true);
  expect(matchesAdminFilter(connection, { clientId: 'client-b' })).toBe(false);
  expect(matchesAdminFilter(connection, { status: 'revoked' })).toBe(false);
});

it('lists distinct filter options sorted in Czech collation', () => {
  const options = adminFilterOptions([
    summary({ client: { clientId: 'z', host: 'z.test', kind: 'dcr', logoUri: null, name: 'Zeta' } }),
    summary({
      acting: { displayName: 'Agent Účet', kind: 'agent', principalId: 'agent-2' },
      client: { clientId: 'a', host: 'a.test', kind: 'cimd', logoUri: null, name: 'Alfa' },
      grantId: 'g2',
      user: { displayName: 'Čeněk Dvořák', principalId: 'person-2' },
    }),
    summary({ grantId: 'g3' }),
    summary({ grantId: 'g4', user: { displayName: 'Bohumil Černý', principalId: 'person-3' } }),
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
