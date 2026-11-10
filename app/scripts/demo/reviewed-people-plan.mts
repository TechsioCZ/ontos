/**
 * The reviewed roles of Obchodní firma's three role accounts, as one pure plan against what the stage Shell
 * answers. `stage-reviewed-people.mts` reads the state over HTTP, asks this module for the ordered list of
 * writes, and sends them one at a time. Every decision lives here, so a unit test can pin it.
 *
 * The plan is limited to hard constants: one tenant, one company (Nájempark and every other company are out
 * of reach), exactly three people and exactly four roles whose ids are derived from fixed idempotency keys.
 * A planned write that names anything else is refused before it is returned, and again before it is sent.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { DateTime, Match, Option, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { stableUuid } from '@app/core-runtime/access/catalog';
import { isDangerousCell, roleCellEffect } from '@app/core-runtime/access/changes/role-revision';

import {
  AccessAssignmentIdSchema,
  AccessCapabilityKeySchema,
  AccessCatalogSnapshotIdSchema,
  AccessCompanyIdSchema,
  AccessHumanIdSchema,
  AccessPeopleRevisionSchema,
  AccessRoleIdSchema,
  AccessRoleRevisionIdSchema,
  AccessScopeTargetSchema,
} from '../../apps/shell-super-app/shared/access-admin-api.ts';
import { CapabilityKeySchema } from '../../packages/core-runtime/src/access/ids.ts';
import type { CatalogSnapshotEntry, Cell } from '../../packages/core-runtime/src/access/model.ts';
import {
  AccessKindSchema,
  AccessModeSchema,
  AccessRiskSchema,
  cellSlotKey,
  RecordSelectorSchema,
} from '../../packages/core-runtime/src/access/model.ts';
import { policyRoleCellRows } from './access-policy.mts';
import { demoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { demoHumanAccounts, demoShellRoutingRoleKey, reviewedDemoAssignments } from './permissions.mts';

export type HumanId = typeof AccessHumanIdSchema.Type;
export type RoleId = typeof AccessRoleIdSchema.Type;
export type RoleRevisionId = typeof AccessRoleRevisionIdSchema.Type;
export type AssignmentId = typeof AccessAssignmentIdSchema.Type;
export type CatalogSnapshotId = typeof AccessCatalogSnapshotIdSchema.Type;
export type CompanyId = typeof AccessCompanyIdSchema.Type;
export type PeopleRevision = typeof AccessPeopleRevisionSchema.Type;
export type ScopeTarget = typeof AccessScopeTargetSchema.Type;

/** The key a write is sent with; the Shell names the rows it writes after it. */
export const IdempotencyKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('ReviewedPeopleIdempotencyKey'),
);
export type IdempotencyKey = typeof IdempotencyKeySchema.Type;

export const TENANT_ID = '70000000-0000-4000-8000-000000000020';
export const COMPANY_ID: CompanyId = AccessCompanyIdSchema.make('71000000-0000-4000-8000-000000000020');
/** Obchodník, Účetní and Skladník of Obchodní firma; nobody else is ever named by a write. */
export const PRINCIPAL_IDS: readonly HumanId[] = [
  '2bdc200d-ad86-5101-b48f-a52339718354',
  '4f94471b-1d15-5aa9-a836-c87e0f8a449d',
  '3952547a-564f-5468-9038-8dce11185c44',
].map((principalId) => AccessHumanIdSchema.make(principalId));
export const MANAGED_ROLE_KEYS = ['sales', 'accounting', 'warehouse', demoShellRoutingRoleKey] as const;
export const ManagedRoleKeySchema = Schema.Literals(MANAGED_ROLE_KEYS);
export type ManagedRoleKey = typeof ManagedRoleKeySchema.Type;

export const TENANT_SCOPE: ScopeTarget = { kind: 'tenant' };
export const COMPANY_SCOPE: ScopeTarget = { kind: 'company', legalEntityId: COMPANY_ID };

/** The reason every revoke and end carries (the Shell requires one, 1..500 characters). */
export const ROLLBACK_REASON = 'Vrácení ukázkového nastavení rolí Obchodní firmy';

// --- identities named by fixed idempotency keys -------------------------------------------------------

const digest = (text: string): string => Hex.encode(sha256(utf8ToBytes(text)));
const keyOf = (text: string): IdempotencyKey => IdempotencyKeySchema.make(text);

export const roleCreateKey = (roleKey: ManagedRoleKey): IdempotencyKey =>
  keyOf(`ontos-demo-reviewed-role:v1:${roleKey}`);
/** The Shell names a created role by its idempotency key (roles.ts targetIds). */
export const roleIdOf = (roleKey: ManagedRoleKey): RoleId =>
  AccessRoleIdSchema.make(stableUuid(['ontos.shell.access-roles.role', TENANT_ID, roleCreateKey(roleKey)].join(':')));
