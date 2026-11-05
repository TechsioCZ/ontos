import { Match, Result, Schema } from 'effect';

import { CapabilityKeySchema, RoleIdSchema } from '../ids.ts';
import type { CapabilityKey, PrincipalId, RoleId } from '../ids.ts';
import type {
  AccessChangeDecision,
  Assignment,
  CatalogSnapshotEntry,
  Cell,
  Holder,
  Role,
  RoleRevision,
} from '../model.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  AccessChangeDecisionSchema,
  AccessChangeItemSchema,
  cellSlotKey,
} from '../model.ts';
import type { AccessConfigureBasis, GrantedCell } from './authority.ts';
import { configureAuthorityIssue, deciderIssue } from './authority.ts';
import { compareText } from './compare.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';
import type { AdoptionPreview } from './preview.ts';
import {
  AdoptionPreviewSchema,
  previewAdoption,
  previewHasAgent,
  previewPrincipals,
  previewScopeIds,
  samePreview,
} from './preview.ts';
import type { RoleCellEditDraft, RoleWithRevision } from './role-edits.ts';
import { cellContentKey, findRole, planRoleCellEdit, RoleCellEditSchema } from './role-edits.ts';

export const UndoSkipReasonSchema = Schema.Literals([
  'already_present',
  'already_removed',
  'capability_not_published',
  'cell_revoked_later',
  'role_missing',
]);
export type UndoSkipReason = typeof UndoSkipReasonSchema.Type;

/** A cell an undo deliberately left alone, with the reason that made it unavailable. */
export const UndoSkipSchema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  reason: UndoSkipReasonSchema,
  roleId: RoleIdSchema,
  slot: Schema.String,
});
export type UndoSkip = typeof UndoSkipSchema.Type;

/** A revocation recorded after an adoption; undo never restores one (D7d). */
export const CellRevocationSchema = Schema.Struct({
  revokedAt: Schema.Date,
  roleId: RoleIdSchema,
  /** The grant slot removed, explicit targets included: a revoked target slot stays revoked too. */
  slot: Schema.String,
});
export type CellRevocation = typeof CellRevocationSchema.Type;

export const UndoSelectionSchema = Schema.Struct({
  adoption: AccessChangeDecisionSchema,
  item: AccessChangeItemSchema,
});
export type UndoSelection = typeof UndoSelectionSchema.Type;

export const UndoPlanSchema = Schema.Struct({
  decisions: Schema.Array(AccessChangeDecisionSchema),
  items: Schema.Array(AccessChangeItemSchema),
  preview: AdoptionPreviewSchema,
  roleEdits: Schema.Array(RoleCellEditSchema),
  skipped: Schema.Array(UndoSkipSchema),
});
export type UndoPlan = typeof UndoPlanSchema.Type;

export interface UndoRequest {
  readonly actor: Holder;
  readonly assignments: readonly Assignment[];
  readonly authority: AccessConfigureBasis;
  readonly batchId: string;
  readonly decidedAt: Date;
  readonly decisionIds: ReadonlyMap<string, string>;
  /** The currently published catalog: a cell is restorable only for a published capability (O1). */
  readonly entries: readonly CatalogSnapshotEntry[];
  readonly newRevisionIds: ReadonlyMap<string, string>;
  /** The preview the person saw; it is checked whenever the undo widens access (D7b). */
  readonly preview: AdoptionPreview;
  readonly revisions: readonly RoleRevision[];
  /** Cells revoked after the adoption, which an undo must never restore (D7d). */
  readonly revocations: readonly CellRevocation[];
  readonly roles: readonly RoleWithRevision[];
  readonly selections: readonly UndoSelection[];
  readonly tenantId: string;
}

interface DecisionInput {
  readonly batchId: string;
  readonly decidedAt: Date;
  readonly decidedBy: string;
  readonly decision: 'undo';
  readonly id: string;
  readonly itemId: string;
  readonly roleRevisionIds: readonly string[];
  readonly tenantId: string;
  readonly undoesDecisionId: string;
}

