/**
 * Compile reviewed demo Roles into canonical capability/mode/selector cells. Roles pin the generated
 * release, so a later capability does not become a grant. Missing declarations and invalid explicit
 * selectors fail compilation. Core owns persistence and projection; this module writes no tuples.
 */
import { DateTime, Result, Schema } from 'effect';

import { buildAccessCatalogRelease } from '@app/core-runtime/access/catalog';
import type { AccessCatalogModule } from '@app/core-runtime';

import { installedModuleKeysOf } from '../../packages/core-runtime/src/install/installation-runtime.ts';

import { CapabilityKeySchema, ModuleKeySchema } from '../../packages/core-runtime/src/access/ids.ts';
import type { Cell, CatalogSnapshotEntry, RecordSelector } from '../../packages/core-runtime/src/access/model.ts';
import { RecordSelectorSchema } from '../../packages/core-runtime/src/access/model.ts';

/** Read access: the capabilities that answer a read. Write access: every capability the module declares. */
export const ModuleAccessSchema = Schema.Literals(['read', 'write']);
export type ModuleAccess = typeof ModuleAccessSchema.Type;

/**
 * One reviewed demo role. Its vocabulary is the reviewed matrix's own: which modules a person reaches, at
 * read or write, which capabilities are named explicitly, which modules stay restricted to exactly those,
 * whether the person reviews proposals, and whether the person is a company administrator or the tenant owner.
 */
export interface PolicyRole {
  /** Explicit capability keys a role names on top of its module access, by module. */
  readonly capabilityKeys?: Readonly<Record<string, readonly string[]>>;
  /** Narrows a named capability to these modes; it never adds a mode the role could not otherwise hold. */
  readonly capabilityModes?: Readonly<Record<string, readonly Cell['mode'][]>>;
  /** Replaces the selector of this key, including when module access also selects it. */
  readonly capabilitySelectors?: Readonly<Record<string, RecordSelector>>;
  /** Company administration: `access_admin` in the company scope, on top of the role's own cells. */
  readonly companyAdmin?: true;
  readonly label: string;
  readonly modules: Readonly<Record<string, ModuleAccess>>;
  /** The one reviewed capability a proposal reviewer approves, at its declared `approve` mode. */
  readonly proposalReview?: true;
  /** Modules opened without their generic capability set: only `capabilityKeys` apply. */
  readonly restrictedModules?: readonly string[];
  /** Tenant ownership: the `owner` membership in the tenant-context scope. */
  readonly tenantOwner?: true;
}

/**
 * The reviewed capability a proposal reviewer approves (O14, O22, O43): the `core.identity` entrypoint
 * that mutates an agent proposal, whose declaration carries the `approve` mode.
 */
export const PROPOSAL_REVIEW_CAPABILITY = 'core.identity.agent-proposal.mutate';

/** A human runs; an agent proposes the sensitive and critical work and runs only the routine (ADR-0030). */
export const PolicyActorKindSchema = Schema.Literals(['agent', 'human']);
export type PolicyActorKind = typeof PolicyActorKindSchema.Type;

/** Broad module access uses the declared default. A narrower persona overrides it per capability key. */
const selectorOf = (entry: CatalogSnapshotEntry): RecordSelector => {
  if (entry.selectors.length === 0) {
    return 'all';
  }
  return entry.selectors.includes('all') ? 'all' : (entry.selectors[0] ?? 'all');
};

/**
 * The modes one cell carries. A human runs the capability and may propose it; a proposal reviewer also
 * approves it. An agent proposes the sensitive and critical work, never reads or exports it, and runs the
 * routine. Every choice is narrowed to the modes the declaration carries.
 */
const modesFor = (
  entry: CatalogSnapshotEntry,
  role: PolicyRole,
  actorKind: PolicyActorKind,
): readonly Cell['mode'][] => {
  if (actorKind === 'agent') {
    if (entry.risk !== 'routine') {
      return entry.kind === 'action' && entry.modes.includes('propose') ? ['propose'] : [];
    }
    return entry.modes.includes('run') ? ['run'] : [];
  }
  const wanted: readonly Cell['mode'][] =
    role.proposalReview === true ? ['run', 'propose', 'approve'] : ['run', 'propose'];
  return wanted.filter((mode) => entry.modes.includes(mode));
};

