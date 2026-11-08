import { DateTime, Schema } from 'effect';

import type {
  AccessProjectionIntent,
  ModuleInstallationIntent,
  ProjectionPrincipalIntent,
  ScopeProjectionIntent,
  TenantProjectionIntent,
} from '../../src/access/compiler/intent.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  CurrencyCodeSchema,
  DelegationIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  RoleTemplateKeySchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type {
  AccessScopeId,
  AgentConnectionId,
  AgentId,
  AssignmentIncarnationId,
  CapabilityKey,
  CatalogSnapshotId,
  DelegationId,
  LegalEntityId,
  ModuleKey,
  PrincipalId,
  RoleId,
  RoleRevisionId,
  RoleTemplateKey,
  TenantId,
} from '../../src/access/ids.ts';
import { CellSelectorSchema } from '../../src/access/model.ts';
import type {
  AccessRisk,
  AgentConnection,
  AmountCeiling,
  Assignment,
  CatalogSnapshot,
  CatalogSnapshotEntry,
  Cell,
  CellSelector,
  Delegation,
  Holder,
  RoleRevision,
} from '../../src/access/model.ts';

/*
 * Fixtures for the compiler suites. Intent is built as the model types the planner accepts, with
 * every identifier derived from a small number so a failure names the exact record.
 */

export const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

export const tenantId = (value: number): TenantId => Schema.decodeSync(TenantIdSchema)(uuid(value));
export const otherTenantId = (value: number): TenantId => Schema.decodeSync(TenantIdSchema)(uuid(value));
export const legalEntityId = (value: number): LegalEntityId => Schema.decodeSync(LegalEntityIdSchema)(uuid(value));
export const accessScopeId = (value: number): AccessScopeId => Schema.decodeSync(AccessScopeIdSchema)(uuid(value));
export const principalId = (value: number): PrincipalId => Schema.decodeSync(PrincipalIdSchema)(uuid(value));
export const agentId = (value: number): AgentId => Schema.decodeSync(AgentIdSchema)(uuid(value));
export const agentConnectionId = (value: number): AgentConnectionId =>
  Schema.decodeSync(AgentConnectionIdSchema)(uuid(value));
export const roleId = (value: number): RoleId => Schema.decodeSync(RoleIdSchema)(uuid(value));
export const roleRevisionId = (value: number): RoleRevisionId => Schema.decodeSync(RoleRevisionIdSchema)(uuid(value));
export const assignmentIncarnationId = (value: number): AssignmentIncarnationId =>
  Schema.decodeSync(AssignmentIncarnationIdSchema)(uuid(value));
export const delegationId = (value: number): DelegationId => Schema.decodeSync(DelegationIdSchema)(uuid(value));
export const catalogSnapshotId = (value: number): CatalogSnapshotId =>
  Schema.decodeSync(CatalogSnapshotIdSchema)(uuid(value));
export const capabilityKey = (value: string): CapabilityKey => Schema.decodeSync(CapabilityKeySchema)(value);
export const templateKey = (value: string): RoleTemplateKey => Schema.decodeSync(RoleTemplateKeySchema)(value);
export const moduleKey = (value: string): ModuleKey => Schema.decodeSync(ModuleKeySchema)(value);

export const AT = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'));
export const UNTIL = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00.000Z'));
export const UNTIL_LATER = DateTime.toDateUtc(DateTime.makeUnsafe('2031-01-01T00:00:00.000Z'));

export const TENANT = tenantId(1);
export const ENTITY = legalEntityId(2);
export const SCOPE = accessScopeId(3);
export const OTHER_SCOPE = accessScopeId(4);
export const ALICE = principalId(10);
export const BOB = principalId(11);
export const ADMIN = principalId(12);
export const AGENT = agentId(20);
export const ROLE = roleId(30);
export const REVISION = roleRevisionId(31);
export const NEXT_REVISION = roleRevisionId(32);
export const OTHER_ROLE = roleId(33);
export const ASSIGNMENT = assignmentIncarnationId(40);
export const SECOND_ASSIGNMENT = assignmentIncarnationId(41);
export const DELEGATION = delegationId(50);
export const CONNECTION = agentConnectionId(60);
export const SNAPSHOT = catalogSnapshotId(70);
export const MODULE = moduleKey('party.registry');
export const OTHER_MODULE = moduleKey('commerce.catalog');
export const PREFIX_MODULE = moduleKey('party');
export const CAP_PAY = capabilityKey('party.registry.party.pay');
export const CAP_NOTE = capabilityKey('party.registry.party.add-note');
export const CAP_MARGINS = capabilityKey('party.registry.party.read-margins');
export const CAP_OTHER_MODULE = capabilityKey('commerce.catalog.product.publish');

export const human = (principal: PrincipalId): Holder => ({ _tag: 'Principal', principalId: principal });
export const agentHolder = (agent: AgentId): Holder => ({ _tag: 'Agent', agentId: agent });

/** One installed module, named by its own key and never by a capability key prefix. */
export const installation = (module: ModuleKey): ModuleInstallationIntent => ({ moduleKey: module });

export const cell = (
  defaults: Pick<Cell, 'capabilityKey' | 'mode'> & Partial<Pick<Cell, 'amountCeiling' | 'selector'>>,
): Cell => ({ selector: { _tag: 'all' }, ...defaults });