export const MANAGED_ROLE_IDS: readonly RoleId[] = MANAGED_ROLE_KEYS.map(roleIdOf);

/**
 * One key per generation: a key names the rows it writes, so after a rollback the same key would name the
 * revoked rows again and be refused forever. `--generation N+1` mints fresh ones. Admission writes the
 * tenant row and the company row under this one key, so the tenant admission carries the generation too.
 */
export const admitKey = (generation: number, principalId: HumanId): IdempotencyKey =>
  keyOf(`ontos-demo-admit:v1:g${generation}:${principalId}:company-0020`);
export const assignKey = (generation: number, principalId: HumanId, roleId: RoleId): IdempotencyKey =>
  keyOf(`ontos-demo-assign:v1:g${generation}:${principalId}:${roleId}`);
/** The incarnation id the Shell mints for an assign key (people.ts mintedId). */
export const assignmentIdOf = (idempotencyKey: IdempotencyKey): AssignmentId =>
  AccessAssignmentIdSchema.make(
    stableUuid(['ontos.shell.access-people.assignment', TENANT_ID, idempotencyKey, ''].join(':')),
  );
const revokeKey = (generation: number, incarnationId: AssignmentId): IdempotencyKey =>
  keyOf(`ontos-demo-revoke:v1:g${generation}:${incarnationId}`);
const endKey = (generation: number, principalId: HumanId, scope: ScopeTarget): IdempotencyKey =>
  keyOf(`ontos-demo-end:v1:g${generation}:${principalId}:${scope.kind === 'tenant' ? 'tenant' : 'company-0020'}`);

// --- cells and their confirmations -------------------------------------------------------------------

/** One reviewed cell; the wire spells its selector `{ _tag }`, see `wireCell`. */
export const ReviewedCellSchema = Schema.Struct({
  capabilityKey: AccessCapabilityKeySchema,
  mode: AccessModeSchema,
  selector: RecordSelectorSchema,
});
export type ReviewedCell = typeof ReviewedCellSchema.Type;

export const wireCell = ({ capabilityKey, mode, selector }: ReviewedCell) => ({
  capabilityKey,
  mode,
  selector: { _tag: selector },
});

/** A cell as the Shell lists it: its slot, and whether it is plain (no ceiling, no exact targets). */
export interface ObservedCell {
  readonly plain: boolean;
  readonly slot: string;
}

/** Core's slot key (`cellSlotKey`) of a reviewed cell. */
export const slotOf = ({ capabilityKey, mode, selector }: ReviewedCell): string =>
  `${capabilityKey} ${mode} ${selector}`;
export const observedCellOf = (cell: ReviewedCell): ObservedCell => ({ plain: true, slot: slotOf(cell) });

const toCell = (cell: ReviewedCell): Cell => ({
  capabilityKey: CapabilityKeySchema.make(cell.capabilityKey),
  mode: cell.mode,
  selector: { _tag: cell.selector },
});

export const ConfirmationSchema = Schema.Struct({ effect: Schema.String, slot: Schema.String });
/** One dangerous cell and the effect the save must confirm for it, exactly as the Shell computes them. */
export type Confirmation = typeof ConfirmationSchema.Type;

/** The confirmations one cell set needs, computed with Core's own rule over the given release entries. */
export const confirmationsOf = (
  cells: readonly ReviewedCell[],
  entries: ReadonlyMap<string, CatalogSnapshotEntry>,
): Result.Result<readonly Confirmation[], string> => {
  const confirmations: Confirmation[] = [];
  for (const reviewed of cells) {
    const entry = entries.get(reviewed.capabilityKey);
    if (entry === undefined) {
      return Result.fail(`${reviewed.capabilityKey} is not in the release`);
    }
    const cell = toCell(reviewed);
    if (isDangerousCell(entry, cell)) {
      confirmations.push({ effect: roleCellEffect(entry, cell), slot: cellSlotKey(cell) });
    }
  }
  return Result.succeed(confirmations);
};

/** One release entry as `roles/templates` answers it. */
export const ReleaseEntrySchema = Schema.Struct({
  capabilityKey: AccessCapabilityKeySchema,
  kind: AccessKindSchema,
  modes: Schema.Array(AccessModeSchema),
  risk: AccessRiskSchema,
  selectors: Schema.Array(RecordSelectorSchema),
});
export type ReleaseEntry = typeof ReleaseEntrySchema.Type;

/** The local entries with the stage release's kind and risk, the only fields an effect reads. */
const stageEffectEntries = (
  local: ReadonlyMap<string, CatalogSnapshotEntry>,
  stage: readonly ReleaseEntry[],
): ReadonlyMap<string, CatalogSnapshotEntry> =>
  new Map(
    stage.flatMap((entry) => {
      const known = local.get(entry.capabilityKey);
      return known === undefined ? [] : [[entry.capabilityKey, { ...known, kind: entry.kind, risk: entry.risk }]];
    }),
  );