const invalidModeOverride = (
  entry: CatalogSnapshotEntry | undefined,
  modes: readonly Cell['mode'][],
  role: PolicyRole,
  actorKind: PolicyActorKind,
): boolean =>
  entry === undefined ||
  modes.length === 0 ||
  new Set(modes).size !== modes.length ||
  modes.some((mode) => !modesFor(entry, role, actorKind).includes(mode));

const invalidSelectorOverride = (entry: CatalogSnapshotEntry | undefined, selector: RecordSelector): boolean =>
  entry === undefined || !entry.selectors.includes(selector);

/** The capability keys a role's module access reaches: its own kind, or the whole module for write. */
const keysForModule = (
  role: PolicyRole,
  moduleId: string,
  catalog: readonly CatalogSnapshotEntry[],
): readonly string[] => {
  const named = role.capabilityKeys?.[moduleId] ?? [];
  const restricted = (role.restrictedModules ?? []).includes(moduleId);
  const access = role.modules[moduleId];
  const moduleEntries = catalog.filter((entry) => entry.moduleKey === moduleId);
  const generic =
    restricted || access === undefined
      ? []
      : moduleEntries
          .filter((entry) => (access === 'read' ? entry.kind === 'read' || entry.kind === 'field_read' : true))
          .map((entry) => entry.key);
  return [...new Set([...generic, ...named])];
};

/** Every capability key one role reaches across its modules, plus the proposal-review capability. */
export const policyRoleKeys = (role: PolicyRole, catalog: readonly CatalogSnapshotEntry[]): readonly string[] => {
  const declared = new Set<string>(catalog.map((entry) => entry.key));
  const keys = Object.keys(role.modules).flatMap((moduleId) => keysForModule(role, moduleId, catalog));
  const review =
    role.proposalReview === true && declared.has(PROPOSAL_REVIEW_CAPABILITY) ? [PROPOSAL_REVIEW_CAPABILITY] : [];
  return [...new Set([...keys, ...review])]
    .filter((key) => declared.has(key))
    .toSorted((left, right) => left.localeCompare(right));
};

/**
 * The exact cells one reviewed role grants, compiled against the release the Role will pin. A key the
 * release does not declare is refused, never skipped, so a reviewed policy that drifted from the catalog
 * fails the seed instead of silently granting less.
 */
export const policyRoleCells = (
  role: PolicyRole,
  catalog: readonly CatalogSnapshotEntry[],
  actorKind: PolicyActorKind = 'human',
): Result.Result<readonly Cell[], string> => {
  const entriesByKey = new Map<string, CatalogSnapshotEntry>(catalog.map((entry) => [entry.key, entry]));
  // A module the release does not declare is a gap in the composition, never a silently smaller Role: a
  // Role that named `demo.crm` and compiled to nothing would lock its people out of a module the
  // composition serves, and the caller would only see an empty grant. Refuse with the exact module.
  const declaredModules = new Set<string>(catalog.map((entry) => entry.moduleKey));
  const undeclaredModules = Object.keys(role.modules).filter((moduleId) => !declaredModules.has(moduleId));
  if (undeclaredModules.length > 0) {
    return Result.fail(
      `${role.label} reaches ${undeclaredModules.join(', ')}, which the pinned release does not declare; the composition must declare those modules before this Role can be created`,
    );
  }
  // A capability the role names by hand must exist too: dropping it would silently grant less than the
  // reviewed policy says, which is exactly the drift the seed must report.
  const declaredKeys: ReadonlySet<string> = new Set(catalog.map((entry) => entry.key));
  const undeclaredNamed = [...new Set(Object.values(role.capabilityKeys ?? {}).flat())].filter(
    (key) => !declaredKeys.has(key),
  );
  if (undeclaredNamed.length > 0) {
    return Result.fail(`${role.label} names ${undeclaredNamed.join(', ')}, which the pinned release does not declare`);
  }
  const selectedKeys = new Set(policyRoleKeys(role, catalog));
  for (const [key, modes] of Object.entries(role.capabilityModes ?? {})) {
    const entry = entriesByKey.get(key);
    if (!selectedKeys.has(key) || invalidModeOverride(entry, modes, role, actorKind)) {
      return Result.fail(`${role.label} names invalid or broader modes for ${key}`);
    }
  }
  for (const [key, selector] of Object.entries(role.capabilitySelectors ?? {})) {
    const entry = entriesByKey.get(key);
    if (!selectedKeys.has(key) || invalidSelectorOverride(entry, selector)) {
      return Result.fail(`${role.label} selects ${selector} for ${key}, which is not a granted record selector`);
    }
  }
  const cells: Cell[] = [];
  for (const key of policyRoleKeys(role, catalog)) {
    const entry = entriesByKey.get(key);
    if (entry === undefined) {
      return Result.fail(`${role.label} names ${key}, which the pinned release does not declare`);
    }
    for (const mode of role.capabilityModes?.[key] ?? modesFor(entry, role, actorKind)) {
      cells.push({
        capabilityKey: CapabilityKeySchema.make(entry.key),
        mode,
        selector: { _tag: role.capabilitySelectors?.[key] ?? selectorOf(entry) },
      });
    }
  }
  return Result.succeed(cells);
};

