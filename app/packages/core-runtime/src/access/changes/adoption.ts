import { Match, Predicate, Result, Schema } from 'effect';

import { AccessChangeItemIdSchema } from '../ids.ts';
import type { CapabilityKey, PrincipalId, RoleId } from '../ids.ts';
import type { AccessChangeItem, AccessRisk, Assignment, CatalogSnapshotEntry, Cell, Holder, Role } from '../model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, AccessChangeDecisionSchema, AccessChangeItemSchema } from '../model.ts';
import type { AccessConfigureBasis, GrantedCell, GrantorMembership } from './authority.ts';
import { configureAuthorityIssue, deciderIssue, liveDelegation } from './authority.ts';
import { withOptional } from '../decision/optional.ts';
import { compareText, higherRisk } from './compare.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';
import type { AdoptionPreview } from './preview.ts';
import {
  AdoptionPreviewSchema,
  checkedHoldersOf,
  CheckedHoldersSchema,
  isAgentHolder,
  previewAdoption,
  previewScopeIds,
  samePreview,
} from './preview.ts';
import type { RoleCellEditDraft, RoleWithRevision } from './role-edits.ts';
import {
  cellsOfCapability,
  findRole,
  planRoleCellEdit,
  roleCellEditChanges,
  RoleCellEditSchema,
} from './role-edits.ts';
import type { AdoptionTarget } from './targets.ts';
import { AdoptionTargetSchema, capabilityEffectLabel, targetsCells, targetIssue } from './targets.ts';

/** What one item is adopted into: the roles, modes and record scope a person confirms (D7c). */
export const AdoptionSelectionSchema = Schema.Struct({
  itemId: AccessChangeItemIdSchema,
  targets: Schema.NonEmptyArray(AdoptionTargetSchema),
});
export type AdoptionSelection = typeof AdoptionSelectionSchema.Type;

export const AdoptionPlanSchema = Schema.Struct({
  /** Present when a delegation authorized the plan: the holders its envelope checked, per edited role. */
  checkedHolders: Schema.optionalKey(CheckedHoldersSchema),
  decisions: Schema.Array(AccessChangeDecisionSchema),
  items: Schema.Array(AccessChangeItemSchema),
  preview: AdoptionPreviewSchema,
  roleEdits: Schema.Array(RoleCellEditSchema),
});
export type AdoptionPlan = typeof AdoptionPlanSchema.Type;

export const DeclinePlanSchema = Schema.Struct({
  decisions: Schema.Array(AccessChangeDecisionSchema),
  items: Schema.Array(AccessChangeItemSchema),
});
export type DeclinePlan = typeof DeclinePlanSchema.Type;

export interface AdoptionRequest {
  readonly actor: Holder;
  readonly assignments: readonly Assignment[];
  readonly authority: AccessConfigureBasis;
  readonly batchId: string;
  readonly decidedAt: Date;
  /** Decision identity per item; Core mints these ids. */
  readonly decisionIds: ReadonlyMap<string, string>;
  /** The published catalog: an item is adoptable only while its capability is published (O1). */
  readonly entries: readonly CatalogSnapshotEntry[];
  /** The tenant's change items as currently recorded; a selection must resolve to one of them. */
  readonly items: readonly AccessChangeItem[];
  /** The tenant's live members and suspensions, so a grantor whose membership ended counts for nothing. */
  readonly membership: GrantorMembership;
  /** The effect label a person confirmed, per sensitive or critical item. */
  readonly namedEffects: ReadonlyMap<string, string>;
  /** Successor revision identity per role that changes; Core mints these ids. */
  readonly newRevisionIds: ReadonlyMap<string, string>;
  /** The preview the person actually saw; a different intent makes it stale (D7b). */
  readonly preview: AdoptionPreview;
  readonly roles: readonly RoleWithRevision[];
  readonly selections: readonly AdoptionSelection[];
  readonly tenantId: string;
}