const confirmationKey = ({ effect, slot }: Confirmation) => `${slot}\u0000${effect}`;
const sameConfirmations = (left: readonly Confirmation[], right: readonly Confirmation[]): boolean => {
  const rightKeys = new Set(right.map(confirmationKey));
  return (
    left.length === right.length &&
    rightKeys.size === right.length &&
    left.every((item) => rightKeys.has(confirmationKey(item)))
  );
};

/** The cells hold exactly the reviewed slots, all plain. */
const holdsExactly = (held: readonly ObservedCell[], reviewed: readonly ReviewedCell[]): boolean => {
  const heldSlots = new Set(held.map(({ slot }) => slot));
  return (
    held.length === reviewed.length &&
    heldSlots.size === held.length &&
    held.every(({ plain }) => plain) &&
    reviewed.every((cell) => heldSlots.has(slotOf(cell)))
  );
};

// --- desired state -----------------------------------------------------------------------------------

export interface DesiredRole {
  /** The admin-kind cells, by name, which a person signs off before the first apply. */
  readonly adminCells: readonly string[];
  readonly cells: readonly ReviewedCell[];
  /** Computed over the local release; the plan also computes them over the stage release and compares. */
  readonly confirmations: readonly Confirmation[];
  readonly createKey: IdempotencyKey;
  readonly key: ManagedRoleKey;
  readonly name: string;
  readonly roleId: RoleId;
  readonly saveKey: IdempotencyKey;
  readonly scope: ScopeTarget;
}

export interface DesiredAssignment {
  readonly principalId: HumanId;
  readonly roleId: RoleId;
  readonly roleKey: ManagedRoleKey;
  readonly scope: ScopeTarget;
}

export interface DesiredState {
  readonly assignments: readonly DesiredAssignment[];
  /** The local release entries the desired cells name. */
  readonly entries: ReadonlyMap<string, CatalogSnapshotEntry>;
  readonly roles: readonly DesiredRole[];
}

const sortedSlots = (rows: readonly ReviewedCell[]): string =>
  rows
    .map(slotOf)
    .toSorted((left, right) => left.localeCompare(right))
    .join('\n');

const reviewedCells = (role: Parameters<typeof policyRoleCellRows>[0], localEntries: readonly CatalogSnapshotEntry[]) =>
  Result.map(policyRoleCellRows(role, localEntries, 'human'), (rows) =>
    rows
      .map(({ capabilityKey, mode, selector }) => ({
        capabilityKey: AccessCapabilityKeySchema.make(capabilityKey),
        mode,
        selector,
      }))
      .toSorted((left, right) => slotOf(left).localeCompare(slotOf(right))),
  );

type ReviewedAssignment = ReturnType<typeof reviewedDemoAssignments>[number];

const compileRole = (
  key: ManagedRoleKey,
  ours: readonly ReviewedAssignment[],
  localEntries: readonly CatalogSnapshotEntry[],
  entries: ReadonlyMap<string, CatalogSnapshotEntry>,
): Result.Result<DesiredRole, string> => {
  const held = ours.filter(({ roleKey }) => roleKey === key);
  const compiled = held.map(({ role }) => reviewedCells(role, localEntries));
  const [first] = held;
  const [firstCells] = compiled;
  if (first === undefined || firstCells === undefined || Result.isFailure(firstCells)) {
    return Result.fail(`role ${key} is not held by the three people, or does not compile`);
  }
  const cells = firstCells.success;
  const slots = sortedSlots(cells);
  if (
    held.some(({ legalEntityId }) => legalEntityId !== first.legalEntityId) ||
    compiled.some((result) => Result.isFailure(result) || sortedSlots(result.success) !== slots)
  ) {
    return Result.fail(`role ${key} differs between its holders`);
  }
  return Result.map(confirmationsOf(cells, entries), (confirmations) => ({
    adminCells: cells
      .filter(({ capabilityKey }) => entries.get(capabilityKey)?.kind === 'admin')
      .map((cell) => `${slotOf(cell)} (${entries.get(cell.capabilityKey)?.risk ?? 'unknown'})`),
    cells,
    confirmations,
    createKey: roleCreateKey(key),
    key,
    name: first.role.label,
    roleId: roleIdOf(key),
    saveKey: keyOf(`ontos-demo-reviewed-role-save:v1:${key}:${digest(slots)}`),
    scope:
      first.legalEntityId === undefined
        ? TENANT_SCOPE
        : { kind: 'company', legalEntityId: AccessCompanyIdSchema.make(first.legalEntityId) },
  }));
};

const sameScope = (left: ScopeTarget, right: ScopeTarget): boolean =>
  left.kind === right.kind &&
  (left.kind === 'tenant' || (right.kind === 'company' && left.legalEntityId === right.legalEntityId));

