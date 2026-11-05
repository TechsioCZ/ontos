import { Context, DateTime, Effect, Layer, Option, Result } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import type { TenantProjectionIntent } from '../compiler/intent.ts';
import type {
  AccessChangeDecisionId,
  CapabilityKey,
  CatalogSnapshotId,
  LegalEntityId,
  PrincipalId,
  RoleId,
  RoleTemplateKey,
  TenantId,
} from '../ids.ts';
import { AccessChangeItemIdSchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import type { AccessMembership, AccessMembershipStoreService } from '../intent/memberships.ts';
import { AccessMembershipStore } from '../intent/memberships.ts';
import type { AccessProjectionWriterService } from '../intent/projection-writer.ts';
import { AccessProjectionWriter } from '../intent/projection-writer.ts';
import type { TenantIntentLoaderService } from '../intent/tenant-intent-loader.ts';
import { TenantIntentLoader } from '../intent/tenant-intent-loader.ts';
import type {
  AccessChangeDecision,
  AccessChangeItem,
  AccessChangeItemStatus,
  AccessRisk,
  Assignment,
  CatalogSnapshot,
  CatalogSnapshotEntry,
  Cell,
  Holder,
  RoleProvenance,
} from '../model.ts';
import { cellSlotKey } from '../model.ts';
import type { AccessConfigureBasis } from './authority.ts';
import { configureBasesOf } from './authority.ts';
import type { AdoptionSelection } from './adoption.ts';
import { planAdoption, planDecline } from './adoption.ts';
import type { AccessChangesCommandFailure } from './command-errors.ts';
import { accessChangesCommandError } from './command-errors.ts';
import { cellsWith, cellsWithout } from './cells.ts';
import { compareText, higherRisk } from './compare.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';
import type { AccessChangesStoreService, AccessChangesState } from './persistence/store.ts';
import { AccessChangesStore } from './persistence/store.ts';
import type { AdoptionPreview, AdoptionPreviewItem, AffectedHolder } from './preview.ts';
import { isActiveAssignment, previewAdoption } from './preview.ts';
import type { RoleWithRevision } from './role-edits.ts';
import { cellsOfCapability, findRole } from './role-edits.ts';
import type { AdoptionTarget } from './targets.ts';
import { capabilityEffectLabel, targetIssue, targetsCells } from './targets.ts';
import type { UndoSelection, UndoSkip } from './undo.ts';
import { laterRevocationsOf, planUndo } from './undo.ts';

/*
 * The one administration seam of the Novinky area: what an administrator is shown, and the three
 * decisions they may take. It is deliberately the only path that writes an access change from a
 * request.
 *
 * The rules already exist and are not repeated here: `adoption.ts` / `undo.ts` decide whether a
 * decision is allowed at all (risk, named effect, preview freshness, authority envelope, lineage,
 * undone-is-final); the store proves the write itself (item transition, revision compare-and-set,
 * grant incarnations, append-only decisions); `AccessProjectionWriter.reconcileTenant` is the one
 * fence, journal and verification, so this module never takes a lock, compiles a tuple or writes
 * SpiceDB.
 *
 * What this module adds is the part a browser must never supply: the actor, the tenant, the
 * instant, every identifier, the release, the configuration authority and the exact cells. A request
 * carries a selection, the release it was made against, the preview token the person saw and — for
 * a sensitive or critical item — the effect they confirmed. A repeated request (its idempotency key)
 * derives the same identifiers, so a retry resumes the decision it already recorded instead of
 * taking a second one.
 */

/** The one way this module adds an optional property: absent stays absent, never `undefined`. */
const withOptional = <Base extends object, Extra extends object>(base: Base, extra: Extra): Base & Extra => ({
  ...base,
  ...extra,
});

/** One cell a decision would change in one role, with the role it changes. */
export interface CellChange {
  readonly cell: Cell;
  readonly roleId: RoleId;
}

/** One role as both the role editor and the Novinky screen read it (one shape, never two). */
export interface RoleSummary {
  readonly cells: readonly Cell[];
  readonly headRevision: {
    readonly catalogSnapshotId: string;
    readonly cells: readonly Cell[];
    readonly createdAt: Date;
    readonly createdBy: string;
    readonly provenance: RoleProvenance;
    readonly revision: number;
    readonly roleRevisionId: string;
    readonly templateKey?: RoleTemplateKey;
  };
  /** Live assignments of this role at the read instant (active and inside their own period). */
  readonly holderCount: number;
  readonly legalEntityId?: LegalEntityId;
  readonly name: string;
  readonly roleId: RoleId;
  readonly scope: 'company' | 'tenant';
}

/** One Novinky item with what a person needs to decide it, and nothing that grants it. */
export interface AccessChangesItemView {
  /** The cells adopting this item would add to the roles it suggests, derived from the release. */
  readonly addedCells: readonly CellChange[];
  /**
   * The one batch rule (guarantee 2, D7c), computed in Core and never in a browser: an item may be
   * adopted together with others only when it is pending **in this release**, its effective risk is
   * routine **and** the adoption widens no role. A routine capability that grants something new is
   * still a change a person decides alone, naming the effect.
   */
  readonly batchEligible: boolean;
  readonly capabilityKey: CapabilityKey;
  readonly catalogSnapshotId: string;
  readonly createdAt: Date;
  /** The published entry of this release; absent for a removed capability (O1). */
  readonly entry?: CatalogSnapshotEntry;
  /** Who the decision would reach, from today's live assignments (a preview, never a grant). */
  readonly holders: readonly AffectedHolder[];
  readonly id: string;
  readonly kind: AccessChangeItem['kind'];
  readonly lineageFrom: readonly CapabilityKey[];
  /** The exact effect a sensitive or critical item asks a person to confirm (D7c). */
  readonly namedEffect?: string;
  /** The cells adopting this item would take away from the roles it suggests. */
  readonly removedCells: readonly CellChange[];
  readonly requiresIndividualDecision: boolean;
  /** The item's own risk raised by the entry a later release published (R2-H3). */
  readonly risk: AccessRisk;
  readonly status: AccessChangeItemStatus;
  readonly suggestedRoleIds: readonly RoleId[];
  /** At least one role would gain a cell and no role would lose one: this is not a replication. */
  readonly widens: boolean;
}

export interface AccessChangesReleaseView {
  readonly catalogSnapshotId: string;
  readonly digest: string;
  readonly entries: readonly CatalogSnapshotEntry[];
  readonly publishedAt: Date;
}

/** One tenant's Novinky screen: the release, its items and the decisions already taken. */
export interface AccessChangesView {
  readonly decisions: readonly AccessChangeDecision[];
  /** Every item this tenant has, oldest first, whatever its status (O54 keeps the decided ones). */
  readonly items: readonly AccessChangesItemView[];
  /** The affected-holder preview over the suggested roles of every pending item. */
  readonly preview: AdoptionPreview;
  readonly release?: AccessChangesReleaseView;
  /** Every role of the tenant, so an item's suggested roles are readable without a second call. */
  readonly roles: readonly RoleSummary[];
  readonly tenantId: TenantId;
}

/** One role as a decision would leave it: the cells before, the cells after, and the revision replaced. */
export interface RoleCellChange {
  readonly after: readonly Cell[];
  readonly before: readonly Cell[];
  /** The head revision the decision succeeds, so a stale editor is visible before the write (D23). */
  readonly expectedRevisionId: string;
  readonly roleId: RoleId;
}

/** What one previewed decision changes, item by item and cell by cell, before anything is written. */
export interface AccessChangesPreview {
  /** Every cell the decision would add, across the whole selection. */
  readonly addedCells: readonly CellChange[];
  /** The items that must be decided alone, naming the effect (guarantee 2, D7c). */
  readonly individualItemIds: readonly string[];
  /** The per-item view of an adoption: which items are batchable and which widen (never inferred). */
  readonly items: readonly AccessChangesItemView[];
  readonly preview: AdoptionPreview;
  /** Every cell the decision would take away. */
  readonly removedCells: readonly CellChange[];
  /** Every role the decision would edit, with its exact cells before and after (D23, D7b). */
  readonly roleChanges: readonly RoleCellChange[];
  /** The cells the decision deliberately leaves alone, with the reason (undo only; D7d). */
  readonly skipped: readonly UndoSkip[];
  /** The opaque token the decision must echo back; it is the preview's own fingerprint. */
  readonly token: string;
}

export interface AdoptChangesInput {
  /** The release this decision was made against; a newer release is a conflict, never a silent retry. */
  readonly catalogSnapshotId: string;
  /** Bounded request identity: the same key derives the same decision and revision identities. */
  readonly idempotencyKey: string;
  readonly itemIds: readonly string[];
  /** The exact effect the person confirmed, for an individual sensitive or critical item. */
  readonly namedEffect?: string;
  readonly previewToken: string;
}

export interface DeclineChangesInput {
  readonly idempotencyKey: string;
  readonly itemIds: readonly string[];
}

export interface UndoChangesInput {
  readonly catalogSnapshotId: string;
  readonly idempotencyKey: string;
  readonly itemIds: readonly string[];
  readonly previewToken: string;
}

/** What one decision did; the caller renders it and never re-decides anything. */
export interface AccessChangesReceipt {
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly decisionIds: readonly AccessChangeDecisionId[];
  /** A cell an undo deliberately left alone, with the reason it was unavailable (D7d). */
  readonly skipped: readonly UndoSkip[];
  readonly tenantId: TenantId;
}

export interface AccessChangesCommandsService {
  readonly adopt: (
    scope: OperationalScope,
    input: AdoptChangesInput,
  ) => Effect.Effect<AccessChangesReceipt, AccessChangesCommandFailure>;
  /** Declining narrows and grants nothing, so it never changes a role and needs no preview (O35). */
  readonly decline: (
    scope: OperationalScope,
    input: DeclineChangesInput,
  ) => Effect.Effect<AccessChangesReceipt, AccessChangesCommandFailure>;
  /** The preview of an adoption or of an undo, which reach different sets of roles. */
  readonly preview: (
    scope: OperationalScope,
    input: { readonly itemIds: readonly string[]; readonly mode: 'adopt' | 'undo' },
  ) => Effect.Effect<AccessChangesPreview, AccessChangesCommandFailure>;
  /** The Novinky screen of one tenant, gated by the caller before it is read. */
  readonly read: (scope: OperationalScope) => Effect.Effect<AccessChangesView, AccessChangesCommandFailure>;
  /**
   * The published release on its own, for a reader that asks the gate about a declaration the
   * release published (Proč?). Items, decisions, roles and the holder preview are all tenant state
   * of the Novinky screen, so none of them is read here: the catalog is platform-wide and there is
   * no scope to narrow it by, and `None` means nothing has been published yet.
   */
  readonly readRelease: () => Effect.Effect<Option.Option<AccessChangesReleaseView>, AccessChangesCommandFailure>;
  /**
   * The name of every role of the tenant, for a reader that renders a role id it already holds: an
   * explanation names the role that granted a decision. Roles only - no release, no intent projection,
   * no memberships, no holder counts - and, like `readRelease`, no policy inside, so the caller gates
   * the read with its own capability first.
   */
  readonly roleNames: (
    scope: OperationalScope,
  ) => Effect.Effect<ReadonlyMap<RoleId, string>, AccessChangesCommandFailure>;
  /** Undoes the exact cells one adoption wrote, never something revoked afterwards (D7, D7d). */
  readonly undo: (
    scope: OperationalScope,
    input: UndoChangesInput,
  ) => Effect.Effect<AccessChangesReceipt, AccessChangesCommandFailure>;
}

export class AccessChangesCommands extends Context.Service<AccessChangesCommands, AccessChangesCommandsService>()(
  '@app/core-runtime/access/changes/commands/AccessChangesCommands',
) {}

const principalHolder = (principalId: PrincipalId): Holder => ({ _tag: 'Principal', principalId });

/** Every assignment of a tenant, whatever scope it belongs to: the preview filters by its own instant. */
const assignmentsOf = (intent: TenantProjectionIntent): readonly Assignment[] =>
  intent.scopes.flatMap(({ assignments }) => assignments);

/**
 * The cells an adoption writes into one role are the module's own placement, never a browser's: the
 * entry declares the modes and the record scope it supports. A capability that declares several
 * record scopes cannot be adopted blind, because choosing one is the person's decision.
 */
export const adoptionTargetsOf = (
  entry: CatalogSnapshotEntry,
  roleId: RoleId,
): Result.Result<readonly AdoptionTarget[], AccessChangesError> => {
  const selectors = entry.selectors.length === 0 ? (['all'] as const) : entry.selectors;
  const [selector] = selectors;
  if (selector === undefined) {
    return Result.fail(
      accessChangesError('access_changes_target_invalid', `capability ${entry.key} declares no adoptable record scope`),
    );
  }
  if (selectors.length > 1) {
    return Result.fail(
      accessChangesError(
        'access_changes_target_invalid',
        `capability ${entry.key} declares several record scopes (${selectors.join(', ')}); an administrator chooses one instead of adopting all of them`,
      ),
    );
  }
  const target: AdoptionTarget = { modes: [...entry.modes], roleId, selector };
  const issue = targetIssue(entry, target);
  return issue === undefined
    ? Result.succeed([target])
    : Result.fail(accessChangesError('access_changes_target_invalid', issue));
};

const orderedChanges = (changes: readonly CellChange[]): readonly CellChange[] =>
  changes.toSorted(
    (left, right) =>
      compareText(left.roleId, right.roleId) || compareText(cellSlotKey(left.cell), cellSlotKey(right.cell)),
  );

/**
 * What adopting one item would change, read from the release and the roles' current cells — never
 * from the item's risk. A role that already holds a cell changes nothing for it (M1), a removed
 * capability takes away what the role still holds, and a target the module does not publish is not
 * adoptable at all, so it is never reported as a batchable no-op.
 */
export const adoptionDeltaOf = (
  item: AccessChangeItem,
  entries: ReadonlyMap<string, CatalogSnapshotEntry>,
  roles: readonly RoleWithRevision[],
): Result.Result<{ readonly added: readonly CellChange[]; readonly removed: readonly CellChange[] }, string> => {
  const entry = entries.get(item.capabilityKey);
  const added: CellChange[] = [];
  const removed: CellChange[] = [];
  const held: { readonly role: RoleWithRevision; readonly roleId: RoleId }[] = [];
  for (const roleId of item.suggestedRoleIds) {
    const role = findRole(roles, roleId);
    if (role !== undefined) {
      held.push({ role, roleId });
    }
  }
  if (entry === undefined) {
    for (const { role, roleId } of held) {
      removed.push(...cellsOfCapability(role, item.capabilityKey).map((cell) => ({ cell, roleId })));
    }
    return Result.succeed({ added: orderedChanges(added), removed: orderedChanges(removed) });
  }
  for (const { role, roleId } of held) {
    const targets = adoptionTargetsOf(entry, roleId);
    if (Result.isFailure(targets)) {
      return Result.fail(targets.failure.reason);
    }
    const present = new Set(role.revision.cells.map(cellSlotKey));
    for (const target of targets.success) {
      for (const cell of targetsCells(entry, target)) {
        if (!present.has(cellSlotKey(cell))) {
          added.push({ cell, roleId });
        }
      }
    }
  }
  return Result.succeed({ added: orderedChanges(added), removed: orderedChanges(removed) });
};

/** The selection a batch of items means: each item adopted into its own suggested roles. */
const selectionOf = (
  items: readonly AccessChangeItem[],
  entries: ReadonlyMap<string, CatalogSnapshotEntry>,
): Result.Result<readonly AdoptionSelection[], AccessChangesError> => {
  const selection: AdoptionSelection[] = [];
  for (const item of items) {
    const entry = entries.get(item.capabilityKey);
    const targets: AdoptionTarget[] = [];
    if (entry === undefined) {
      // A removed capability grants no cell: the adoption strips it from the roles that still hold
      // it, so its target set names exactly those roles and refuses when there are none.
      for (const roleId of item.suggestedRoleIds) {
        targets.push({ modes: ['run'], roleId, selector: 'all' });
      }
      if (targets.length === 0) {
        return Result.fail(
          accessChangesError(
            'access_changes_target_invalid',
            `no role holds capability ${item.capabilityKey}, so there is nothing to remove`,
          ),
        );
      }
    } else {
      for (const roleId of item.suggestedRoleIds) {
        const resolved = adoptionTargetsOf(entry, roleId);
        if (Result.isFailure(resolved)) {
          return Result.fail(resolved.failure);
        }
        targets.push(...resolved.success);
      }
    }
    const [firstTarget, ...restTargets] = targets;
    if (firstTarget === undefined) {
      return Result.fail(
        accessChangesError(
          'access_changes_target_invalid',
          `capability ${item.capabilityKey} suggests no role, so an administrator chooses one explicitly`,
        ),
      );
    }
    selection.push({ itemId: item.id, targets: [firstTarget, ...restTargets] });
  }
  return Result.succeed(selection);
};

/** The first plan that succeeds under any basis this person holds; the first refusal if none does. */
const firstAcceptedPlan = <Plan>(
  bases: readonly AccessConfigureBasis[],
  plan: (basis: AccessConfigureBasis) => Result.Result<Plan, AccessChangesError>,
): Result.Result<Plan, AccessChangesError> => {
  let refused: AccessChangesError | undefined;
  for (const basis of bases) {
    const planned = plan(basis);
    if (Result.isSuccess(planned)) {
      return planned;
    }
    refused ??= planned.failure;
  }
  return Result.fail(refused ?? accessChangesError('access_changes_authority_missing', 'no basis was checked'));
};

const individualIdsOf = (views: readonly AccessChangesItemView[]): readonly string[] => {
  const ids: string[] = [];
  for (const { id, requiresIndividualDecision } of views) {
    if (requiresIndividualDecision) {
      ids.push(id);
    }
  }
  return ids;
};

/**
 * Request identity: the same person, tenant, command and idempotency key always derive the same
 * batch, decision and successor-revision identifiers. A retry therefore finds its own recorded
 * decision instead of taking a second one (O54: a decision is never repeated).
 */
const batchIdOf = (input: {
  readonly command: 'adopt' | 'decline' | 'undo';
  readonly idempotencyKey: string;
  readonly tenantId: string;
}): string => stableUuid(['ontos.access.changes.batch', input.tenantId, input.command, input.idempotencyKey].join(':'));

/** A preview takes no decision, so its identities are derived from the tenant and never recorded. */
const previewBatchId = (tenantId: string): string => stableUuid(['ontos.access.changes.preview', tenantId].join(':'));

const decisionIdOf = (batchId: string, itemId: string): string =>
  stableUuid(['ontos.access.changes.decision', batchId, itemId].join(':'));

const revisionIdOf = (batchId: string, roleId: RoleId): string =>
  stableUuid(['ontos.access.changes.revision', batchId, roleId].join(':'));

const recordedBatch = (state: AccessChangesState, batchId: string): readonly AccessChangeDecision[] | undefined => {
  const recorded: AccessChangeDecision[] = [];
  for (const decision of state.decisions) {
    if (decision.batchId === batchId) {
      recorded.push(decision);
    }
  }
  return recorded.length === 0 ? undefined : recorded;
};

const decisionIdsOf = (decisions: readonly AccessChangeDecision[]): readonly AccessChangeDecisionId[] =>
  decisions.map(({ id }) => id);

const targetedRoleIds = (selection: readonly AdoptionSelection[]): readonly RoleId[] => {
  const seen = new Set<RoleId>();
  for (const { targets } of selection) {
    for (const { roleId } of targets) {
      seen.add(roleId);
    }
  }
  return [...seen].toSorted(compareText);
};

const roleIdsOfAdoption = (state: AccessChangesState, adoption: AccessChangeDecision): readonly RoleId[] => {
  const seen = new Set<RoleId>();
  for (const revisionId of adoption.roleRevisionIds) {
    const revision = state.revisions.find(({ id }) => id === revisionId);
    if (revision !== undefined) {
      seen.add(revision.roleId);
    }
  }
  return [...seen].toSorted(compareText);
};

const entryMapOf = (snapshot: CatalogSnapshot): ReadonlyMap<string, CatalogSnapshotEntry> =>
  new Map(snapshot.entries.map((entry) => [entry.key, entry]));

/** No release yet: every item is then a pending descriptor nothing may be adopted from (O1). */
const EMPTY_ENTRIES: ReadonlyMap<string, CatalogSnapshotEntry> = new Map();

const roleSummary = (role: RoleWithRevision, assignments: readonly Assignment[], at: Date): RoleSummary => {
  let holderCount = 0;
  for (const assignment of assignments) {
    if (assignment.roleId === role.role.id && isActiveAssignment(assignment, at)) {
      holderCount += 1;
    }
  }
  const head = withOptional(
    {
      catalogSnapshotId: role.revision.catalogSnapshotId,
      cells: Object.freeze([...role.revision.cells]),
      createdAt: role.revision.createdAt,
      createdBy: role.revision.createdBy,
      provenance: role.revision.provenance,
      revision: role.revision.revision,
      roleRevisionId: role.revision.id,
    },
    role.revision.templateKey === undefined ? {} : { templateKey: role.revision.templateKey },
  );
  const summary = withOptional(
    {
      cells: Object.freeze([...role.revision.cells]),
      headRevision: Object.freeze(head),
      holderCount,
      name: role.role.name,
      roleId: role.role.id,
      scope: role.role.legalEntityId === undefined ? ('tenant' as const) : ('company' as const),
    },
    role.role.legalEntityId === undefined ? {} : { legalEntityId: role.role.legalEntityId },
  );
  return Object.freeze(summary);
};

const holdersOf = (item: AccessChangeItem, assignments: readonly Assignment[], at: Date): readonly AffectedHolder[] => {
  const suggested = new Set<RoleId>(item.suggestedRoleIds);
  const holders: AffectedHolder[] = [];
  for (const assignment of assignments) {
    if (suggested.has(assignment.roleId) && isActiveAssignment(assignment, at)) {
      holders.push({
        assignmentIncarnationId: assignment.incarnationId,
        holder: assignment.holder,
        roleId: assignment.roleId,
      });
    }
  }
  return holders.toSorted(
    (left, right) =>
      compareText(left.roleId, right.roleId) ||
      compareText(left.assignmentIncarnationId, right.assignmentIncarnationId),
  );
};

interface RoleChangesRequest {
  readonly added: readonly CellChange[];
  readonly removed: readonly CellChange[];
  readonly roles: readonly RoleWithRevision[];
}

/** The exact before/after of every role a set of cell changes touches, against its head revision. */
const roleChangesOf = (input: RoleChangesRequest): readonly RoleCellChange[] => {
  const touched = new Set<RoleId>();
  for (const change of input.added) {
    touched.add(change.roleId);
  }
  for (const change of input.removed) {
    touched.add(change.roleId);
  }
  const roleChanges: RoleCellChange[] = [];
  for (const roleId of [...touched].toSorted(compareText)) {
    const role = findRole(input.roles, roleId);
    if (role !== undefined) {
      const added: Cell[] = [];
      const removed: Cell[] = [];
      for (const change of input.added) {
        if (change.roleId === roleId) {
          added.push(change.cell);
        }
      }
      for (const change of input.removed) {
        if (change.roleId === roleId) {
          removed.push(change.cell);
        }
      }
      roleChanges.push({
        after: cellsWith(cellsWithout(role.revision.cells, removed), added),
        before: role.revision.cells,
        expectedRevisionId: role.revision.id,
        roleId,
      });
    }
  }
  return roleChanges;
};

/** The same before/after from the plans an undo would take, which already computed the next cells. */
const roleChangesOfEdits = (
  edits: readonly { readonly cells: readonly Cell[]; readonly roleId: RoleId; readonly sourceRevisionId: string }[],
  roles: readonly RoleWithRevision[],
): readonly RoleCellChange[] => {
  const roleChanges: RoleCellChange[] = [];
  for (const edit of edits) {
    const role = findRole(roles, edit.roleId);
    if (role !== undefined) {
      roleChanges.push({
        after: edit.cells,
        before: role.revision.cells,
        expectedRevisionId: edit.sourceRevisionId,
        roleId: edit.roleId,
      });
    }
  }
  return roleChanges;
};

/** What one item would do to the tenant's roles, and the batch rule read from it (never from risk). */
export interface ItemDecisionFacts {
  readonly addedCells: readonly CellChange[];
  readonly batchEligible: boolean;
  readonly removedCells: readonly CellChange[];
  /** A role gains a cell and no role loses one: this item grants something new (P10 safety rule). */
  readonly widens: boolean;
}

export interface ItemDecisionFactsRequest {
  readonly entries: ReadonlyMap<string, CatalogSnapshotEntry>;
  readonly item: AccessChangeItem;
  /** The release being adopted: an item of an older release is never batched with this one. */
  readonly releaseId: string;
  readonly roles: readonly RoleWithRevision[];
}

/**
 * The one place the batch rule is decided. `widens` is derived from the cells the adoption would
 * write, so a routine capability that grants something new is still `batchEligible: false`; an item
 * whose target the module does not publish cannot be planned at all and is never offered as a batch.
 */
export const itemDecisionFactsOf = (input: ItemDecisionFactsRequest): ItemDecisionFacts => {
  const entry = input.entries.get(input.item.capabilityKey);
  const risk = entry === undefined ? input.item.risk : higherRisk(input.item.risk, entry.risk);
  const delta = adoptionDeltaOf(input.item, input.entries, input.roles);
  const added = Result.isSuccess(delta) ? delta.success.added : [];
  const removed = Result.isSuccess(delta) ? delta.success.removed : [];
  const widens = Result.isFailure(delta) ? true : added.length > 0 && removed.length === 0;
  return {
    addedCells: added,
    batchEligible:
      input.item.status === 'pending' &&
      risk === 'routine' &&
      !widens &&
      input.item.catalogSnapshotId === input.releaseId,
    removedCells: removed,
    widens,
  };
};

interface ItemViewRequest {
  readonly assignments: readonly Assignment[];
  readonly at: Date;
  readonly entries: ReadonlyMap<string, CatalogSnapshotEntry>;
  readonly item: AccessChangeItem;
  readonly releaseId: string;
  readonly roles: readonly RoleWithRevision[];
}

const itemView = (input: ItemViewRequest): AccessChangesItemView => {
  const { assignments, at, entries, item, releaseId, roles } = input;
  const entry = entries.get(item.capabilityKey);
  const risk = entry === undefined ? item.risk : higherRisk(item.risk, entry.risk);
  const facts = itemDecisionFactsOf({ entries, item, releaseId, roles });
  const added = facts.addedCells;
  const removed = facts.removedCells;
  const { batchEligible, widens } = facts;
  const view = withOptional(
    withOptional(
      {
        addedCells: Object.freeze(added),
        batchEligible,
        capabilityKey: item.capabilityKey,
        catalogSnapshotId: item.catalogSnapshotId,
        createdAt: item.createdAt,
        holders: Object.freeze(holdersOf(item, assignments, at)),
        id: item.id,
        kind: item.kind,
        lineageFrom: Object.freeze([...item.lineageFrom]),
        removedCells: Object.freeze(removed),
        requiresIndividualDecision: risk !== 'routine',
        risk,
        status: item.status,
        suggestedRoleIds: Object.freeze([...item.suggestedRoleIds]),
        widens,
      },
      entry === undefined ? {} : { entry },
    ),
    entry === undefined ? {} : { namedEffect: capabilityEffectLabel(entry) },
  );
  return Object.freeze(view);
};

const releaseView = (snapshot: CatalogSnapshot): AccessChangesReleaseView =>
  Object.freeze({
    catalogSnapshotId: snapshot.id,
    digest: snapshot.digest,
    entries: Object.freeze([...snapshot.entries]),
    publishedAt: snapshot.publishedAt,
  });

/** The published release as a consumer reads it: the release and nothing of the tenant. */
export const publishedReleaseView = (
  snapshot: Option.Option<CatalogSnapshot>,
): Option.Option<AccessChangesReleaseView> =>
  Option.isSome(snapshot) ? Option.some(releaseView(snapshot.value)) : Option.none();

/** The names of a tenant's roles, keyed by id: the only part of the screen a label read needs. */
export const roleNamesOf = (roles: readonly RoleWithRevision[]): ReadonlyMap<RoleId, string> =>
  new Map(roles.map(({ role }) => [role.id, role.name]));

/**
 * A decision taken for one company reaches that company's roles only (O88), and a tenant decision keeps
 * reaching whichever roles tenant authority already covers - a tenant-wide decision narrowed by hand
 * would write into a company the person was not validated for. Refused, never silently filtered: a
 * partially written decision is the one outcome nobody can review afterwards.
 */
export const decisionScopeIssue = (input: {
  readonly legalEntityId?: LegalEntityId;
  readonly roleIds: readonly RoleId[];
  readonly roles: readonly RoleWithRevision[];
}): AccessChangesError | undefined => {
  const { legalEntityId } = input;
  if (legalEntityId === undefined) {
    return undefined;
  }
  const outside: string[] = [];
  for (const roleId of input.roleIds) {
    const role = findRole(input.roles, roleId);
    if (role !== undefined && role.role.legalEntityId !== legalEntityId) {
      outside.push(roleId);
    }
  }
  return outside.length === 0
    ? undefined
    : accessChangesError(
        'access_changes_target_invalid',
        `the decision is taken for company ${legalEntityId}, and roles ${outside.toSorted(compareText).join(', ')} belong to another scope`,
      );
};

const storeFailure = (failure: { readonly code: string; readonly reason: string }) =>
  failure.code === 'access_changes_store_unavailable'
    ? accessChangesCommandError('access_changes_command_unavailable', `${failure.code}: ${failure.reason}`)
    : accessChangesCommandError('access_changes_command_conflict', `${failure.code}: ${failure.reason}`);

const intentFailure = (failure: AccessIntentError) =>
  failure.code === 'access_intent_unavailable'
    ? accessChangesCommandError('access_changes_command_unavailable', `${failure.code}: ${failure.reason}`)
    : accessChangesCommandError('access_changes_command_conflict', `${failure.code}: ${failure.reason}`);

const projectionFailure = (failure: { readonly code: string; readonly reason: string }) =>
  failure.code === 'access_projection_write_fence_refused' || failure.code === 'access_projection_write_plan_refused'
    ? accessChangesCommandError('access_changes_command_conflict', `${failure.code}: ${failure.reason}`)
    : accessChangesCommandError('access_changes_command_unavailable', `${failure.code}: ${failure.reason}`);

const releaseMissing = () =>
  accessChangesCommandError(
    'access_changes_command_release_missing',
    'No release has been published yet, so there is nothing to adopt',
  );

const authorityAbsent = () =>
  accessChangesCommandError(
    'access_changes_command_authority_absent',
    'This person administers no scope of this tenant, so they decide no change',
  );

const adoptionOf = (
  state: AccessChangesState,
  itemId: string,
): Result.Result<AccessChangeDecision, AccessChangesCommandFailure> => {
  const undone = new Set<string>();
  for (const decision of state.decisions) {
    if (decision.decision === 'undo' && decision.undoesDecisionId !== undefined) {
      undone.add(decision.undoesDecisionId);
    }
  }
  const adoption = state.decisions.find(
    (decision) => decision.decision === 'adopt' && decision.itemId === itemId && !undone.has(decision.id),
  );
  return adoption === undefined
    ? Result.fail(
        accessChangesError(
          'access_changes_adoption_not_undoable',
          `item ${itemId} has no adoption of this tenant that is still undoable`,
        ),
      )
    : Result.succeed(adoption);
};

const undoSelectionOf = (
  state: AccessChangesState,
  itemId: string,
): Result.Result<UndoSelection, AccessChangesCommandFailure> => {
  const item = state.items.find(({ id }) => id === itemId);
  return item === undefined
    ? Result.fail(
        accessChangesError('access_changes_item_unavailable', `item ${itemId} is not part of this tenant's changes`),
      )
    : Result.map(adoptionOf(state, itemId), (adoption) => ({ adoption, item }));
};

interface ConfigureBasesRequest {
  readonly at: Date;
  readonly held: readonly AccessMembership[];
  readonly intent: TenantProjectionIntent;
  readonly scope: OperationalScope;
}

const basesFor = (input: ConfigureBasesRequest): readonly AccessConfigureBasis[] =>
  configureBasesOf({
    actor: PrincipalIdSchema.make(input.scope.principalId),
    at: input.at,
    intent: input.intent,
    memberships: input.held,
  });

/**
 * The seam as a service. Its collaborators are read from the request's context, so a caller cannot
 * hand it a store, a loader or a projection writer of its own choosing.
 */
/** The collaborators of the seam, as the request's context provides them (never a caller's choice). */
export type AccessChangesCommandContext =
  | AccessChangesStore
  | AccessMembershipStore
  | AccessProjectionWriter
  | TenantIntentLoader;

export const makeAccessChangesCommands = (
  context: Context.Context<AccessChangesCommandContext>,
): AccessChangesCommandsService => {
  const store: AccessChangesStoreService = Context.get(context, AccessChangesStore);
  const memberships: Pick<AccessMembershipStoreService, 'loadTenantMemberships'> = Context.get(
    context,
    AccessMembershipStore,
  );
  const projection: Pick<AccessProjectionWriterService, 'reconcileTenant'> = Context.get(
    context,
    AccessProjectionWriter,
  );
  const loader: Pick<TenantIntentLoaderService, 'loadProjection'> = Context.get(context, TenantIntentLoader);

  const loadProjection = (scope: OperationalScope) => loader.loadProjection(scope).pipe(Effect.mapError(intentFailure));
  const loadMemberships = (scope: OperationalScope) =>
    memberships.loadTenantMemberships(scope).pipe(Effect.mapError(intentFailure));
  const loadChanges = (scope: OperationalScope) => store.loadTenantChanges(scope).pipe(Effect.mapError(storeFailure));
  const loadRelease = store.loadPublishedCatalog().pipe(Effect.mapError(storeFailure));
  // Idempotent, so a retry of a recorded batch repairs a projection the first attempt failed to write.
  const reconcile = (scope: OperationalScope) =>
    projection.reconcileTenant({ scope }).pipe(Effect.mapError(projectionFailure));

  const read = Effect.fn('AccessChangesCommands.read')(function* readEffect(scope: OperationalScope) {
    const at = yield* DateTime.nowAsDate;
    const [state, release, intent] = yield* Effect.all(
      [loadChanges(scope), loadRelease, loadProjection(scope)] as const,
      { concurrency: 1 },
    );
    const snapshot = Option.getOrUndefined(release);
    const entries = snapshot === undefined ? EMPTY_ENTRIES : entryMapOf(snapshot);
    const assignments = assignmentsOf(intent);
    const pending: AdoptionPreviewItem[] = [];
    for (const item of state.items) {
      if (item.status === 'pending') {
        pending.push({ itemId: AccessChangeItemIdSchema.make(item.id), roleIds: item.suggestedRoleIds });
      }
    }
    const view = withOptional(
      {
        decisions: Object.freeze([...state.decisions]),
        items: Object.freeze(
          state.items.map((item) =>
            itemView({ assignments, at, entries, item, releaseId: snapshot?.id ?? '', roles: state.roles }),
          ),
        ),
        preview: previewAdoption({ assignments, at, items: pending }),
        roles: Object.freeze(state.roles.map((role) => roleSummary(role, assignments, at))),
        tenantId: TenantIdSchema.make(scope.tenantId),
      },
      snapshot === undefined ? {} : { release: releaseView(snapshot) },
    );
    return view;
  });

  const preview = Effect.fn('AccessChangesCommands.preview')(function* previewEffect(
    scope: OperationalScope,
    input: { readonly itemIds: readonly string[]; readonly mode: 'adopt' | 'undo' },
  ) {
    const at = yield* DateTime.nowAsDate;
    const [state, release, intent, held] = yield* Effect.all(
      [loadChanges(scope), loadRelease, loadProjection(scope), loadMemberships(scope)] as const,
      { concurrency: 1 },
    );
    const snapshot = Option.getOrUndefined(release);
    if (snapshot === undefined) {
      return yield* releaseMissing();
    }
    const selected: AccessChangeItem[] = [];
    for (const itemId of input.itemIds) {
      const item = state.items.find(({ id }) => id === itemId);
      if (item !== undefined) {
        selected.push(item);
      }
    }
    if (selected.length !== input.itemIds.length) {
      return yield* accessChangesError(
        'access_changes_item_unavailable',
        `one of ${input.itemIds.join(', ')} is not part of this tenant's changes`,
      );
    }
    const entries = entryMapOf(snapshot);
    const assignments = assignmentsOf(intent);
    const bases = basesFor({ at, held, intent, scope });
    if (bases.length === 0) {
      return yield* authorityAbsent();
    }
    if (input.mode === 'undo') {
      const selections: UndoSelection[] = [];
      for (const item of selected) {
        const resolved = undoSelectionOf(state, item.id);
        if (Result.isFailure(resolved)) {
          return yield* resolved.failure;
        }
        selections.push(resolved.success);
      }
      const previewItems: AdoptionPreviewItem[] = [];
      for (const { adoption, item } of selections) {
        previewItems.push({
          itemId: AccessChangeItemIdSchema.make(item.id),
          roleIds: roleIdsOfAdoption(state, adoption),
        });
      }
      const undoPreview = previewAdoption({ assignments, at, items: previewItems });
      const targeted = [...new Set(selections.flatMap(({ adoption }) => roleIdsOfAdoption(state, adoption)))].toSorted(
        compareText,
      );
      const batchId = previewBatchId(scope.tenantId);
      const revocations = laterRevocationsOf(state.revisions, selections);
      const planned = firstAcceptedPlan(bases, (basis) =>
        planUndo({
          actor: principalHolder(PrincipalIdSchema.make(scope.principalId)),
          assignments,
          authority: basis,
          batchId,
          decidedAt: at,
          decisionIds: new Map(selections.map(({ item }) => [item.id, decisionIdOf(batchId, item.id)])),
          entries: snapshot.entries,
          membership: intent,
          newRevisionIds: new Map(targeted.map((roleId) => [roleId, revisionIdOf(batchId, roleId)])),
          preview: undoPreview,
          revisions: state.revisions,
          revocations,
          roles: state.roles,
          selections,
          tenantId: scope.tenantId,
        }),
      );
      if (Result.isFailure(planned)) {
        return yield* planned.failure;
      }
      const added: CellChange[] = [];
      const removed: CellChange[] = [];
      for (const edit of planned.success.roleEdits) {
        for (const cell of edit.addedCells) {
          added.push({ cell, roleId: edit.roleId });
        }
        for (const cell of edit.removedCells) {
          removed.push({ cell, roleId: edit.roleId });
        }
      }
      return {
        addedCells: orderedChanges(added),
        individualItemIds: [],
        items: [],
        preview: undoPreview,
        removedCells: orderedChanges(removed),
        roleChanges: roleChangesOfEdits(planned.success.roleEdits, state.roles),
        skipped: planned.success.skipped,
        token: undoPreview.fingerprint,
      };
    }
    const views = selected.map((item) =>
      itemView({ assignments, at, entries, item, releaseId: snapshot.id, roles: state.roles }),
    );
    const added: CellChange[] = [];
    const removed: CellChange[] = [];
    for (const view of views) {
      added.push(...view.addedCells);
      removed.push(...view.removedCells);
    }
    const adoptionPreview = previewAdoption({
      assignments,
      at,
      items: views.map(({ id, suggestedRoleIds }) => ({
        itemId: AccessChangeItemIdSchema.make(id),
        roleIds: suggestedRoleIds,
      })),
    });
    return {
      addedCells: orderedChanges(added),
      individualItemIds: individualIdsOf(views),
      items: views,
      preview: adoptionPreview,
      removedCells: orderedChanges(removed),
      roleChanges: roleChangesOf({ added, removed, roles: state.roles }),
      skipped: [],
      token: adoptionPreview.fingerprint,
    };
  });

  const adopt = Effect.fn('AccessChangesCommands.adopt')(function* adoptEffect(
    scope: OperationalScope,
    input: AdoptChangesInput,
  ) {
    const at = yield* DateTime.nowAsDate;
    const batchId = batchIdOf({ command: 'adopt', idempotencyKey: input.idempotencyKey, tenantId: scope.tenantId });
    const [initial, release, intent, held] = yield* Effect.all(
      [loadChanges(scope), loadRelease, loadProjection(scope), loadMemberships(scope)] as const,
      { concurrency: 1 },
    );
    const snapshot = Option.getOrUndefined(release);
    if (snapshot === undefined) {
      return yield* releaseMissing();
    }
    const resumed = recordedBatch(initial, batchId);
    if (resumed !== undefined) {
      yield* reconcile(scope);
      return {
        catalogSnapshotId: snapshot.id,
        decisionIds: decisionIdsOf(resumed),
        skipped: [],
        tenantId: TenantIdSchema.make(scope.tenantId),
      };
    }
    if (input.catalogSnapshotId !== snapshot.id) {
      return yield* accessChangesCommandError(
        'access_changes_command_conflict',
        `release ${snapshot.id} is published, not the ${input.catalogSnapshotId} this decision was prepared against`,
      );
    }
    const entries = entryMapOf(snapshot);
    const requested = new Set<string>(input.itemIds);
    const selection = selectionOf(
      initial.items.filter(({ id }) => requested.has(id)),
      entries,
    );
    if (Result.isFailure(selection)) {
      return yield* selection.failure;
    }
    const assignments = assignmentsOf(intent);
    const adoptionPreview = previewAdoption({
      assignments,
      at,
      items: selection.success.map(({ itemId, targets }) => ({
        itemId: AccessChangeItemIdSchema.make(itemId),
        roleIds: targets.map(({ roleId }) => roleId),
      })),
    });
    if (adoptionPreview.fingerprint !== input.previewToken) {
      return yield* accessChangesError(
        'access_changes_preview_stale',
        `the affected holders changed since the preview was shown (${input.previewToken} -> ${adoptionPreview.fingerprint})`,
      );
    }
    const bases = basesFor({ at, held, intent, scope });
    if (bases.length === 0) {
      return yield* authorityAbsent();
    }
    const namedEffects = new Map<string, string>(
      input.namedEffect === undefined ? [] : [[input.itemIds.at(0) ?? '', input.namedEffect]],
    );
    const roleIds = targetedRoleIds(selection.success);
    const planned = firstAcceptedPlan(bases, (basis) =>
      planAdoption({
        actor: principalHolder(PrincipalIdSchema.make(scope.principalId)),
        assignments,
        authority: basis,
        batchId,
        decidedAt: at,
        decisionIds: new Map(input.itemIds.map((itemId) => [itemId, decisionIdOf(batchId, itemId)])),
        entries: snapshot.entries,
        items: initial.items,
        membership: intent,
        namedEffects,
        newRevisionIds: new Map(roleIds.map((roleId) => [roleId, revisionIdOf(batchId, roleId)])),
        preview: adoptionPreview,
        roles: initial.roles,
        selections: selection.success,
        tenantId: scope.tenantId,
      }),
    );
    if (Result.isFailure(planned)) {
      return yield* planned.failure;
    }
    yield* store
      .recordAdoption({ catalogSnapshotId: snapshot.id, plan: planned.success, scope })
      .pipe(Effect.mapError(storeFailure));
    yield* reconcile(scope);
    return {
      catalogSnapshotId: snapshot.id,
      decisionIds: decisionIdsOf(planned.success.decisions),
      skipped: [],
      tenantId: TenantIdSchema.make(scope.tenantId),
    };
  });

  const decline = Effect.fn('AccessChangesCommands.decline')(function* declineEffect(
    scope: OperationalScope,
    input: DeclineChangesInput,
  ) {
    const at = yield* DateTime.nowAsDate;
    const batchId = batchIdOf({ command: 'decline', idempotencyKey: input.idempotencyKey, tenantId: scope.tenantId });
    const [state, release, intent, held] = yield* Effect.all(
      [loadChanges(scope), loadRelease, loadProjection(scope), loadMemberships(scope)] as const,
      { concurrency: 1 },
    );
    const snapshot = Option.getOrUndefined(release);
    if (snapshot === undefined) {
      return yield* releaseMissing();
    }
    const resumed = recordedBatch(state, batchId);
    if (resumed !== undefined) {
      yield* reconcile(scope);
      return {
        catalogSnapshotId: snapshot.id,
        decisionIds: decisionIdsOf(resumed),
        skipped: [],
        tenantId: TenantIdSchema.make(scope.tenantId),
      };
    }
    const bases = basesFor({ at, held, intent, scope });
    if (bases.length === 0) {
      return yield* authorityAbsent();
    }
    const planned = firstAcceptedPlan(bases, (basis) =>
      planDecline({
        actor: principalHolder(PrincipalIdSchema.make(scope.principalId)),
        authority: basis,
        batchId,
        decidedAt: at,
        decisionIds: new Map(input.itemIds.map((itemId) => [itemId, decisionIdOf(batchId, itemId)])),
        itemIds: input.itemIds,
        items: state.items,
        tenantId: scope.tenantId,
      }),
    );
    if (Result.isFailure(planned)) {
      return yield* planned.failure;
    }
    yield* store.recordDecline({ plan: planned.success, scope }).pipe(Effect.mapError(storeFailure));
    yield* reconcile(scope);
    return {
      catalogSnapshotId: snapshot.id,
      decisionIds: decisionIdsOf(planned.success.decisions),
      skipped: [],
      tenantId: TenantIdSchema.make(scope.tenantId),
    };
  });

  const readRelease = Effect.fn('AccessChangesCommands.readRelease')(function* readReleaseEffect() {
    return publishedReleaseView(yield* loadRelease);
  });

  const roleNames = Effect.fn('AccessChangesCommands.roleNames')(function* roleNamesEffect(scope: OperationalScope) {
    return roleNamesOf((yield* loadChanges(scope)).roles);
  });

  const undo = Effect.fn('AccessChangesCommands.undo')(function* undoEffect(
    scope: OperationalScope,
    input: UndoChangesInput,
  ) {
    const at = yield* DateTime.nowAsDate;
    const batchId = batchIdOf({ command: 'undo', idempotencyKey: input.idempotencyKey, tenantId: scope.tenantId });
    const [state, release, intent, held] = yield* Effect.all(
      [loadChanges(scope), loadRelease, loadProjection(scope), loadMemberships(scope)] as const,
      { concurrency: 1 },
    );
    const snapshot = Option.getOrUndefined(release);
    if (snapshot === undefined) {
      return yield* releaseMissing();
    }
    const resumed = recordedBatch(state, batchId);
    if (resumed !== undefined) {
      yield* reconcile(scope);
      return {
        catalogSnapshotId: snapshot.id,
        decisionIds: decisionIdsOf(resumed),
        skipped: [],
        tenantId: TenantIdSchema.make(scope.tenantId),
      };
    }
    if (input.catalogSnapshotId !== snapshot.id) {
      return yield* accessChangesCommandError(
        'access_changes_command_conflict',
        `release ${snapshot.id} is published, not the ${input.catalogSnapshotId} this decision was prepared against`,
      );
    }
    const selections: UndoSelection[] = [];
    for (const itemId of input.itemIds) {
      const resolved = undoSelectionOf(state, itemId);
      if (Result.isFailure(resolved)) {
        return yield* resolved.failure;
      }
      selections.push(resolved.success);
    }
    const assignments = assignmentsOf(intent);
    const previewItems: AdoptionPreviewItem[] = [];
    for (const { adoption, item } of selections) {
      previewItems.push({
        itemId: AccessChangeItemIdSchema.make(item.id),
        roleIds: roleIdsOfAdoption(state, adoption),
      });
    }
    const undoPreview = previewAdoption({ assignments, at, items: previewItems });
    if (undoPreview.fingerprint !== input.previewToken) {
      return yield* accessChangesError(
        'access_changes_preview_stale',
        `the affected holders changed since the preview was shown (${input.previewToken} -> ${undoPreview.fingerprint})`,
      );
    }
    const bases = basesFor({ at, held, intent, scope });
    if (bases.length === 0) {
      return yield* authorityAbsent();
    }
    const targeted = [...new Set(selections.flatMap(({ adoption }) => roleIdsOfAdoption(state, adoption)))].toSorted(
      compareText,
    );
    const revocations = laterRevocationsOf(state.revisions, selections);
    const planned = firstAcceptedPlan(bases, (basis) =>
      planUndo({
        actor: principalHolder(PrincipalIdSchema.make(scope.principalId)),
        assignments,
        authority: basis,
        batchId,
        decidedAt: at,
        decisionIds: new Map(selections.map(({ item }) => [item.id, decisionIdOf(batchId, item.id)])),
        entries: snapshot.entries,
        membership: intent,
        newRevisionIds: new Map(targeted.map((roleId) => [roleId, revisionIdOf(batchId, roleId)])),
        preview: undoPreview,
        revisions: state.revisions,
        revocations,
        roles: state.roles,
        selections,
        tenantId: scope.tenantId,
      }),
    );
    if (Result.isFailure(planned)) {
      return yield* planned.failure;
    }
    yield* store
      .recordUndo({ catalogSnapshotId: snapshot.id, plan: planned.success, scope })
      .pipe(Effect.mapError(storeFailure));
    yield* reconcile(scope);
    return {
      catalogSnapshotId: snapshot.id,
      decisionIds: decisionIdsOf(planned.success.decisions),
      skipped: planned.success.skipped,
      tenantId: TenantIdSchema.make(scope.tenantId),
    };
  });

  return Object.freeze({ adopt, decline, preview, read, readRelease, roleNames, undo });
};

export const AccessChangesCommandsLive: Layer.Layer<
  AccessChangesCommands,
  never,
  AccessChangesStore | AccessMembershipStore | AccessProjectionWriter | TenantIntentLoader
> = Layer.effect(
  AccessChangesCommands,
  Effect.gen(function* accessChangesCommandsLayer() {
    const context = yield* Effect.context<AccessChangesCommandContext>();
    return makeAccessChangesCommands(context);
  }),
);

/** The wire contract re-exports what a consumer needs, so no consumer reaches into Core's internals. */
export { AccessPreviewFingerprintSchema } from './preview.ts';
export { CellSchema, HolderSchema } from '../model.ts';
export { AccessChangesError, accessChangesError } from './errors.ts';
export type { AffectedHolder, AdoptionPreview } from './preview.ts';
export type { Cell, CatalogSnapshotEntry } from '../model.ts';
export type { RoleWithRevision } from './role-edits.ts';
export type { UndoSkip, UndoSkipReason } from './undo.ts';
export {
  AccessChangesCommandError,
  accessChangesCommandError,
  ACCESS_CHANGES_COMMAND_ERROR_CODES,
} from './command-errors.ts';
export type { AccessChangesCommandErrorCode, AccessChangesCommandFailure } from './command-errors.ts';