interface RoleDelta {
  readonly added: readonly Cell[];
  readonly afterRevision: RoleRevision;
  readonly removed: readonly Cell[];
  readonly roleId: RoleId;
}

interface UndoOperation {
  readonly itemId: string;
  readonly remove: readonly Cell[];
  readonly restore: readonly Cell[];
  readonly roleId: RoleId;
  readonly skips: readonly UndoSkip[];
}

const decodeUndoPlan = Schema.decodeUnknownResult(UndoPlanSchema, ACCESS_MODEL_PARSE_OPTIONS);

const slotOf = (cell: Cell): string => cellSlotKey(cell);

const agentCannotDecide = (reason: string): AccessChangesError =>
  accessChangesError('access_changes_agent_cannot_decide', reason);

const identityMissing = (reason: string): AccessChangesError =>
  accessChangesError('access_changes_identity_missing', reason);

const itemUnavailable = (reason: string): AccessChangesError =>
  accessChangesError('access_changes_item_unavailable', reason);

const deciderOf = (actor: Holder): PrincipalId | null =>
  Match.value(actor).pipe(
    Match.tags({ Agent: () => null, Principal: ({ principalId }) => principalId }),
    Match.exhaustive,
  );

const skipped = (cell: Cell, roleId: RoleId, reason: UndoSkipReason): UndoSkip => ({
  capabilityKey: cell.capabilityKey,
  reason,
  roleId,
  slot: slotOf(cell),
});

const predecessorOf = (revisions: readonly RoleRevision[], after: RoleRevision): RoleRevision | undefined =>
  after.revision <= 1
    ? undefined
    : revisions.find((candidate) => candidate.roleId === after.roleId && candidate.revision === after.revision - 1);

/**
 * What one adoption changed in each role, restricted to the item's own capability and its lineage
 * (R2-M8). One batch writes one revision per role and every item's decision names that revision, so
 * a whole-revision diff would let an undo of one item strip the cells another item added while that
 * item stays adopted. The earlier adoption is read from the revision history rather than from the
 * current cells, so a later edit is never mistaken for the adoption's effect either.
 */
const roleDeltasOf = (
  revisions: readonly RoleRevision[],
  selection: UndoSelection,
): Result.Result<readonly RoleDelta[], AccessChangesError> => {
  const keys = new Set<CapabilityKey>([selection.item.capabilityKey, ...selection.item.lineageFrom]);
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const deltas: RoleDelta[] = [];
  for (const revisionId of selection.adoption.roleRevisionIds) {
    const after = byId.get(revisionId);
    if (after === undefined) {
      return Result.fail(
        accessChangesError(
          'access_changes_undo_conflict',
          `revision ${revisionId} of decision ${selection.adoption.id} is not in the role history`,
        ),
      );
    }
    const predecessor = predecessorOf(revisions, after);
    if (predecessor === undefined && after.revision > 1) {
      return Result.fail(
        accessChangesError(
          'access_changes_undo_conflict',
          `revision ${after.revision - 1} of role ${after.roleId} is not in the role history`,
        ),
      );
    }
    // Compared by full content, so a cell whose ceiling or exact records the adoption replaced in
    // place is both an addition (the new content) and a removal (the content it replaced).
    const beforeCells = predecessor?.cells ?? [];
    const beforeContents = new Set(beforeCells.map(cellContentKey));
    const afterContents = new Set(after.cells.map(cellContentKey));
    deltas.push({
      added: after.cells.filter((cell) => keys.has(cell.capabilityKey) && !beforeContents.has(cellContentKey(cell))),
      afterRevision: after,
      removed: beforeCells.filter((cell) => keys.has(cell.capabilityKey) && !afterContents.has(cellContentKey(cell))),
      roleId: after.roleId,
    });
  }
  return Result.succeed(deltas);
};

const revokedLater = (
  revocations: readonly CellRevocation[],
  adoption: AccessChangeDecision,
  roleId: RoleId,
  cell: Cell,
): boolean =>
  revocations.some(
    (revocation) =>
      revocation.roleId === roleId && revocation.slot === slotOf(cell) && adoption.decidedAt < revocation.revokedAt,
  );