const isPrincipal = (principalId: string): boolean => PRINCIPAL_IDS.some((id) => id === principalId);
const isManagedRole = (roleId: string): boolean => MANAGED_ROLE_IDS.some((id) => id === roleId);

/**
 * The reviewed matrix restricted to the three people: their roles compiled from the local release, and
 * their six assignments. Anything the matrix gives them outside the four roles and the two scopes fails.
 */
export const desiredState = (localEntries: readonly CatalogSnapshotEntry[]): Result.Result<DesiredState, string> => {
  const fixturePeople = demoHumanAccounts.slice(1).map(({ principalId }) => principalId);
  if (
    fixturePeople.join(',') !== PRINCIPAL_IDS.join(',') ||
    demoTenantId !== TENANT_ID ||
    demoLegalEntityId !== COMPANY_ID
  ) {
    return Result.fail('the demo fixtures no longer name the reviewed tenant, company and three people');
  }
  const ours = reviewedDemoAssignments().filter(({ principalId }) => isPrincipal(principalId));
  const entries = new Map(localEntries.map((entry) => [String(entry.key), entry]));
  const roles: DesiredRole[] = [];
  for (const key of MANAGED_ROLE_KEYS) {
    const role = compileRole(key, ours, localEntries, entries);
    if (Result.isFailure(role)) {
      return Result.fail(role.failure);
    }
    if (!sameScope(role.success.scope, TENANT_SCOPE) && !sameScope(role.success.scope, COMPANY_SCOPE)) {
      return Result.fail(`role ${key} belongs to another company`);
    }
    roles.push(role.success);
  }
  const assignments: DesiredAssignment[] = [];
  for (const principalId of PRINCIPAL_IDS) {
    for (const { legalEntityId, roleKey } of ours.filter((assignment) => assignment.principalId === principalId)) {
      if (!Schema.is(ManagedRoleKeySchema)(roleKey) || (legalEntityId !== undefined && legalEntityId !== COMPANY_ID)) {
        return Result.fail(`the matrix gives ${principalId} ${roleKey} outside the four roles of company 0020`);
      }
      assignments.push({
        principalId,
        roleId: roleIdOf(roleKey),
        roleKey,
        scope: legalEntityId === undefined ? TENANT_SCOPE : COMPANY_SCOPE,
      });
    }
  }
  return Result.succeed({ assignments, entries, roles });
};

// --- observed state ----------------------------------------------------------------------------------

export interface ObservedMembership {
  readonly kind: 'access_admin' | 'member' | 'owner';
  readonly scope: ScopeTarget;
  readonly status: 'active' | 'revoked' | 'suspended';
  readonly validUntil: Option.Option<DateTime.Utc>;
}
export interface ObservedAssignment {
  readonly incarnationId: AssignmentId;
  readonly roleId: RoleId;
  readonly scope: ScopeTarget;
  readonly status: 'active' | 'expired' | 'revoked';
}
export interface ObservedPerson {
  readonly assignments: readonly ObservedAssignment[];
  readonly memberships: readonly ObservedMembership[];
  readonly principalId: HumanId;
}
export interface ObservedRole {
  readonly cells: readonly ObservedCell[];
  readonly holderCount: number;
  readonly id: RoleId;
  /** The company of a company role; `None` for a tenant role. */
  readonly legalEntityId: Option.Option<CompanyId>;
  readonly name: string;
  readonly revisionId: RoleRevisionId;
}
/** One row of the selected company's directory (`/auth/identity/people/list`). */
export interface ObservedDirectoryEntry {
  /** A human, active as a principal, with an `active` membership in the company directory. */
  readonly activeHumanMember: boolean;
  readonly principalId: string;
}
export interface ObservedState {
  readonly actingPrincipalId: string;
  /** When the state was read, for the validity of membership rows. */
  readonly at: DateTime.Utc;
  readonly directory: readonly ObservedDirectoryEntry[];
  readonly people: readonly ObservedPerson[];
  readonly peopleRevision: PeopleRevision;
  readonly release: {
    readonly catalogSnapshotId: CatalogSnapshotId;
    readonly createAvailable: boolean;
    readonly entries: readonly ReleaseEntry[];
    readonly saveAvailable: boolean;
  };
  readonly roles: readonly ObservedRole[];
  readonly tenantId: string;
  readonly writeAvailability: {
    readonly canAdmitMember: boolean;
    readonly canAssign: boolean;
    readonly canEndMembership: boolean;
    readonly canUnassign: boolean;
  };
}

// --- planned writes ----------------------------------------------------------------------------------