export const ceiling = (limitMinor: number, currency = 'CZK'): AmountCeiling => ({
  currency: Schema.decodeSync(CurrencyCodeSchema)(currency),
  limitMinor,
});

export const revision = (overrides: Partial<RoleRevision> = {}): RoleRevision => ({
  catalogSnapshotId: SNAPSHOT,
  cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' })],
  createdAt: AT,
  createdBy: ADMIN,
  id: REVISION,
  provenance: 'manual',
  revision: 1,
  roleId: ROLE,
  tenantId: TENANT,
  ...overrides,
});

export const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  assignedAt: AT,
  assignedBy: ADMIN,
  holder: human(ALICE),
  incarnationId: ASSIGNMENT,
  roleId: ROLE,
  roleRevisionId: REVISION,
  scopeId: SCOPE,
  status: 'active',
  tenantId: TENANT,
  validFrom: AT,
  ...overrides,
});

export const delegation = (overrides: Partial<Delegation> = {}): Delegation => ({
  capabilityKeys: [CAP_PAY],
  grantedBy: ADMIN,
  id: DELEGATION,
  managerId: BOB,
  people: [ALICE],
  roleIds: [ROLE],
  scopeId: SCOPE,
  status: 'active',
  tenantId: TENANT,
  validFrom: AT,
  validUntil: UNTIL,
  ...overrides,
});

export const connection = (overrides: Partial<AgentConnection> = {}): AgentConnection => ({
  agentId: AGENT,
  id: CONNECTION,
  principalId: ALICE,
  revision: 1,
  scopeId: SCOPE,
  status: 'active',
  tenantId: TENANT,
  validFrom: AT,
  validUntil: UNTIL,
  ...overrides,
});

/** An explicit target cell, decoded through the model so the fixture cannot invent a shape. */
export const targetsSelector = (recordKeys: readonly string[]): CellSelector =>
  Schema.decodeSync(CellSelectorSchema)({ _tag: 'targets', recordKeys: [recordKeys[0] ?? '', ...recordKeys.slice(1)] });

export const catalogEntry = (
  overrides: Pick<CatalogSnapshotEntry, 'key'> & Partial<Omit<CatalogSnapshotEntry, 'key'>>,
): CatalogSnapshotEntry => ({
  kind: 'action',
  modes: ['run'],
  moduleKey: MODULE,
  placement: { group: 'parties', level: 'basic' },
  risk: 'routine',
  selectors: [],
  ...overrides,
});

export const catalog = (
  entries: readonly CatalogSnapshotEntry[],
  id: CatalogSnapshotId = SNAPSHOT,
): CatalogSnapshot => ({
  digest: Schema.decodeSync(CatalogDigestSchema)('a'.repeat(64)),
  entries,
  id,
  publishedAt: AT,
});

export const scopeIntent = (overrides: Partial<ScopeProjectionIntent> = {}): ScopeProjectionIntent => ({
  assignments: [assignment()],
  connections: [],
  delegations: [],
  installations: [installation(MODULE)],
  roleRevisions: [revision()],
  scope: { id: SCOPE, scope: { _tag: 'LegalEntity', legalEntityId: ENTITY, tenantId: TENANT } },
  ...overrides,
});

export const declaredPrincipal = (
  principal: string,
  kind: ProjectionPrincipalIntent['kind'] = 'human',
): ProjectionPrincipalIntent => ({ kind, principalId: principal });

/** A party action: every mode and every record selector, so a cell may narrow to any of them. */
export const partyEntry = (key: CapabilityKey, risk: AccessRisk = 'routine'): CatalogSnapshotEntry =>
  catalogEntry({
    key,
    modes: ['run', 'propose', 'approve'],
    risk,
    selectors: ['all', 'assigned', 'entrusted', 'team'],
  });

export const catalogEntries = (): readonly CatalogSnapshotEntry[] => [
  // `pay` moves money, so it declares the amount input a delegated ceiling or a role limit bounds.
  { ...partyEntry(CAP_PAY), amountInput: 'payload.amountMinor' },
  partyEntry(CAP_NOTE),
  partyEntry(CAP_MARGINS, 'sensitive'),
  { ...partyEntry(CAP_OTHER_MODULE), moduleKey: OTHER_MODULE },
];

export const tenantIntent = (overrides: Partial<TenantProjectionIntent> = {}): TenantProjectionIntent => ({
  catalogEntries: catalogEntries(),
  coverage: 'complete',
  legalEntities: [
    {
      accessAdmins: [ADMIN],
      legalEntityId: ENTITY,
      members: [{ holder: human(ALICE) }, { holder: human(BOB) }],
      suspended: [],
    },
  ],
  members: [{ holder: human(ADMIN) }, { holder: human(ALICE) }, { holder: human(BOB) }, { holder: agentHolder(AGENT) }],
  owners: [ADMIN],
  principals: [
    declaredPrincipal(ADMIN),
    declaredPrincipal(ALICE),
    declaredPrincipal(BOB),
    declaredPrincipal(AGENT, 'agent'),
  ],
  scopes: [scopeIntent()],
  suspended: [],
  tenantId: TENANT,
  ...overrides,
});

export const projectionIntent = (
  scope: Partial<ScopeProjectionIntent> = {},
  tenant: Partial<TenantProjectionIntent> = {},
): AccessProjectionIntent => ({
  tenants: [tenantIntent({ ...tenant, scopes: tenant.scopes ?? [scopeIntent(scope)] })],
});