/**
 * The revocations the role history records after each selected adoption: a slot of the item's
 * capability (or its lineage) that some revision from the adoption's own onwards held and the next
 * revision no longer holds. An adoption that replaced a cell in place leaves the original slot vacant
 * once the replacement is removed, so without these an undo would hand back what a person removed.
 */
export const laterRevocationsOf = (
  revisions: readonly RoleRevision[],
  selections: readonly UndoSelection[],
): readonly CellRevocation[] => {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const revocations: CellRevocation[] = [];
  for (const { adoption, item } of selections) {
    const keys = new Set<CapabilityKey>([item.capabilityKey, ...item.lineageFrom]);
    for (const revisionId of adoption.roleRevisionIds) {
      const adopted = byId.get(revisionId);
      if (adopted === undefined) {
        continue;
      }
      const history = revisions
        .filter(({ revision, roleId }) => roleId === adopted.roleId && revision >= adopted.revision)
        .toSorted((left, right) => left.revision - right.revision);
      for (const [index, held] of history.entries()) {
        const next = history[index + 1];
        if (next === undefined) {
          continue;
        }
        const kept = new Set(next.cells.map(slotOf));
        for (const cell of held.cells) {
          if (keys.has(cell.capabilityKey) && !kept.has(slotOf(cell))) {
            revocations.push({ revokedAt: next.createdAt, roleId: adopted.roleId, slot: slotOf(cell) });
          }
        }
      }
    }
  }
  return revocations;
};

const missingRoleOperation = (itemId: string, delta: RoleDelta): UndoOperation => ({
  itemId,
  remove: [],
  restore: [],
  roleId: delta.roleId,
  skips: [...delta.added, ...delta.removed].map((cell) => skipped(cell, delta.roleId, 'role_missing')),
});

/**
 * Undo removes what the adoption added and restores what it removed — but only what is still
 * restorable: a capability the catalog no longer publishes, a cell revoked afterwards, or a role
 * that no longer exists stays untouched (D7d).
 */
const roleOperation = (
  request: UndoRequest,
  selection: UndoSelection,
  delta: RoleDelta,
  publishedKeys: ReadonlySet<string>,
): UndoOperation => {
  const role = findRole(request.roles, delta.roleId);
  if (role === undefined) {
    return missingRoleOperation(selection.item.id, delta);
  }
  const present = new Set(role.revision.cells.map(cellContentKey));
  const occupied = new Set(role.revision.cells.map(slotOf));
  const remove: Cell[] = [];
  const restore: Cell[] = [];
  const skips: UndoSkip[] = [];
  // Only the exact content the adoption wrote is taken back; a slot changed since then is left alone.
  for (const cell of delta.added) {
    if (present.has(cellContentKey(cell))) {
      remove.push(cell);
    } else {
      skips.push(skipped(cell, delta.roleId, 'already_removed'));
    }
  }
  const vacated = new Set(remove.map(slotOf));
  for (const cell of delta.removed) {
    // A slot still held by content this undo does not take back already holds a newer grant.
    if (occupied.has(slotOf(cell)) && !vacated.has(slotOf(cell))) {
      skips.push(skipped(cell, delta.roleId, 'already_present'));
    } else if (!publishedKeys.has(cell.capabilityKey)) {
      skips.push(skipped(cell, delta.roleId, 'capability_not_published'));
    } else if (revokedLater(request.revocations, selection.adoption, delta.roleId, cell)) {
      skips.push(skipped(cell, delta.roleId, 'cell_revoked_later'));
    } else {
      restore.push(cell);
    }
  }
  return { itemId: selection.item.id, remove, restore, roleId: delta.roleId, skips };
};

const compareOperations = (left: UndoOperation, right: UndoOperation): number =>
  compareText(left.roleId, right.roleId) || compareText(left.itemId, right.itemId);

