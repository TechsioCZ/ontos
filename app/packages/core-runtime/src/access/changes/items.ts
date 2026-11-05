import { Result, Schema } from 'effect';

import { CapabilityKeySchema, RoleIdSchema } from '../ids.ts';
import type { CapabilityKey, RoleId } from '../ids.ts';
import type { AccessChangeItem, Assignment, CatalogSnapshotEntry, Cell, PlacementLevel } from '../model.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  AccessChangeItemSchema,
  AccessChangeKindSchema,
  AccessRiskSchema,
} from '../model.ts';
import type { CatalogChangeDraft } from './catalog-diff.ts';
import { lineageParents } from './catalog-diff.ts';
import { compareText } from './compare.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';
import type { AdoptionPreview } from './preview.ts';
import { previewAdoption } from './preview.ts';
import type { RoleWithRevision } from './role-edits.ts';

/** A Novinky item before it has an identity: the change, its risk and the roles it suggests. */
export const ChangeItemBlueprintSchema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  kind: AccessChangeKindSchema,
  lineageFrom: Schema.Array(CapabilityKeySchema).check(Schema.isUnique()),
  risk: AccessRiskSchema,
  suggestedRoleIds: Schema.Array(RoleIdSchema).check(Schema.isUnique()),
});
export type ChangeItemBlueprint = typeof ChangeItemBlueprintSchema.Type;

export interface ChangeItemBlueprintInput {
  readonly drafts: readonly CatalogChangeDraft[];
  readonly entries: readonly CatalogSnapshotEntry[];
  readonly roles: readonly RoleWithRevision[];
}

export interface ChangeItemPlanInput {
  readonly assignments: readonly Assignment[];
  readonly blueprints: readonly ChangeItemBlueprint[];
  readonly catalogSnapshotId: string;
  readonly createdAt: Date;
  /** Item identity per change, keyed by `changeItemIdentityKey`; Core mints these ids. */
  readonly itemIds: ReadonlyMap<string, string>;
  readonly tenantId: string;
}

export interface ChangeItemPlan {
  readonly items: readonly AccessChangeItem[];
  /** The affected-holder preview an administrator must see before deciding. */
  readonly preview: AdoptionPreview;
}

const PLACEMENT_LEVEL_ORDER = ['basic', 'extended', 'manage'] as const satisfies readonly PlacementLevel[];

const placementRank = (level: PlacementLevel): number => PLACEMENT_LEVEL_ORDER.indexOf(level);

const decodeBlueprint = Schema.decodeUnknownResult(ChangeItemBlueprintSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeItem = Schema.decodeUnknownResult(AccessChangeItemSchema, ACCESS_MODEL_PARSE_OPTIONS);

/** Identity of one change inside one release; the same change never becomes two items. */
export const changeItemIdentityKey = (kind: string, capabilityKey: string): string => `${kind}:${capabilityKey}`;

/**
 * A role follows a suggested row: it already holds a capability of the same editor group at an
 * equally broad or broader level. The suggestion is the module's own placement, generalized over
 * the tenant's roles; it still grants nothing until a person adopts the item.
 */
const reachesPlacement = (
  cells: readonly Cell[],
  entry: CatalogSnapshotEntry,
  entries: ReadonlyMap<CapabilityKey, CatalogSnapshotEntry>,
): boolean =>
  cells.some(({ capabilityKey }) => {
    const held = entries.get(capabilityKey);
    return (
      held !== undefined &&
      held.placement.group === entry.placement.group &&
      placementRank(held.placement.level) >= placementRank(entry.placement.level)
    );
  });

const holdsAny = (cells: readonly Cell[], keys: ReadonlySet<CapabilityKey>): boolean =>
  cells.some(({ capabilityKey }) => keys.has(capabilityKey));

/**
 * Suggested roles are derived, never granted: a continuity change suggests every holder of its
 * predecessor, and a new capability suggests the roles that already follow its editor row. A
 * `risk_changed` successor of a rename names no lineage of its own, so its predecessor keys are
 * read from the entry: the roles that hold the old key are exactly the ones the change reaches.
 */
export const suggestRoleIds = (
  draft: CatalogChangeDraft,
  roles: readonly RoleWithRevision[],
  entries: ReadonlyMap<CapabilityKey, CatalogSnapshotEntry>,
): readonly RoleId[] => {
  const lineageKeys = new Set<CapabilityKey>(
    draft.lineageFrom.length === 0 ? [draft.capabilityKey, ...lineageParents(draft.entry)] : draft.lineageFrom,
  );
  const suggested = roles.filter(({ revision }) =>
    draft.kind === 'new'
      ? reachesPlacement(revision.cells, draft.entry, entries)
      : holdsAny(revision.cells, lineageKeys),
  );
  return suggested.map(({ role }) => role.id).toSorted(compareText);
};

export const blueprintChangeItems = (
  input: ChangeItemBlueprintInput,
): Result.Result<readonly ChangeItemBlueprint[], AccessChangesError> => {
  const entries = new Map(input.entries.map((entry) => [entry.key, entry]));
  const blueprints: ChangeItemBlueprint[] = [];
  for (const draft of input.drafts) {
    const decoded = decodeBlueprint({
      capabilityKey: draft.capabilityKey,
      kind: draft.kind,
      lineageFrom: draft.lineageFrom,
      risk: draft.entry.risk,
      suggestedRoleIds: suggestRoleIds(draft, input.roles, entries),
    });
    if (Result.isFailure(decoded)) {
      return Result.fail(accessChangesError('access_changes_item_invalid', decoded.failure.message));
    }
    blueprints.push(decoded.success);
  }
  return Result.succeed(Object.freeze(blueprints));
};

/**
 * Materials the Novinky list: one pending item per change, with its suggested roles, plus the
 * holder preview over those suggestions. Nothing here writes a cell or a decision.
 */
export const planChangeItems = (input: ChangeItemPlanInput): Result.Result<ChangeItemPlan, AccessChangesError> => {
  const items: AccessChangeItem[] = [];
  for (const blueprint of input.blueprints) {
    const identity = changeItemIdentityKey(blueprint.kind, blueprint.capabilityKey);
    const id = input.itemIds.get(identity);
    if (id === undefined) {
      return Result.fail(
        accessChangesError('access_changes_identity_missing', `no identity was provided for change ${identity}`),
      );
    }
    const decoded = decodeItem({
      capabilityKey: blueprint.capabilityKey,
      catalogSnapshotId: input.catalogSnapshotId,
      createdAt: input.createdAt,
      id,
      kind: blueprint.kind,
      lineageFrom: blueprint.lineageFrom,
      risk: blueprint.risk,
      status: 'pending',
      suggestedRoleIds: blueprint.suggestedRoleIds,
      tenantId: input.tenantId,
    });
    if (Result.isFailure(decoded)) {
      return Result.fail(accessChangesError('access_changes_item_invalid', decoded.failure.message));
    }
    items.push(decoded.success);
  }
  const preview = previewAdoption({
    assignments: input.assignments,
    at: input.createdAt,
    items: items.map((item) => ({ itemId: item.id, roleIds: item.suggestedRoleIds })),
  });
  return Result.succeed(Object.freeze({ items: Object.freeze(items), preview }));
};
