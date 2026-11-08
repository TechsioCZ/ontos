import { Clock, DateTime, Effect, Schema } from 'effect';

import {
  AccessOperationIdSchema,
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CatalogSnapshotIdSchema,
  CommandDigestSchema,
  CurrencyCodeSchema,
  DelegationIdSchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type {
  AccessOperationId,
  AssignmentIncarnationId,
  CommandDigest,
  DelegationId,
  PrincipalId,
} from '../../src/access/ids.ts';
import {
  AssignmentSchema,
  CatalogSnapshotEntrySchema,
  CellSchema,
  DelegationSchema,
  RoleRevisionSchema,
  RoleSchema,
} from '../../src/access/model.ts';
import type {
  AmountCeiling,
  Assignment,
  CatalogSnapshotEntry,
  Cell,
  CellSelector,
  DelegatedLimits,
  Delegation,
  Holder,
  LifecycleStatus,
  Role,
  RoleRevision,
} from '../../src/access/model.ts';
import { OwnerRecordSchema, ScopeAdministrationSchema } from '../../src/access/lifecycle/owners.ts';
import type { OwnerRecord, ScopeAdministration } from '../../src/access/lifecycle/owners.ts';
import { InstallationIdSchema, LifecycleRecordIdSchema, TeamIdSchema } from '../../src/access/lifecycle/types.ts';

const ENVELOPE_CAPABILITY = 'finance.invoice.void';
/** Deterministic UUIDs keep every fixture readable and independent of a clock or a database. */
const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const at = (epochMs: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(epochMs));
/** A concrete instant for fixtures that only need a stable, ordered date. */
export const dateAt = (epochMs: number): Date => at(epochMs);

/**
 * Period anchors. They are only ever compared with each other (`validFrom < validUntil`), never with
 * the current time, so a test clock at any epoch keeps them ordered.
 */
export const ELAPSED = at(Date.UTC(2000, 0, 1));
export const FUTURE = at(Date.UTC(2100, 0, 1));
const DAY_MS = 86_400_000;

export interface ClockDates {
  readonly future: Date;
  readonly now: Date;
  readonly past: Date;
}

/** Dates relative to the test clock, for every rule that compares a period with "now". */
export const clockDates: Effect.Effect<ClockDates> = Effect.gen(function* readClockDates() {
  const nowMs = yield* Clock.currentTimeMillis;
  return { future: at(nowMs + DAY_MS), now: at(nowMs), past: at(nowMs - DAY_MS) };
});

export const capabilityKey = Schema.decodeUnknownSync(CapabilityKeySchema);
export const legalEntityId = (n: number) => Schema.decodeUnknownSync(LegalEntityIdSchema)(uuid(n));
export const commandDigest = Schema.decodeUnknownSync(CommandDigestSchema);
export const currency = Schema.decodeUnknownSync(CurrencyCodeSchema);
export const moduleKey = Schema.decodeUnknownSync(ModuleKeySchema);

export const ids = {
  agent: (n: number) => Schema.decodeUnknownSync(AgentIdSchema)(uuid(n)),
  capabilityKey,
  connectionId: (n: number) => Schema.decodeUnknownSync(AgentConnectionIdSchema)(uuid(n)),
  delegationId: (n: number) => Schema.decodeUnknownSync(DelegationIdSchema)(uuid(n)),
  grantIncarnation: (n: number) => Schema.decodeUnknownSync(GrantIncarnationIdSchema)(uuid(n)),
  incarnation: (n: number) => Schema.decodeUnknownSync(AssignmentIncarnationIdSchema)(uuid(n)),
  installationId: (n: number) => Schema.decodeUnknownSync(InstallationIdSchema)(uuid(n)),
  lifecycleRecordId: (n: number) => Schema.decodeUnknownSync(LifecycleRecordIdSchema)(uuid(n)),
  operation: (n: number): AccessOperationId => Schema.decodeUnknownSync(AccessOperationIdSchema)(uuid(n)),
  principal: (n: number) => Schema.decodeUnknownSync(PrincipalIdSchema)(uuid(n)),
  proposalId: (n: number) => Schema.decodeUnknownSync(ProposalIdSchema)(uuid(n)),
  role: (n: number) => Schema.decodeUnknownSync(RoleIdSchema)(uuid(n)),
  roleRevision: (n: number) => Schema.decodeUnknownSync(RoleRevisionIdSchema)(uuid(n)),
  scope: (n: number) => Schema.decodeUnknownSync(AccessScopeIdSchema)(uuid(n)),
  teamId: (n: number) => Schema.decodeUnknownSync(TeamIdSchema)(uuid(n)),
  tenant: (n: number) => Schema.decodeUnknownSync(TenantIdSchema)(uuid(n)),
};

export const person = (n: number): Holder => ({ _tag: 'Principal', principalId: ids.principal(n) });
export const personId = (n: number): PrincipalId => ids.principal(n);
export const digestOf = (seed: string): CommandDigest => commandDigest(seed.repeat(64).slice(0, 64));
export interface CellFixture {
  readonly amountCeiling?: AmountCeiling;
  readonly capabilityKey?: Cell['capabilityKey'];
  readonly mode?: Cell['mode'];
  readonly selector?: CellSelector;
}

export const makeCell = (fixture: CellFixture = {}): Cell => {
  const base = {
    capabilityKey: fixture.capabilityKey ?? capabilityKey(ENVELOPE_CAPABILITY),
    mode: fixture.mode ?? 'run',
    selector: fixture.selector ?? { _tag: 'all' },
  };
  const capped = fixture.amountCeiling === undefined ? base : { ...base, amountCeiling: fixture.amountCeiling };
  return Schema.decodeUnknownSync(CellSchema)(capped);
};

export interface EntryFixture {
  readonly amountInput?: string;
  readonly key?: CatalogSnapshotEntry['key'];
  readonly kind?: CatalogSnapshotEntry['kind'];
  readonly risk?: CatalogSnapshotEntry['risk'];
}

/** One published catalog entry. `amountInput` present means the capability moves money (D10b). */
export const makeEntry = (fixture: EntryFixture = {}): CatalogSnapshotEntry => {
  const key = fixture.key ?? capabilityKey(ENVELOPE_CAPABILITY);
  const base = {
    key,
    kind: fixture.kind ?? 'action',
    modes: ['run', 'propose', 'approve'],
    moduleKey: moduleKey(key.split('.')[0] ?? 'finance'),
    placement: { group: 'finance', level: 'manage' },
    risk: fixture.risk ?? 'critical',
    selectors: ['all'],
  };
  const money = fixture.amountInput === undefined ? base : { ...base, amountInput: fixture.amountInput };
  return Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)(money);
};