export const CreateRoleStep = Schema.TaggedStruct('CreateRole', {
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  name: Schema.String,
  roleId: AccessRoleIdSchema,
  roleKey: ManagedRoleKeySchema,
  scope: AccessScopeTargetSchema,
});
export const SaveRoleStep = Schema.TaggedStruct('SaveRole', {
  adminCells: Schema.Array(Schema.String),
  catalogSnapshotId: AccessCatalogSnapshotIdSchema,
  cells: Schema.Array(ReviewedCellSchema),
  confirmations: Schema.Array(ConfirmationSchema),
  /** Known once the role exists; the driver only sends a step whose revision is known. */
  expectedRoleRevisionId: Schema.Option(AccessRoleRevisionIdSchema),
  idempotencyKey: IdempotencyKeySchema,
  roleId: AccessRoleIdSchema,
  roleKey: ManagedRoleKeySchema,
});
export const AdmitMemberStep = Schema.TaggedStruct('AdmitMember', {
  expectedRevision: AccessPeopleRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  principalId: AccessHumanIdSchema,
});
export const AssignStep = Schema.TaggedStruct('Assign', {
  expectedRevision: AccessPeopleRevisionSchema,
  expectedRoleRevisionId: Schema.Option(AccessRoleRevisionIdSchema),
  idempotencyKey: IdempotencyKeySchema,
  principalId: AccessHumanIdSchema,
  roleId: AccessRoleIdSchema,
  roleKey: ManagedRoleKeySchema,
  scope: AccessScopeTargetSchema,
});
export const RevokeAssignmentStep = Schema.TaggedStruct('RevokeAssignment', {
  expectedRevision: AccessPeopleRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  incarnationId: AccessAssignmentIdSchema,
  principalId: AccessHumanIdSchema,
  roleId: AccessRoleIdSchema,
});
export const EndMembershipStep = Schema.TaggedStruct('EndMembership', {
  expectedRevision: AccessPeopleRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
  principalId: AccessHumanIdSchema,
  scope: AccessScopeTargetSchema,
});
export const PlannedStepSchema = Schema.Union([
  CreateRoleStep,
  SaveRoleStep,
  AdmitMemberStep,
  AssignStep,
  RevokeAssignmentStep,
  EndMembershipStep,
]);
export type PlannedStep = typeof PlannedStepSchema.Type;
export type SaveRole = typeof SaveRoleStep.Type;

export const STEP_PATHS = {
  AdmitMember: '/shell/access/people/admit-member',
  Assign: '/shell/access/people/assign',
  CreateRole: '/shell/access/roles/create',
  EndMembership: '/shell/access/people/end-membership',
  RevokeAssignment: '/shell/access/people/revoke-assignment',
  SaveRole: '/shell/access/roles/save',
} as const satisfies Record<PlannedStep['_tag'], string>;

export interface PlanHalt {
  /** `identity`: the signed-in person is not the tenant owner of the reviewed tenant. */
  readonly kind: 'identity' | 'validation';
  readonly reason: string;
}
export interface PlanOptions {
  readonly generation: number;
  readonly mode: 'apply' | 'rollback';
}
type Planned = Result.Result<readonly PlannedStep[], PlanHalt>;

const halt = (reason: string): Planned => Result.fail({ kind: 'validation', reason });

const isAllowedScope = (scope: ScopeTarget): boolean =>
  sameScope(scope, TENANT_SCOPE) || sameScope(scope, COMPANY_SCOPE);

const isLive = (membership: ObservedMembership, at: DateTime.Utc): boolean =>
  membership.status === 'active' &&
  Option.match(membership.validUntil, { onNone: () => true, onSome: (until) => DateTime.isGreaterThan(until, at) });

const memberRows = (person: ObservedPerson | undefined, scope: ScopeTarget) =>
  (person?.memberships ?? []).filter((row) => row.kind === 'member' && sameScope(row.scope, scope));

const endedRows = (rows: readonly ObservedMembership[]): number =>
  rows.filter(({ status }) => status === 'revoked').length;

const revokedHolder = (step: typeof RevokeAssignmentStep.Type, observed: ObservedState): boolean =>
  observed.people.some(
    ({ assignments, principalId }) =>
      principalId === step.principalId &&
      isPrincipal(principalId) &&
      assignments.some(
        ({ incarnationId, roleId, scope }) =>
          incarnationId === step.incarnationId && isManagedRole(roleId) && isAllowedScope(scope),
      ),
  );

/**
 * The last guard before a write: it names only the three people, the four roles, and the tenant or company
 * 0020, and a revoked assignment is one the three hold on a managed role. The driver calls it again on the
 * exact step it is about to send.
 */
export const stepWithinAllowList = (step: PlannedStep, observed: ObservedState): boolean =>
  Match.valueTags(step, {
    AdmitMember: ({ principalId }) => isPrincipal(principalId),
    Assign: ({ principalId, roleId, scope }) =>
      isPrincipal(principalId) && isManagedRole(roleId) && isAllowedScope(scope),
    CreateRole: ({ roleId, roleKey, scope }) => roleIdOf(roleKey) === roleId && isAllowedScope(scope),
    EndMembership: ({ principalId, scope }) => isPrincipal(principalId) && isAllowedScope(scope),
    RevokeAssignment: (revoke) => revokedHolder(revoke, observed),
    SaveRole: ({ roleId, roleKey }) => roleIdOf(roleKey) === roleId,
  });