/** The `approve` capability of one proposal reviewer, or `undefined` when the release omits it. */
export const proposalReviewKey = (catalog: readonly CatalogSnapshotEntry[]): string | undefined =>
  catalog.some((entry) => entry.key === PROPOSAL_REVIEW_CAPABILITY) ? PROPOSAL_REVIEW_CAPABILITY : undefined;

/**
 * The release entries the reviewed Roles compile against: the same builder the seed port publishes from, so
 * a Role and the release it pins are always compiled from one declaration set.
 */
export const policyReleaseEntries = (
  accessModules: readonly AccessCatalogModule[],
  installedModuleKeys: readonly string[],
): Result.Result<readonly CatalogSnapshotEntry[], string> =>
  Result.mapError(
    buildAccessCatalogRelease({
      installedModuleKeys: installedModuleKeysOf(installedModuleKeys, accessModules).map((moduleKey) =>
        ModuleKeySchema.make(moduleKey),
      ),
      modules: accessModules,
      publishedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    }),
    (cause) => `${cause.code}: ${cause.reason}`,
  ).pipe(Result.map((release) => release.entries));

/**
 * One compiled cell as the canonical fixture carries it: the exact capability, mode and selector slot. The
 * fixture is data, so the port that applies it needs no policy vocabulary and names no capability itself.
 */
export interface PolicyCellRow {
  readonly capabilityKey: string;
  readonly mode: Cell['mode'];
  readonly selector: Exclude<Cell['selector']['_tag'], 'targets'>;
}

/** The compiled cells of one reviewed Role, as the canonical fixture rows a seed port applies. */
export const policyRoleCellRows = (
  role: PolicyRole,
  catalog: readonly CatalogSnapshotEntry[],
  actorKind: PolicyActorKind = 'human',
): Result.Result<readonly PolicyCellRow[], string> =>
  Result.flatMap(policyRoleCells(role, catalog, actorKind), (cells) => {
    const rows: PolicyCellRow[] = [];
    for (const cell of cells) {
      const selector = Schema.decodeUnknownResult(RecordSelectorSchema)(cell.selector._tag);
      if (Result.isFailure(selector)) {
        return Result.fail('Reviewed source policy does not support explicit record targets');
      }
      rows.push({ capabilityKey: cell.capabilityKey, mode: cell.mode, selector: selector.success });
    }
    return Result.succeed(rows);
  });

/** One reviewed membership the fixture writes: a person, a kind and the company scope it belongs to. */
export interface PolicyMembershipRow {
  readonly kind: 'access_admin' | 'member' | 'owner';
  readonly legalEntityId?: string;
  readonly principalId: string;
}

/**
 * The memberships a reviewed Role implies for its holders. Management authority is a membership, never a
 * business cell (ADR-0030): a company administrator holds `access_admin` in its company, the tenant owner
 * holds `owner` in the tenant context, and both keep the `member` row administration stands on (O28).
 */
export const policyRoleMemberships = (input: {
  readonly legalEntityId?: string;
  readonly principalIds: readonly string[];
  readonly role: PolicyRole;
}): readonly PolicyMembershipRow[] =>
  input.principalIds.flatMap((principalId): readonly PolicyMembershipRow[] => {
    if (input.role.companyAdmin === true && input.legalEntityId !== undefined) {
      return [
        { kind: 'member', legalEntityId: input.legalEntityId, principalId },
        { kind: 'access_admin', legalEntityId: input.legalEntityId, principalId },
      ];
    }
    if (input.role.tenantOwner === true) {
      return [
        { kind: 'member', principalId },
        { kind: 'owner', principalId },
      ];
    }
    return [];
  });