export interface AssignmentFixture {
  readonly delegated?: DelegatedLimits;
  readonly holder?: Holder;
  readonly incarnationId?: AssignmentIncarnationId;
  readonly roleId?: ReturnType<typeof ids.role>;
  readonly roleRevisionId?: ReturnType<typeof ids.roleRevision>;
  readonly scopeId?: ReturnType<typeof ids.scope>;
  readonly status?: LifecycleStatus;
  readonly validUntil?: Date;
}

export const makeAssignment = (fixture: AssignmentFixture): Assignment => {
  const base = {
    assignedAt: ELAPSED,
    assignedBy: ids.principal(900),
    holder: fixture.holder ?? person(2),
    incarnationId: fixture.incarnationId ?? ids.incarnation(1),
    roleId: fixture.roleId ?? ids.role(1),
    roleRevisionId: fixture.roleRevisionId ?? ids.roleRevision(1),
    scopeId: fixture.scopeId ?? ids.scope(1),
    status: fixture.status ?? 'active',
    tenantId: ids.tenant(1),
    validFrom: ELAPSED,
  };
  const delegated = fixture.delegated === undefined ? base : { ...base, delegated: fixture.delegated };
  const dated = fixture.validUntil === undefined ? delegated : { ...delegated, validUntil: fixture.validUntil };
  return Schema.decodeUnknownSync(AssignmentSchema)(dated);
};

export interface DelegationFixture {
  readonly amountCeiling?: DelegatedLimits['amountCeiling'];
  readonly capabilityKeys?: Delegation['capabilityKeys'];
  readonly grantedBy?: PrincipalId;
  readonly id?: DelegationId;
  readonly managerId?: PrincipalId;
  readonly people?: Delegation['people'];
  readonly roleIds?: Delegation['roleIds'];
  readonly scopeId?: ReturnType<typeof ids.scope>;
  readonly status?: LifecycleStatus;
  readonly validFrom?: Date;
  readonly validUntil?: Date;
}