const uniqueCells = (cells: readonly Cell[]): readonly Cell[] => {
  const seen = new Map<string, Cell>();
  for (const cell of cells) {
    seen.set(slotOf(cell), cell);
  }
  const ordered: Cell[] = [];
  for (const slot of [...seen.keys()].toSorted(compareText)) {
    const cell = seen.get(slot);
    if (cell !== undefined) {
      ordered.push(cell);
    }
  }
  return ordered;
};

const cellsFor = (
  operations: readonly UndoOperation[],
  roleId: RoleId,
  kind: 'remove' | 'restore',
): readonly Cell[] => {
  const cells: Cell[] = [];
  for (const operation of operations) {
    if (operation.roleId === roleId) {
      cells.push(...operation[kind]);
    }
  }
  return uniqueCells(cells);
};

const planEdits = (
  request: UndoRequest,
  operations: readonly UndoOperation[],
): Result.Result<readonly RoleCellEditDraft[], AccessChangesError> => {
  const roleIds = [...new Set(operations.map(({ roleId }) => roleId))].toSorted(compareText);
  const edits: RoleCellEditDraft[] = [];
  for (const roleId of roleIds) {
    const role = findRole(request.roles, roleId);
    if (role === undefined) {
      continue;
    }
    const additions = cellsFor(operations, roleId, 'restore');
    const removals = cellsFor(operations, roleId, 'remove');
    if (additions.length > 0 || removals.length > 0) {
      const targetRevisionId = request.newRevisionIds.get(roleId);
      if (targetRevisionId === undefined) {
        return Result.fail(identityMissing(`no successor revision was provided for role ${roleId}`));
      }
      const edit = planRoleCellEdit(role, additions, removals, targetRevisionId);
      if (edit !== undefined) {
        edits.push(edit);
      }
    }
  }
  return Result.succeed(edits);
};

/** The cells an undo gives back, each with the entry that declares it, checked like an adoption (R2-H4). */
const grantedCells = (request: UndoRequest, operations: readonly UndoOperation[]): readonly GrantedCell[] => {
  const entries = new Map(request.entries.map((entry) => [entry.key, entry]));
  const granted: GrantedCell[] = [];
  for (const operation of operations) {
    for (const cell of operation.restore) {
      const entry = entries.get(cell.capabilityKey);
      if (entry !== undefined) {
        granted.push({ cell, entry, roleId: operation.roleId });
      }
    }
  }
  return granted;
};

const touchedRoles = (request: UndoRequest, operations: readonly UndoOperation[]): readonly Role[] => {
  const roles: Role[] = [];
  const seen = new Set<RoleId>();
  for (const { remove, restore, roleId } of operations) {
    const touched = remove.length > 0 || restore.length > 0;
    const role = findRole(request.roles, roleId);
    if (touched && role !== undefined && !seen.has(roleId)) {
      seen.add(roleId);
      roles.push(role.role);
    }
  }
  return roles;
};

const revisionIdsForItem = (
  edits: readonly RoleCellEditDraft[],
  operations: readonly UndoOperation[],
  itemId: string,
): readonly string[] => {
  const roleIds = new Set<RoleId>();
  for (const operation of operations) {
    if (operation.itemId === itemId) {
      roleIds.add(operation.roleId);
    }
  }
  const revisionIds: string[] = [];
  for (const { roleId, targetRevisionId } of edits) {
    if (roleIds.has(roleId)) {
      revisionIds.push(targetRevisionId);
    }
  }
  return revisionIds;
};

/** Only an adopted item can be undone, and only through the adoption decision that adopted it. */
const undoableSelectionIssue = (request: UndoRequest, selection: UndoSelection): AccessChangesError | null => {
  const itemId = selection.item.id;
  if (selection.item.tenantId !== request.tenantId) {
    return itemUnavailable(`item ${itemId} belongs to tenant ${selection.item.tenantId}`);
  }
  if (selection.item.status !== 'adopted') {
    return itemUnavailable(`item ${itemId} is ${selection.item.status}, not adopted`);
  }
  return selection.adoption.decision === 'adopt' && selection.adoption.itemId === itemId
    ? null
    : accessChangesError(
        'access_changes_adoption_not_undoable',
        `decision ${selection.adoption.id} is not an adoption of item ${itemId}`,
      );
};