const identityIssue = (observed: ObservedState): string | undefined => {
  if (observed.tenantId !== TENANT_ID) {
    return `signed in to tenant ${observed.tenantId}, not ${TENANT_ID}`;
  }
  const acting = observed.people.find(({ principalId }) => principalId === observed.actingPrincipalId);
  const owner = acting?.memberships.some(
    (row) => row.kind === 'owner' && row.scope.kind === 'tenant' && isLive(row, observed.at),
  );
  return owner === true ? undefined : 'the signed-in person is not the tenant owner of the reviewed tenant';
};

const onStage = (cell: ReviewedCell, entry: ReleaseEntry | undefined): boolean =>
  entry !== undefined &&
  entry.modes.includes(cell.mode) &&
  (entry.selectors.includes(cell.selector) || (cell.selector === 'all' && entry.selectors.length === 0));

/** Every reviewed cell exists in the stage release with that mode and selector, with the same effects. */
const releaseIssue = (desired: DesiredState, observed: ObservedState): string | undefined => {
  const stage = new Map<string, ReleaseEntry>(observed.release.entries.map((entry) => [entry.capabilityKey, entry]));
  const effects = stageEffectEntries(desired.entries, observed.release.entries);
  for (const role of desired.roles) {
    const missing = role.cells.find((cell) => !onStage(cell, stage.get(cell.capabilityKey)));
    if (missing !== undefined) {
      return `role ${role.key}: the stage release has no ${slotOf(missing)}`;
    }
    const stageConfirmations = confirmationsOf(role.cells, effects);
    if (Result.isFailure(stageConfirmations) || !sameConfirmations(stageConfirmations.success, role.confirmations)) {
      return `role ${role.key}: the stage release gives its cells other effects than the local release`;
    }
  }
  return undefined;
};

const activeHolders = (observed: ObservedState, roleId: RoleId, inside: boolean) =>
  observed.people.filter(
    ({ assignments, principalId }) =>
      isPrincipal(principalId) === inside &&
      assignments.some((held) => held.roleId === roleId && held.status === 'active'),
  );

/** Nobody but the three holds a managed role, and no other role reuses their names. */
const holdersIssue = (desired: DesiredState, observed: ObservedState): string | undefined => {
  for (const role of desired.roles) {
    const sameName = observed.roles.find(({ id, name }) => name === role.name && id !== role.roleId);
    if (sameName !== undefined) {
      return `a role named "${role.name}" already exists under another id (${sameName.id})`;
    }
    const [outsider] = activeHolders(observed, role.roleId, false);
    if (outsider !== undefined) {
      return `${outsider.principalId}, outside the three people, holds the managed role ${role.key}`;
    }
    const ours = activeHolders(observed, role.roleId, true).length;
    const listed = observed.roles.find(({ id }) => id === role.roleId);
    if (listed !== undefined && listed.holderCount > ours) {
      return `the managed role ${role.key} has ${listed.holderCount} holders, more than the three people's ${ours}`;
    }
  }
  return undefined;
};

const revisionOf = (observed: ObservedState, roleId: RoleId): Option.Option<RoleRevisionId> =>
  Option.map(Option.fromUndefinedOr(observed.roles.find(({ id }) => id === roleId)), ({ revisionId }) => revisionId);

/** The writes one reviewed role still needs, or why it must not be touched. */
const roleSteps = (role: DesiredRole, observed: ObservedState): Planned => {
  const listed = observed.roles.find(({ id }) => id === role.roleId);
  const save = SaveRoleStep.make({
    adminCells: role.adminCells,
    catalogSnapshotId: observed.release.catalogSnapshotId,
    cells: role.cells,
    confirmations: role.confirmations,
    expectedRoleRevisionId: revisionOf(observed, role.roleId),
    idempotencyKey: role.saveKey,
    roleId: role.roleId,
    roleKey: role.key,
  });
  if (listed === undefined) {
    const create = CreateRoleStep.make({
      catalogSnapshotId: observed.release.catalogSnapshotId,
      idempotencyKey: role.createKey,
      name: role.name,
      roleId: role.roleId,
      roleKey: role.key,
      scope: role.scope,
    });
    return Result.succeed([create, save]);
  }
  const wanted: string = role.scope.kind === 'company' ? role.scope.legalEntityId : 'tenant';
  if (Option.getOrElse(listed.legalEntityId, (): string => 'tenant') !== wanted) {
    return halt(`the managed role ${role.key} exists in another scope`);
  }
  if (listed.cells.length === 0) {
    return Result.succeed([save]);
  }
  return holdsExactly(listed.cells, role.cells)
    ? Result.succeed([])
    : halt(`the managed role ${role.key} holds other cells; this script never rewrites a saved role`);
};