export const makeDelegation = (fixture: DelegationFixture = {}): Delegation => {
  const capabilityKeys: Delegation['capabilityKeys'] = fixture.capabilityKeys ?? [capabilityKey(ENVELOPE_CAPABILITY)];
  const people: Delegation['people'] = fixture.people ?? [ids.principal(4), ids.principal(5)];
  const base = {
    capabilityKeys,
    grantedBy: fixture.grantedBy ?? ids.principal(10),
    id: fixture.id ?? ids.delegationId(1),
    managerId: fixture.managerId ?? ids.principal(3),
    people,
    roleIds: fixture.roleIds ?? [ids.role(1)],
    scopeId: fixture.scopeId ?? ids.scope(1),
    status: fixture.status ?? 'active',
    tenantId: ids.tenant(1),
    validFrom: fixture.validFrom ?? ELAPSED,
    validUntil: fixture.validUntil ?? FUTURE,
  };
  const capped = fixture.amountCeiling === undefined ? base : { ...base, amountCeiling: fixture.amountCeiling };
  return Schema.decodeUnknownSync(DelegationSchema)(capped);
};

export interface RoleFixture {
  readonly id?: Role['id'];
  /** Absent means a tenant-wide role; set means a company-local variant (D10). */
  readonly legalEntityId?: NonNullable<Role['legalEntityId']>;
}

export const makeRole = (fixture: RoleFixture = {}): Role => {
  const base = {
    createdAt: ELAPSED,
    createdBy: ids.principal(10),
    id: fixture.id ?? ids.role(1),
    name: 'Finance',
    tenantId: ids.tenant(1),
  };
  const local = fixture.legalEntityId === undefined ? base : { ...base, legalEntityId: fixture.legalEntityId };
  return Schema.decodeUnknownSync(RoleSchema)(local);
};

export interface RoleRevisionFixture {
  readonly cells?: readonly Cell[];
  readonly id?: RoleRevision['id'];
  readonly roleId?: Role['id'];
}

export const makeRoleRevision = (fixture: RoleRevisionFixture = {}): RoleRevision =>
  Schema.decodeUnknownSync(RoleRevisionSchema)({
    catalogSnapshotId: Schema.decodeUnknownSync(CatalogSnapshotIdSchema)(uuid(90)),
    cells: fixture.cells ?? [makeCell()],
    createdAt: ELAPSED,
    createdBy: ids.principal(10),
    id: fixture.id ?? ids.roleRevision(1),
    provenance: 'manual',
    revision: 1,
    roleId: fixture.roleId ?? ids.role(1),
    tenantId: ids.tenant(1),
  });

export interface AdministrationFixture {
  /** `company#access_admin` rows, one entry per scope that has its own administrators. */
  readonly companyAdministrators?: ScopeAdministration['scopeAdministrators'];
  readonly tenantOwners?: ScopeAdministration['tenantOwners'];
  /** The access scope of the tenant itself; scope 1 by default, like every other fixture. */
  readonly tenantScopeId?: ScopeAdministration['tenantScopeId'];
}

/** The administration facts Core reads through the port (O64); a caller never asserts them. */
export const makeAdministration = (fixture: AdministrationFixture = {}): ScopeAdministration =>
  Schema.decodeUnknownSync(ScopeAdministrationSchema)({
    scopeAdministrators: fixture.companyAdministrators ?? [],
    tenantOwners: fixture.tenantOwners ?? [],
    tenantScopeId: fixture.tenantScopeId ?? ids.scope(1),
  });

/** The administrators of one company, shaped for `makeAdministration`. */
export const companyAdministrators = (scopeId: ReturnType<typeof ids.scope>, administrators: OwnerRecord[]) => [
  { administrators, scopeId },
];

export interface OwnerFixture {
  readonly membershipValidUntil?: Date;
  readonly principalId: PrincipalId;
  readonly status?: 'active' | 'suspended';
}

export const ownerRecord = (fixture: OwnerFixture) => {
  const base = { principalId: fixture.principalId, status: fixture.status ?? 'active' };
  const bounded =
    fixture.membershipValidUntil === undefined ? base : { ...base, membershipValidUntil: fixture.membershipValidUntil };
  return Schema.decodeUnknownSync(OwnerRecordSchema)(bounded);
};