/**
 * Undo is append-only and narrow: it removes exactly the cells the adoption added and restores only
 * what the adoption removed. It never rewrites a later change back, never revives an approval, and
 * never brings back something revoked in the meantime (D7, D7d).
 */
export const planUndo = (request: UndoRequest): Result.Result<UndoPlan, AccessChangesError> => {
  const deciderReason = deciderIssue(request.actor);
  if (deciderReason !== null) {
    return Result.fail(agentCannotDecide(deciderReason));
  }
  const decidedBy = deciderOf(request.actor);
  if (decidedBy === null) {
    return Result.fail(agentCannotDecide('the decider is not a person'));
  }
  if (request.selections.length === 0) {
    return Result.fail(itemUnavailable('no item was selected'));
  }
  const publishedKeys = new Set<string>(request.entries.map(({ key }) => key));
  const operations: UndoOperation[] = [];
  for (const selection of request.selections) {
    const selectionProblem = undoableSelectionIssue(request, selection);
    if (selectionProblem !== null) {
      return Result.fail(selectionProblem);
    }
    const deltas = roleDeltasOf(request.revisions, selection);
    if (Result.isFailure(deltas)) {
      return Result.fail(deltas.failure);
    }
    for (const delta of deltas.success) {
      operations.push(roleOperation(request, selection, delta, publishedKeys));
    }
  }
  const ordered = operations.toSorted(compareOperations);
  const previewItems = [];
  for (const { item } of request.selections) {
    const seen = new Set<RoleId>();
    for (const operation of ordered) {
      if (operation.itemId === item.id) {
        seen.add(operation.roleId);
      }
    }
    previewItems.push({ itemId: item.id, roleIds: [...seen].toSorted(compareText) });
  }
  const preview = previewAdoption({ assignments: request.assignments, at: request.decidedAt, items: previewItems });
  const restoring = ordered.some(({ restore }) => restore.length > 0);
  if (restoring && !samePreview(preview, request.preview)) {
    return Result.fail(
      accessChangesError(
        'access_changes_preview_stale',
        `the affected holders changed since the preview was shown (${request.preview.fingerprint} -> ${preview.fingerprint})`,
      ),
    );
  }
  const authorityProblem = configureAuthorityIssue({
    actor: decidedBy,
    affectedAgentHolder: previewHasAgent(preview),
    affectedAssignmentScopeIds: previewScopeIds(preview, request.assignments),
    affectedHolderPrincipals: previewPrincipals(preview),
    at: request.decidedAt,
    authority: request.authority,
    capabilityKeys: uniqueCells(ordered.flatMap(({ restore }) => restore)).map(({ capabilityKey }) => capabilityKey),
    grantedCells: grantedCells(request, ordered),
    roles: touchedRoles(request, ordered),
    tenantId: request.tenantId,
  });
  if (authorityProblem !== undefined) {
    return Result.fail(authorityProblem);
  }
  const edits = planEdits(request, ordered);
  if (Result.isFailure(edits)) {
    return Result.fail(edits.failure);
  }
  const decisions: DecisionInput[] = [];
  for (const selection of request.selections) {
    const itemId = selection.item.id;
    const decisionId = request.decisionIds.get(itemId);
    if (decisionId === undefined) {
      return Result.fail(identityMissing(`no decision identity was provided for item ${itemId}`));
    }
    decisions.push({
      batchId: request.batchId,
      decidedAt: request.decidedAt,
      decidedBy,
      decision: 'undo',
      id: decisionId,
      itemId,
      roleRevisionIds: revisionIdsForItem(edits.success, ordered, itemId),
      tenantId: request.tenantId,
      undoesDecisionId: selection.adoption.id,
    });
  }
  return Result.mapError(
    decodeUndoPlan({
      decisions,
      items: request.selections.map(({ item }) => ({ ...item, status: 'undone' })),
      preview,
      roleEdits: edits.success,
      skipped: ordered.flatMap(({ skips }) => skips),
    }),
    (issue) => accessChangesError('access_changes_item_invalid', issue.message),
  );
};