export interface DeclineRequest {
  readonly actor: Holder;
  readonly authority: AccessConfigureBasis;
  readonly batchId: string;
  readonly decidedAt: Date;
  readonly decisionIds: ReadonlyMap<string, string>;
  readonly itemIds: readonly string[];
  readonly items: readonly AccessChangeItem[];
  readonly tenantId: string;
}

/** A decision before decoding: the same shape the model owns, with the ids this request supplies. */
interface DecisionInput {
  readonly batchId: string;
  readonly decidedAt: Date;
  readonly decidedBy: string;
  readonly decision: 'adopt' | 'decline';
  readonly id: string;
  readonly itemId: string;
  readonly roleRevisionIds: readonly string[];
  readonly tenantId: string;
}

interface ResolvedSelection {
  readonly entry: CatalogSnapshotEntry | undefined;
  readonly item: AccessChangeItem;
  readonly targets: readonly AdoptionTarget[];
}

/** One item's cells in one role. */
interface Contribution {
  readonly cells: readonly Cell[];
  readonly itemId: string;
  readonly roleId: RoleId;
}

const decodeAdoptionPlan = Schema.decodeUnknownResult(AdoptionPlanSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeDeclinePlan = Schema.decodeUnknownResult(DeclinePlanSchema, ACCESS_MODEL_PARSE_OPTIONS);

const agentCannotDecide = (reason: string): AccessChangesError =>
  accessChangesError('access_changes_agent_cannot_decide', reason);

const delegationOutOfEnvelope = (reason: string): AccessChangesError =>
  accessChangesError('access_changes_delegation_out_of_envelope', reason);

const identityMissing = (reason: string): AccessChangesError =>
  accessChangesError('access_changes_identity_missing', reason);

const itemUnavailable = (reason: string): AccessChangesError =>
  accessChangesError('access_changes_item_unavailable', reason);

const noItemSelected = (): AccessChangesError => itemUnavailable('no item was selected');

const deciderOf = (actor: Holder): PrincipalId | null =>
  Match.value(actor).pipe(
    Match.tags({ Agent: () => null, Principal: ({ principalId }) => principalId }),
    Match.exhaustive,
  );

/**
 * O54: an undone item is final. Only a pending item is decided again; re-adopting means a new
 * pending item with lineage to the undone one, never a second decision on the same row.
 */
const decidedItemIssue = (item: AccessChangeItem): string =>
  item.status === 'undone'
    ? `item ${item.id} was undone; adopting or declining it again is a new item with lineage to it`
    : `item ${item.id} is already ${item.status}`;

const resolveItem = (request: AdoptionRequest, itemId: string): Result.Result<AccessChangeItem, AccessChangesError> => {
  const item = request.items.find(({ id }) => id === itemId);
  if (item === undefined) {
    return Result.fail(itemUnavailable(`item ${itemId} is not part of this tenant's changes`));
  }
  if (item.tenantId !== request.tenantId) {
    return Result.fail(itemUnavailable(`item ${itemId} belongs to tenant ${item.tenantId}`));
  }
  return item.status === 'pending' ? Result.succeed(item) : Result.fail(itemUnavailable(decidedItemIssue(item)));
};

/**
 * A capability is adoptable only while the module publishes it (O1), and a removed capability is
 * adoptable only while it stays removed: a reinstall is a new descriptor, not a cleanup.
 */
const publicationIssue = (item: AccessChangeItem, entry: CatalogSnapshotEntry | undefined): string | undefined => {
  if (item.kind === 'removed') {
    return entry === undefined
      ? undefined
      : `capability ${item.capabilityKey} is published again; adopt the new descriptor instead`;
  }
  return entry === undefined
    ? `capability ${item.capabilityKey} is not published; a release creates the item before it can be adopted`
    : undefined;
};

const targetsIssue = (
  request: AdoptionRequest,
  entry: CatalogSnapshotEntry | undefined,
  targets: readonly AdoptionTarget[],
): string | undefined => {
  const roleIds = targets.map(({ roleId }) => roleId);
  const duplicate = roleIds.find((roleId, index) => roleIds.indexOf(roleId) !== index);
  if (duplicate !== undefined) {
    return `role ${duplicate} is targeted twice`;
  }
  for (const roleId of roleIds) {
    const role = findRole(request.roles, roleId);
    if (role === undefined) {
      return `role ${roleId} is not part of this tenant's roles`;
    }
    if (role.role.tenantId !== request.tenantId) {
      return `role ${roleId} belongs to tenant ${role.role.tenantId}`;
    }
  }
  if (entry === undefined) {
    return undefined;
  }
  const issues: string[] = [];
  for (const target of targets) {
    const issue = targetIssue(entry, target);
    if (issue !== undefined) {
      issues.push(issue);
    }
  }
  return issues.at(0);
};

const resolveSelection = (
  request: AdoptionRequest,
  selection: AdoptionSelection,
  entries: ReadonlyMap<string, CatalogSnapshotEntry>,
): Result.Result<ResolvedSelection, AccessChangesError> =>
  Result.flatMap(resolveItem(request, selection.itemId), (item) => {
    const entry = entries.get(item.capabilityKey);
    const issue = publicationIssue(item, entry);
    if (issue !== undefined) {
      return Result.fail(itemUnavailable(issue));
    }
    const targetProblem = targetsIssue(request, entry, selection.targets);
    return targetProblem === undefined
      ? Result.succeed({ entry, item, targets: selection.targets })
      : Result.fail(accessChangesError('access_changes_target_invalid', targetProblem));
  });

/**
 * The risk a decision must be judged by, read fresh from the published entry (R2-H3). An item
 * frozen as routine stays pending while a later release raises its key to critical, so the item's
 * own risk is a floor and never the whole answer: the entry decides how the release is adopted.
 * A removed capability has no entry, and stripping it narrows access, so its own risk stands.
 */
const effectiveRisk = ({ entry, item }: ResolvedSelection): AccessRisk =>
  entry === undefined ? item.risk : higherRisk(item.risk, entry.risk);

/**
 * Routine releases are adopted as one batch decision; anything sensitive or critical is a single
 * decision that names the effect it grants (guarantee 2, D7c). A person cannot confirm an effect
 * they were not shown, so the exact label is compared.
 */
const batchIssue = (
  resolved: readonly ResolvedSelection[],
  namedEffects: ReadonlyMap<string, string>,
): AccessChangesError | undefined => {
  const individual: string[] = [];
  for (const selection of resolved) {
    if (effectiveRisk(selection) !== 'routine') {
      individual.push(selection.item.capabilityKey);
    }
  }
  if (individual.length === 0) {
    return undefined;
  }
  if (resolved.length > 1) {
    return accessChangesError(
      'access_changes_sensitive_requires_individual_decision',
      `${individual.join(', ')} must be adopted individually, naming the effect`,
    );
  }
  const single = resolved.at(0);
  if (single === undefined) {
    return noItemSelected();
  }
  const expected = single.entry === undefined ? undefined : capabilityEffectLabel(single.entry);
  return namedEffects.get(single.item.id) === expected
    ? undefined
    : accessChangesError(
        'access_changes_named_effect_mismatch',
        `adopting ${single.item.capabilityKey} requires confirming the effect "${expected ?? ''}"`,
      );
};

const affectedPrincipals = (preview: AdoptionPreview): readonly PrincipalId[] =>
  preview.holders.flatMap(({ holder }) =>
    Match.value(holder).pipe(
      Match.tags({ Agent: () => [], Principal: ({ principalId }) => [principalId] }),
      Match.exhaustive,
    ),
  );

const targetedRoles = (request: AdoptionRequest, resolved: readonly ResolvedSelection[]): readonly Role[] => {
  const roles: Role[] = [];
  const seen = new Set<RoleId>();
  for (const { targets } of resolved) {
    for (const { roleId } of targets) {
      const role = findRole(request.roles, roleId);
      if (role !== undefined && !seen.has(roleId)) {
        seen.add(roleId);
        roles.push(role.role);
      }
    }
  }
  return roles;
};

const contributions = (resolved: readonly ResolvedSelection[]): readonly Contribution[] => {
  const collected: Contribution[] = [];
  for (const { entry, item, targets } of resolved) {
    if (entry === undefined) {
      continue;
    }
    for (const target of targets) {
      collected.push({ cells: targetsCells(entry, target), itemId: item.id, roleId: target.roleId });
    }
  }
  return collected;
};

/**
 * The exact cells this decision grants, each with the entry that declares it, so a delegated
 * manager's ceiling is checked cell by cell against the one lifecycle rule (R2-H4, D10b).
 */
const grantedCells = (resolved: readonly ResolvedSelection[]): readonly GrantedCell[] =>
  resolved.flatMap(({ entry, targets }) =>
    entry === undefined
      ? []
      : targets.flatMap((target) =>
          targetsCells(entry, target).map((cell) => ({ cell, entry, roleId: target.roleId })),
        ),
  );

const removalsFor = (
  resolved: readonly ResolvedSelection[],
  role: RoleWithRevision,
  roleId: RoleId,
): readonly Cell[] => {
  const removals: Cell[] = [];
  for (const { item, targets } of resolved) {
    if (item.kind === 'removed' && targets.some((target) => target.roleId === roleId)) {
      removals.push(...cellsOfCapability(role, item.capabilityKey));
    }
  }
  return removals;
};

/**
 * Adoption is the only path that writes cells: one complete new cell set per role whose intent
 * actually changes, and no revision at all for a role that already covers every adopted cell (M1).
 * A `removed` item strips the dead capability from the roles that still hold it.
 */
const planEdits = (
  request: AdoptionRequest,
  resolved: readonly ResolvedSelection[],
): Result.Result<readonly RoleCellEditDraft[], AccessChangesError> => {
  const additionsByRole = new Map<RoleId, Cell[]>();
  for (const { cells, roleId } of contributions(resolved)) {
    additionsByRole.set(roleId, [...(additionsByRole.get(roleId) ?? []), ...cells]);
  }
  // A removed capability contributes no cell, so the targeted roles come from the selection itself.
  const targeted = new Set<RoleId>(additionsByRole.keys());
  for (const { targets } of resolved) {
    for (const { roleId } of targets) {
      targeted.add(roleId);
    }
  }
  const edits: RoleCellEditDraft[] = [];
  for (const roleId of [...targeted].toSorted(compareText)) {
    const role = findRole(request.roles, roleId);
    if (role === undefined) {
      continue;
    }
    const additions = additionsByRole.get(roleId) ?? [];
    const removals = removalsFor(resolved, role, roleId);
    if (roleCellEditChanges(role, additions, removals)) {
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

const revisionIdsFor = (edits: readonly RoleCellEditDraft[], targets: readonly AdoptionTarget[]): readonly string[] => {
  const targetRoleIds = new Set(targets.map(({ roleId }) => roleId));
  const revisionIds: string[] = [];
  for (const { roleId, targetRevisionId } of edits) {
    if (targetRoleIds.has(roleId)) {
      revisionIds.push(targetRevisionId);
    }
  }
  return revisionIds;
};

/**
 * One decision per item, all sharing the batch. Routine items are decided together; a sensitive or
 * critical item is decided alone and records the effect that was named.
 */
const planDecisions = (
  request: AdoptionRequest,
  resolved: readonly ResolvedSelection[],
  edits: readonly RoleCellEditDraft[],
  decidedBy: PrincipalId,
): Result.Result<readonly DecisionInput[], AccessChangesError> => {
  const decisions: DecisionInput[] = [];
  for (const { item, targets } of resolved) {
    const decisionId = request.decisionIds.get(item.id);
    if (decisionId === undefined) {
      return Result.fail(identityMissing(`no decision identity was provided for item ${item.id}`));
    }
    decisions.push({
      batchId: request.batchId,
      decidedAt: request.decidedAt,
      decidedBy,
      decision: 'adopt',
      id: decisionId,
      itemId: item.id,
      roleRevisionIds: revisionIdsFor(edits, targets),
      tenantId: request.tenantId,
    });
  }
  return Result.succeed(decisions);
};

/**
 * Adopts Novinky items. A batch adopts routine items in one decision; a sensitive or critical item
 * is adopted alone with its exact effect named. Adoption writes role revisions and nothing else:
 * no capability becomes usable without one (guarantee 2), and a stale preview is refused (D7b).
 */
export const planAdoption = (request: AdoptionRequest): Result.Result<AdoptionPlan, AccessChangesError> => {
  const deciderReason = deciderIssue(request.actor);
  if (deciderReason !== null) {
    return Result.fail(agentCannotDecide(deciderReason));
  }
  const decidedBy = deciderOf(request.actor);
  if (decidedBy === null) {
    return Result.fail(agentCannotDecide('the decider is not a person'));
  }
  if (request.selections.length === 0) {
    return Result.fail(noItemSelected());
  }
  const entries = new Map(request.entries.map((entry) => [entry.key, entry]));
  const resolved: ResolvedSelection[] = [];
  for (const selection of request.selections) {
    const selectionResult = resolveSelection(request, selection, entries);
    if (Result.isFailure(selectionResult)) {
      return Result.fail(selectionResult.failure);
    }
    resolved.push(selectionResult.success);
  }
  const selectedItemIds = resolved.map(({ item }) => item.id);
  const duplicateItem = selectedItemIds.find((id, index) => selectedItemIds.indexOf(id) !== index);
  if (duplicateItem !== undefined) {
    return Result.fail(accessChangesError('access_changes_target_invalid', `item ${duplicateItem} is selected twice`));
  }
  const batchProblem = batchIssue(resolved, request.namedEffects);
  if (batchProblem !== undefined) {
    return Result.fail(batchProblem);
  }
  const preview = previewAdoption({
    assignments: request.assignments,
    at: request.decidedAt,
    items: resolved.map(({ item, targets }) => ({ itemId: item.id, roleIds: targets.map(({ roleId }) => roleId) })),
  });
  if (!samePreview(preview, request.preview)) {
    return Result.fail(
      accessChangesError(
        'access_changes_preview_stale',
        `the affected holders changed since the preview was shown (${request.preview.fingerprint} -> ${preview.fingerprint})`,
      ),
    );
  }
  const authorityProblem = configureAuthorityIssue({
    actor: decidedBy,
    affectedAgentHolder: preview.holders.some(({ holder }) => isAgentHolder(holder)),
    affectedAssignmentScopeIds: previewScopeIds(preview, request.assignments),
    affectedHolderPrincipals: affectedPrincipals(preview),
    at: request.decidedAt,
    authority: request.authority,
    capabilityKeys: resolved.map(({ item }) => item.capabilityKey),
    grantedCells: grantedCells(resolved),
    grantorIntent: {
      assignments: request.assignments,
      membership: request.membership,
      revisions: request.roles.map(({ revision }) => revision),
    },
    roles: targetedRoles(request, resolved),
    tenantId: request.tenantId,
  });
  if (authorityProblem !== undefined) {
    return Result.fail(authorityProblem);
  }
  const edits = planEdits(request, resolved);
  if (Result.isFailure(edits)) {
    return Result.fail(edits.failure);
  }
  const decisions = planDecisions(request, resolved, edits.success, decidedBy);
  if (Result.isFailure(decisions)) {
    return Result.fail(decisions.failure);
  }
  return Result.mapError(
    decodeAdoptionPlan(
      withOptional(
        {
          decisions: decisions.success,
          items: resolved.map(({ item }) => ({ ...item, status: 'adopted' })),
          preview,
          roleEdits: edits.success,
        },
        'checkedHolders',
        Predicate.isTagged(request.authority, 'DelegatedManager')
          ? checkedHoldersOf(
              request.assignments,
              edits.success.map(({ roleId }) => roleId),
              request.decidedAt,
            )
          : undefined,
      ),
    ),
    (issue) => accessChangesError('access_changes_item_invalid', issue.message),
  );
};

const declineAuthorityIssue = (request: DeclineRequest, keys: readonly CapabilityKey[]): AccessChangesError | null =>
  Match.value(request.authority).pipe(
    Match.tags({
      DelegatedManager: ({ delegation }) => {
        const live = liveDelegation(request.authority, request.decidedAt);
        if (live === null) {
          return delegationOutOfEnvelope(`delegation ${delegation.id} is not live at the time of the decision`);
        }
        const delegated = new Set<CapabilityKey>(live.capabilityKeys);
        const outside = keys.find((key) => !delegated.has(key));
        return outside === undefined
          ? null
          : delegationOutOfEnvelope(`capability ${outside} is outside delegation ${live.id}`);
      },
      Owner: () => null,
      ScopeAdmin: ({ tenantContext }) =>
        tenantContext
          ? null
          : accessChangesError(
              'access_changes_authority_missing',
              'declining a tenant-wide change needs tenant-level administration',
            ),
    }),
    Match.exhaustive,
  );

/**
 * Declining narrows: it grants nothing and changes no role, so it is never blocked by risk (O35).
 * It still needs configure authority, because leaving a capability unassigned is a management act.
 */
export const planDecline = (request: DeclineRequest): Result.Result<DeclinePlan, AccessChangesError> => {
  const deciderReason = deciderIssue(request.actor);
  if (deciderReason !== null) {
    return Result.fail(agentCannotDecide(deciderReason));
  }
  const decidedBy = deciderOf(request.actor);
  if (decidedBy === null) {
    return Result.fail(agentCannotDecide('the decider is not a person'));
  }
  if (request.itemIds.length === 0) {
    return Result.fail(noItemSelected());
  }
  const declined: AccessChangeItem[] = [];
  for (const itemId of request.itemIds) {
    const item = request.items.find(({ id }) => id === itemId);
    if (item === undefined) {
      return Result.fail(itemUnavailable(`item ${itemId} is not part of this tenant's changes`));
    }
    if (item.tenantId !== request.tenantId) {
      return Result.fail(itemUnavailable(`item ${itemId} belongs to tenant ${item.tenantId}`));
    }
    if (item.status !== 'pending') {
      return Result.fail(itemUnavailable(decidedItemIssue(item)));
    }
    declined.push(item);
  }
  const authorityProblem = declineAuthorityIssue(
    request,
    declined.map(({ capabilityKey }) => capabilityKey),
  );
  if (authorityProblem !== null) {
    return Result.fail(authorityProblem);
  }
  const decisions: DecisionInput[] = [];
  for (const item of declined) {
    const decisionId = request.decisionIds.get(item.id);
    if (decisionId === undefined) {
      return Result.fail(identityMissing(`no decision identity was provided for item ${item.id}`));
    }
    decisions.push({
      batchId: request.batchId,
      decidedAt: request.decidedAt,
      decidedBy,
      decision: 'decline',
      id: decisionId,
      itemId: item.id,
      roleRevisionIds: [],
      tenantId: request.tenantId,
    });
  }
  return Result.mapError(
    decodeDeclinePlan({ decisions, items: declined.map((item) => ({ ...item, status: 'declined' })) }),
    (issue) => accessChangesError('access_changes_item_invalid', issue.message),
  );
};