/** The admission one person still needs, or why the plan must stop. */
const admissionSteps = (principalId: HumanId, observed: ObservedState, generation: number): Planned => {
  const person = observed.people.find((candidate) => candidate.principalId === principalId);
  const tenantRows = memberRows(person, TENANT_SCOPE);
  const companyRows = memberRows(person, COMPANY_SCOPE);
  if ([...tenantRows, ...companyRows].some((row) => row.status !== 'revoked' && !isLive(row, observed.at))) {
    return halt(`${principalId} has a suspended or expired membership; resolve it in Lidé first`);
  }
  const tenantLive = tenantRows.some((row) => isLive(row, observed.at));
  if (companyRows.some((row) => isLive(row, observed.at))) {
    return tenantLive
      ? Result.succeed([])
      : halt(`${principalId} is a member of company 0020 without a tenant membership`);
  }
  const used = Math.max(endedRows(tenantRows), endedRows(companyRows));
  if (used >= generation) {
    return halt(
      `${principalId} was admitted and ended before; generation ${generation} is used up, re-run with --generation ${used + 1}`,
    );
  }
  return Result.succeed([
    AdmitMemberStep.make({
      expectedRevision: observed.peopleRevision,
      idempotencyKey: admitKey(generation, principalId),
      principalId,
    }),
  ]);
};

/** The assignments still missing, under this generation's keys. */
const assignmentSteps = (
  wanted: readonly DesiredAssignment[],
  observed: ObservedState,
  generation: number,
): Planned => {
  const steps: PlannedStep[] = [];
  for (const assignment of wanted) {
    const person = observed.people.find(({ principalId }) => principalId === assignment.principalId);
    const assignments = person?.assignments ?? [];
    const held = assignments.some(
      ({ roleId, scope, status }) =>
        roleId === assignment.roleId && sameScope(scope, assignment.scope) && status === 'active',
    );
    const idempotencyKey = assignKey(generation, assignment.principalId, assignment.roleId);
    const minted = assignmentIdOf(idempotencyKey);
    if (!held && assignments.some(({ incarnationId }) => incarnationId === minted)) {
      return halt(
        `the assignment of ${assignment.roleKey} to ${assignment.principalId} for generation ${generation} has ended; re-run with --generation ${generation + 1}`,
      );
    }
    if (!held) {
      steps.push(
        AssignStep.make({
          expectedRevision: observed.peopleRevision,
          expectedRoleRevisionId: revisionOf(observed, assignment.roleId),
          idempotencyKey,
          principalId: assignment.principalId,
          roleId: assignment.roleId,
          roleKey: assignment.roleKey,
          scope: assignment.scope,
        }),
      );
    }
  }
  return Result.succeed(steps);
};

/** Concatenate step lists in order, stopping at the first halt. */
const sequence = (parts: readonly (() => Planned)[]): Planned => {
  const steps: PlannedStep[] = [];
  for (const part of parts) {
    const planned = part();
    if (Result.isFailure(planned)) {
      return planned;
    }
    steps.push(...planned.success);
  }
  return Result.succeed(steps);
};

/** Before the first write: Lidé can hold the roles, the editor can write them, the three are in 0020's directory. */
const readinessIssue = (steps: readonly PlannedStep[], observed: ObservedState): string | undefined => {
  if (steps.length === 0) {
    return undefined;
  }
  if (!observed.writeAvailability.canAdmitMember || !observed.writeAvailability.canAssign) {
    return 'Lidé cannot admit and assign yet (people options); nothing is written';
  }
  const creates = steps.some((step) => Schema.is(CreateRoleStep)(step));
  if (creates && !observed.release.createAvailable) {
    return 'roles/templates says roles cannot be created';
  }
  if (steps.some((step) => Schema.is(SaveRoleStep)(step)) && !observed.release.saveAvailable) {
    return 'roles/templates says roles cannot be saved';
  }
  const absent = PRINCIPAL_IDS.filter(
    (principalId) => !observed.directory.some((entry) => entry.principalId === principalId && entry.activeHumanMember),
  );
  return absent.length > 0 ? `not active people of company 0020's directory: ${absent.join(', ')}` : undefined;
};

const applyPlan = (desired: DesiredState, observed: ObservedState, generation: number): Planned => {
  const issue = releaseIssue(desired, observed) ?? holdersIssue(desired, observed);
  if (issue !== undefined) {
    return halt(issue);
  }
  const planned = sequence([
    ...desired.roles.map((role) => () => roleSteps(role, observed)),
    ...PRINCIPAL_IDS.map((principalId) => () => admissionSteps(principalId, observed, generation)),
    () => assignmentSteps(desired.assignments, observed, generation),
  ]);
  if (Result.isFailure(planned)) {
    return planned;
  }
  const notReady = readinessIssue(planned.success, observed);
  return notReady === undefined ? planned : halt(notReady);
};

/** Undo the people side: the three lose the managed roles, then company 0020, then the tenant. Roles stay. */
const rollbackPlan = (observed: ObservedState, generation: number): Planned => {
  const revokes: PlannedStep[] = [];
  const companyEnds: PlannedStep[] = [];
  const tenantEnds: PlannedStep[] = [];
  for (const principalId of PRINCIPAL_IDS) {
    const person = observed.people.find((candidate) => candidate.principalId === principalId);
    const active = (person?.assignments ?? []).filter(({ status }) => status === 'active');
    const foreign = active.find(({ roleId }) => !isManagedRole(roleId));
    if (foreign !== undefined) {
      return halt(`${principalId} also holds role ${foreign.roleId}, which ending the membership would close`);
    }
    revokes.push(
      ...active.map(({ incarnationId, roleId }) =>
        RevokeAssignmentStep.make({
          expectedRevision: observed.peopleRevision,
          idempotencyKey: revokeKey(generation, incarnationId),
          incarnationId,
          principalId,
          roleId,
        }),
      ),
    );
    const end = (scope: ScopeTarget) =>
      EndMembershipStep.make({
        expectedRevision: observed.peopleRevision,
        idempotencyKey: endKey(generation, principalId, scope),
        principalId,
        scope,
      });
    if (memberRows(person, COMPANY_SCOPE).some((row) => isLive(row, observed.at))) {
      companyEnds.push(end(COMPANY_SCOPE));
    }
    if (memberRows(person, TENANT_SCOPE).some((row) => isLive(row, observed.at))) {
      tenantEnds.push(end(TENANT_SCOPE));
    }
  }
  if (revokes.length > 0 && !observed.writeAvailability.canUnassign) {
    return halt('Lidé cannot unassign (people options); nothing is written');
  }
  if (companyEnds.length + tenantEnds.length > 0 && !observed.writeAvailability.canEndMembership) {
    return halt('Lidé cannot end memberships (people options); nothing is written');
  }
  return Result.succeed([...revokes, ...companyEnds, ...tenantEnds]);
};

/** The ordered writes that bring stage to the reviewed state (or back), or the reason it must not. */
export const planReviewedPeople = (desired: DesiredState, observed: ObservedState, options: PlanOptions): Planned => {
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    return halt('--generation must be a whole number from 1');
  }
  const identity = identityIssue(observed);
  if (identity !== undefined) {
    return Result.fail({ kind: 'identity', reason: identity });
  }
  const planned =
    options.mode === 'apply'
      ? applyPlan(desired, observed, options.generation)
      : rollbackPlan(observed, options.generation);
  if (Result.isFailure(planned)) {
    return planned;
  }
  const outside = planned.success.find((step) => !stepWithinAllowList(step, observed));
  return outside === undefined ? planned : halt(`refused ${outside._tag}: it names something outside the constants`);
};

// --- the role save, checked against the server's own preview -----------------------------------------

export const previewBody = (step: SaveRole, expectedRoleRevisionId: RoleRevisionId) => ({
  catalogSnapshotId: step.catalogSnapshotId,
  cells: step.cells.map(wireCell),
  expectedRoleRevisionId,
  roleId: step.roleId,
});

export const saveBody = (step: SaveRole, expectedRoleRevisionId: RoleRevisionId, previewToken: string) => ({
  ...previewBody(step, expectedRoleRevisionId),
  confirmedEffects: step.confirmations.map(({ effect, slot }) => ({ effect, slot })),
  previewToken,
});

/** What `roles/preview` answered for a planned save. */
export interface ObservedPreview {
  readonly added: readonly ObservedCell[];
  /** The people the edit reaches; `None` for an agent holder. */
  readonly affectedHolders: readonly Option.Option<string>[];
  readonly cells: readonly ObservedCell[];
  readonly dangerous: readonly Confirmation[];
  readonly removed: readonly ObservedCell[];
}

/**
 * The save goes ahead only when the server previews exactly the planned edit: nothing removed, every reviewed
 * cell added, the dangerous set equal to the one computed here, and no holder outside the three people.
 */
export const previewIssue = (step: SaveRole, preview: ObservedPreview): string | undefined => {
  if (preview.removed.length > 0) {
    return `the preview of ${step.roleKey} removes ${preview.removed.length} cells`;
  }
  if (!holdsExactly(preview.added, step.cells) || !holdsExactly(preview.cells, step.cells)) {
    return `the preview of ${step.roleKey} does not add exactly the reviewed cells`;
  }
  if (!sameConfirmations(preview.dangerous, step.confirmations)) {
    return `the preview of ${step.roleKey} lists other dangerous effects than the reviewed ones`;
  }
  const foreign = preview.affectedHolders.some((holder) => !Option.exists(holder, isPrincipal));
  return foreign ? `the preview of ${step.roleKey} affects a holder outside the three people` : undefined;
};
