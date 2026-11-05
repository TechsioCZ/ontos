import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Match, Option, Predicate, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import type { OperationalScope } from '../../operations/context.ts';
import { AccessProjectionWriter } from '../intent/projection-writer.ts';
import type { TenantProjectionWrite } from '../intent/projection-writer.ts';
import { TenantIntentLoader } from '../intent/tenant-intent-loader.ts';
import {
  CapabilityKeySchema,
  CatalogSnapshotIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  RoleTemplateKeySchema,
  TenantIdSchema,
} from '../ids.ts';
import type {
  CapabilityKey,
  CatalogSnapshotId,
  LegalEntityId,
  PrincipalId,
  RoleId,
  RoleRevisionId,
  RoleTemplateKey,
} from '../ids.ts';
import type {
  Assignment,
  CatalogSnapshot,
  CatalogSnapshotEntry,
  Cell,
  CellSelector,
  RecordSelector,
  Role,
  RoleRevision,
} from '../model.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  AccessModeSchema,
  AccessRiskSchema,
  CellSchema,
  cellSlotKey,
  namesRoleTemplate,
} from '../model.ts';
import type { AccessConfigureBasis, GrantedCell, GrantorMembership } from './authority.ts';
import { configureAuthorityIssue, configureBasisCoversRole } from './authority.ts';
import { cellsWith, cellsWithout, toSortedCells } from './cells.ts';
import { compareText } from './compare.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';
import { AccessChangesStore } from './persistence/store.ts';
import type { AffectedHolder } from './preview.ts';
import { AffectedHolderSchema, isActiveAssignment, isAgentHolder } from './preview.ts';
import type { RoleCellEdit, RoleWithRevision } from './role-edits.ts';
import { findRole } from './role-edits.ts';

/*
 * The role editor's one write path (P2). A Role is exact cells pinned to one catalog release, and an
 * edit is a new immutable revision of those cells; none of it is a Novinky decision, so none of it may
 * go through the adoption batch. This module is the fenced Core operation between the editor's request
 * and the single revision writer:
 *
 * 1. decode and validate the requested cells against the release the editor read (no future flow),
 * 2. refuse a role that moved on instead of forking its history,
 * 3. require one named effect per dangerous cell that the server itself computed,
 * 4. refuse an edit outside the author's configuration authority, read from live intent at write time,
 * 5. write the successor revision through `AccessChangesStore` in the caller's own tenant scope, and
 * 6. reconcile the tenant through the one projection writer, which holds the tenant fence, journals
 *    the operation and verifies the graph before the caller may report success.
 *
 * The gate only admits a person to the editor's operation. Which role they may edit, which cells they
 * may add and whose access they may move is `configureAuthorityIssue` in `authority.ts`, the same rule
 * an adoption or an undo is held to, and the write runs it itself so no caller can skip it (P8, D10).
 */

/** One effect the editor was shown and explicitly confirmed, for exactly one cell slot. */
export const RoleCellConfirmationSchema = Schema.Struct({
  /** The server's own effect text, echoed back: a caller never authors what it confirms. */
  effect: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  slot: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
});
export type RoleCellConfirmation = typeof RoleCellConfirmationSchema.Type;

/** One dangerous cell the editor must confirm individually before the revision may be saved. */
export const RoleCellDangerSchema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  effect: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  mode: AccessModeSchema,
  risk: AccessRiskSchema,
  slot: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
});
export type RoleCellDanger = typeof RoleCellDangerSchema.Type;

/** The digest of a precondition the editor saw; a changed intent never matches it (D7b). */
export const RoleRevisionPreviewTokenSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export type RoleRevisionPreviewToken = typeof RoleRevisionPreviewTokenSchema.Type;

/** The affected-holder preview of one role edit, with the token that makes a stale preview visible. */
export const RoleRevisionPreviewSchema = Schema.Struct({
  affectedHolders: Schema.Array(AffectedHolderSchema),
  agentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fingerprint: RoleRevisionPreviewTokenSchema,
  holderCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  humanCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  roleRevisionId: RoleRevisionIdSchema,
});
export type RoleRevisionPreview = typeof RoleRevisionPreviewSchema.Type;

/** One role as the editor reads it: its head revision, the cells it holds now, and its live holders. */
export const RoleSummarySchema = Schema.Struct({
  cells: Schema.Array(CellSchema),
  headRevision: Schema.Struct({
    catalogSnapshotId: CatalogSnapshotIdSchema,
    cells: Schema.Array(CellSchema),
    createdAt: Schema.Date,
    createdBy: PrincipalIdSchema,
    provenance: Schema.Literals(['template', 'customer_changed', 'manual', 'imported']),
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    roleRevisionId: RoleRevisionIdSchema,
    templateKey: Schema.optionalKey(RoleTemplateKeySchema),
  }),
  holderCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  roleId: RoleIdSchema,
  scope: Schema.Literals(['company', 'tenant']),
});
export type RoleSummary = typeof RoleSummarySchema.Type;

/** A template is an explicit, pinned cell set: never a name resolved against today's catalog. */
export const RoleTemplateSchema = Schema.Struct({
  catalogSnapshotId: CatalogSnapshotIdSchema,
  cells: Schema.Array(CellSchema),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  source: Schema.Literals(['blank', 'catalog_full_access', 'copy_role']),
  sourceRoleId: Schema.optionalKey(RoleIdSchema),
  templateKey: RoleTemplateKeySchema,
});
export type RoleTemplate = typeof RoleTemplateSchema.Type;

export interface RoleRevisionPlanRequest {
  /** The release the editor read: a revision pins it, and every cell must exist in it (O1). */
  readonly catalog: CatalogSnapshot;
  /** The complete cell set the editor wants the role to hold, not a delta. */
  readonly cells: readonly Cell[];
  /** The effects the editor confirmed, one per dangerous cell it was shown. */
  readonly confirmedEffects: readonly RoleCellConfirmation[];
  /**
   * The revision the editor read; a role that moved on is a conflict, never a fork, unless it moved to
   * this request's own target, which an earlier attempt recorded (a replay).
   */
  readonly expectedRoleRevisionId: RoleRevisionId;
  /** The role as the write plan reads it: its identity and the revision expressing it now. */
  readonly role: RoleWithRevision;
  /** The successor revision, minted once per request so a retry resumes instead of forking. */
  readonly targetRevisionId: RoleRevisionId;
}

export interface RoleRevisionPlan {
  readonly addedCells: readonly Cell[];
  /** Every newly added cell the editor must confirm by name before saving. */
  readonly dangerous: readonly RoleCellDanger[];
  /** The successor revision to write; absent when the requested set changes nothing. */
  readonly edit: Option.Option<RoleCellEdit>;
  readonly removedCells: readonly Cell[];
  /**
   * The head already is this request's target revision: an earlier attempt recorded it, so the save
   * writes nothing again and only reconciles the tenant. Its added and removed cells are not re-derived.
   */
  readonly replayed: boolean;
  readonly unchanged: boolean;
}

const decodeCells = Schema.decodeUnknownResult(Schema.Array(CellSchema), ACCESS_MODEL_PARSE_OPTIONS);

/**
 * The amount ceiling a cell asks for, as a comparable value. A ceiling is not part of a cell slot, so a
 * cell whose slot the role already holds with another ceiling is that slot with new content: the
 * revision replaces it (R5a-6), which the writer expresses as the held cell removed and the new content
 * added in one edit, so the slot's incarnations move with it and no approval of the old cell reaches
 * the new one (O52).
 */
const ceilingKey = (cell: Cell): string =>
  Option.match(Option.fromUndefinedOr(cell.amountCeiling), {
    onNone: () => '',
    onSome: ({ currency, limitMinor }) => `${currency}:${limitMinor}`,
  });

const sameCeiling = (left: Cell, right: Cell): boolean => ceilingKey(left) === ceilingKey(right);

/** The exact records a `targets` cell names, in a stable order; any other selector names none. */
const targetsKey = (cell: Cell): string =>
  Match.value(cell.selector).pipe(
    Match.tag('targets', ({ recordKeys }) => [...recordKeys].toSorted().join('\u0000')),
    Match.orElse(() => ''),
  );

/** A cell's slot with everything a grant depends on: its ceiling and its exact target records. */
const contentKey = (cell: Cell): string => `${cellSlotKey(cell)}:${ceilingKey(cell)}:${targetsKey(cell)}`;

/** Two cells of one slot hold the same grant only when their ceiling and their exact records agree. */
const sameSlotContent = (left: Cell, right: Cell): boolean =>
  sameCeiling(left, right) && targetsKey(left) === targetsKey(right);

/**
 * The effect one cell has, as a stable, locale-neutral code the editor shows (through its own copy) and
 * echoes back (O23, P8). It is the mode, the kind and the risk the release declares, so a confirmation
 * can neither be a blanket "I confirm everything" nor be re-pointed at another cell, and the wording a
 * person reads stays with the copy layer instead of inside Core.
 */
export const roleCellEffect = (entry: CatalogSnapshotEntry, cell: Cell): string =>
  `${cell.mode}:${entry.kind}:${entry.risk}`;

/**
 * Whether a newly added cell needs its own confirmation: an authority-bearing mode, an administration
 * or export kind, or any risk above routine. A routine widening (a record selector on a routine read)
 * is saved without a per-cell confirmation, exactly as the release flow treats routine items.
 */
export const isDangerousCell = (entry: CatalogSnapshotEntry, cell: Cell): boolean =>
  cell.mode === 'approve' || entry.risk !== 'routine' || entry.kind === 'admin' || entry.kind === 'export';

/** The release entry of one capability, only from the release the editor read (no future flow). */
const entryOf = (catalog: CatalogSnapshot, capabilityKey: CapabilityKey): Option.Option<CatalogSnapshotEntry> =>
  Option.fromUndefinedOr(catalog.entries.find(({ key }) => key === capabilityKey));

/**
 * The record selector a cell names, in the release's own vocabulary; `None` means explicit record
 * targets, which a release declares as scope-wide (`all`) and a role narrows to exact records (O9).
 */
const recordSelectorOf = (selector: CellSelector): Option.Option<RecordSelector> =>
  Match.value(selector).pipe(
    Match.tag('all', () => Option.some<RecordSelector>('all')),
    Match.tag('assigned', () => Option.some<RecordSelector>('assigned')),
    Match.tag('entrusted', () => Option.some<RecordSelector>('entrusted')),
    Match.tag('team', () => Option.some<RecordSelector>('team')),
    Match.tag('targets', () => Option.none<RecordSelector>()),
    Match.exhaustive,
  );

/** Why one requested cell does not fit the pinned release, if it does not. */
const cellDeclarationIssue = (role: Role, entry: CatalogSnapshotEntry, cell: Cell): string | null => {
  if (!entry.modes.includes(cell.mode)) {
    return `capability ${entry.key} declares no ${cell.mode} mode`;
  }
  const selector = recordSelectorOf(cell.selector);
  if (Option.isNone(selector)) {
    if (!entry.selectors.includes('all')) {
      return `capability ${entry.key} is not scope-wide, so it takes no explicit record targets`;
    }
    // A record key only means something inside one scope, and a tenant-context role is not one (O7).
    return role.legalEntityId === undefined
      ? `a tenant-context role holds no explicit record targets for ${entry.key}`
      : null;
  }
  // A declaration with no selectors is scope-wide: the compiler and full-access roles hold it as `all`.
  if (selector.value === 'all' && entry.selectors.length === 0) {
    return null;
  }
  return entry.selectors.includes(selector.value)
    ? null
    : `capability ${entry.key} declares no ${selector.value} record selector`;
};

/**
 * Why one cell of the set cannot be held, if it cannot: it must come from the pinned release, fit its
 * declared modes and selectors, carry a ceiling only where the release names the amount input (O18),
 * and never mix a scope-wide and an explicit-target grant for one capability and mode (O51(3)).
 */
const cellSetIssues = (catalog: CatalogSnapshot, role: Role, cells: readonly Cell[]): readonly string[] => {
  const issues: string[] = [];
  const slots = new Set<string>();
  const selectors = new Map<string, Set<string>>();
  for (const cell of cells) {
    const slot = cellSlotKey(cell);
    if (slots.has(slot)) {
      issues.push(`cell ${slot} is requested twice`);
    }
    slots.add(slot);
    const entry = entryOf(catalog, cell.capabilityKey);
    if (Option.isNone(entry)) {
      issues.push(`capability ${cell.capabilityKey} is not part of release ${catalog.id}, so it cannot be granted yet`);
      continue;
    }
    const declaration = cellDeclarationIssue(role, entry.value, cell);
    if (declaration !== null) {
      issues.push(declaration);
    }
    if (cell.amountCeiling !== undefined && entry.value.amountInput === undefined) {
      issues.push(`capability ${entry.value.key} carries no amount, so it takes no amount ceiling`);
    }
    // O51(3): explicit targets are held in the scope-wide slot, so `all` and `targets` never coexist
    // for one capability and mode; a narrower selector (`assigned`, `entrusted`, `team`) is a
    // different slot and may sit beside an explicit-target cell.
    const selectorSlot = `${cell.capabilityKey} ${cell.mode}`;
    const mixed = selectors.get(selectorSlot) ?? new Set<string>();
    const named = recordSelectorOf(cell.selector);
    if (Option.isNone(named)) {
      mixed.add('targets');
    } else if (named.value === 'all') {
      mixed.add('all');
    }
    selectors.set(selectorSlot, mixed);
  }
  for (const [slot, tags] of selectors) {
    if (tags.has('all') && tags.has('targets')) {
      issues.push(`capability ${slot} mixes a scope-wide and an explicit-target cell`);
    }
  }
  return issues;
};

/**
 * The confirmation the editor owes for a plan: one named effect per dangerous cell, and nothing else.
 * A confirmation the server never computed is a mismatch rather than a harmless extra, so a client
 * cannot pre-confirm a cell it was never shown.
 */
const confirmationsIssue = (
  dangerous: readonly RoleCellDanger[],
  addedCells: readonly Cell[],
  confirmed: readonly RoleCellConfirmation[],
): AccessChangesError | null => {
  const addedSlots = new Set(addedCells.map(cellSlotKey));
  const foreign = confirmed.find(({ slot }) => !addedSlots.has(slot));
  if (foreign !== undefined) {
    return accessChangesError(
      'access_changes_named_effect_mismatch',
      `cell ${foreign.slot} is not a cell this edit adds, so it has no effect to confirm`,
    );
  }
  for (const danger of dangerous) {
    const confirmation = confirmed.find(({ slot }) => slot === danger.slot);
    if (confirmation === undefined) {
      return accessChangesError(
        'access_changes_sensitive_requires_individual_decision',
        `cell ${danger.slot} needs its own confirmation of the effect "${danger.effect}"`,
      );
    }
    if (confirmation.effect !== danger.effect) {
      return accessChangesError(
        'access_changes_named_effect_mismatch',
        `cell ${danger.slot} was confirmed as "${confirmation.effect}", not as "${danger.effect}"`,
      );
    }
  }
  return null;
};

/**
 * The plan of a save an earlier attempt already recorded. The target revision is minted from the
 * request's idempotency key, so a head that is that revision is this very save; its cells must be the
 * requested ones, or the key was reused for another edit.
 */
const replayPlanOf = (
  role: RoleWithRevision,
  requested: readonly Cell[],
  sourceRevisionId: RoleRevisionId,
): Effect.Effect<RoleRevisionPlan, AccessChangesError> => {
  const recorded = toSortedCells(role.revision.cells).map(contentKey).join('+');
  if (toSortedCells(requested).map(contentKey).join('+') !== recorded) {
    return Effect.fail(
      accessChangesError(
        'access_changes_preview_stale',
        `revision ${role.revision.id} of role ${role.role.name} was saved with other cells; re-read it before saving`,
      ),
    );
  }
  return Effect.succeed({
    addedCells: [],
    dangerous: [],
    edit: Option.some({
      addedCells: [],
      cells: role.revision.cells,
      removedCells: [],
      roleId: role.role.id,
      sourceRevisionId,
      targetRevisionId: role.revision.id,
    }),
    removedCells: [],
    replayed: true,
    unchanged: false,
  });
};

/**
 * The requested cells as a revision of this role: added, removed, the successor set, and the cells
 * whose confirmation the editor still owes. Nothing here writes; the caller persists the plan.
 *
 * `confirmations` is how the two callers differ and the only way they differ: a save must carry one
 * named effect per dangerous cell it adds, while the preview a save is built from must be able to
 * *name* those cells before anybody has confirmed them. A preview plan is therefore never the plan a
 * write is called with: `planRoleRevision` enforces, `planRoleRevisionPreview` reports.
 */
const planRoleRevisionWith = Effect.fn('RoleRevision.planRoleRevision')(function* planRoleRevisionEffect(
  request: RoleRevisionPlanRequest,
  confirmations: 'enforced' | 'waived',
) {
  const { catalog, confirmedEffects, role, targetRevisionId } = request;
  // A replay is a save whose own new revision is already the head: the revision it expected to replace is
  // another one. A preview names the head as both, and is never a replay.
  const replayed = role.revision.id === targetRevisionId && targetRevisionId !== request.expectedRoleRevisionId;
  if (!replayed && role.revision.id !== request.expectedRoleRevisionId) {
    return yield* accessChangesError(
      'access_changes_preview_stale',
      `role ${role.role.name} moved from revision ${request.expectedRoleRevisionId} to ${role.revision.id}; re-read it before saving`,
    );
  }
  const decoded = decodeCells(request.cells);
  if (Result.isFailure(decoded)) {
    return yield* accessChangesError(
      'access_changes_declaration_invalid',
      `the requested cells do not decode: ${decoded.failure.message}`,
    );
  }
  const requested = decoded.success;
  if (replayed) {
    return yield* replayPlanOf(role, requested, request.expectedRoleRevisionId);
  }
  const [firstIssue] = cellSetIssues(catalog, role.role, requested);
  if (firstIssue !== undefined) {
    return yield* accessChangesError('access_changes_capability_not_configurable', firstIssue);
  }
  const headSlots = new Map(role.revision.cells.map((cell) => [cellSlotKey(cell), cell]));
  const requestedSlots = new Map(requested.map((cell) => [cellSlotKey(cell), cell]));
  // A ceiling or exact-record change replaces its slot instead of adding to it: the held cell leaves and the new
  // content arrives for the same slot, so the store retires that slot's incarnation and writes a fresh
  // one, while every untouched cell keeps the incarnation its approvals witnessed (O51(2), O52).
  const replacedSlots = new Set<string>();
  for (const cell of requested) {
    const head = headSlots.get(cellSlotKey(cell));
    if (head !== undefined && !sameSlotContent(head, cell)) {
      replacedSlots.add(cellSlotKey(cell));
    }
  }
  const addedCells = toSortedCells(
    requested.filter((cell) => !headSlots.has(cellSlotKey(cell)) || replacedSlots.has(cellSlotKey(cell))),
  );
  const removedCells = toSortedCells(
    role.revision.cells.filter(
      (cell) => !requestedSlots.has(cellSlotKey(cell)) || replacedSlots.has(cellSlotKey(cell)),
    ),
  );
  const unchanged = addedCells.length === 0 && removedCells.length === 0;
  const dangerous = addedCells.flatMap((cell): readonly RoleCellDanger[] => {
    const entry = entryOf(catalog, cell.capabilityKey);
    return Option.isSome(entry) && isDangerousCell(entry.value, cell)
      ? [
          {
            capabilityKey: cell.capabilityKey,
            effect: roleCellEffect(entry.value, cell),
            mode: cell.mode,
            risk: entry.value.risk,
            slot: cellSlotKey(cell),
          },
        ]
      : [];
  });
  if (confirmations === 'enforced') {
    const confirmationIssue = confirmationsIssue(dangerous, addedCells, confirmedEffects);
    if (confirmationIssue !== null) {
      return yield* confirmationIssue;
    }
  }
  const edit: Option.Option<RoleCellEdit> = unchanged
    ? Option.none()
    : Option.some({
        addedCells,
        cells: cellsWith(cellsWithout(role.revision.cells, removedCells), addedCells),
        removedCells,
        roleId: role.role.id,
        sourceRevisionId: role.revision.id,
        targetRevisionId,
      });
  return { addedCells, dangerous, edit, removedCells, replayed: false, unchanged };
});

/** The save's plan: every dangerous cell it adds must already carry its own named confirmation. */
export const planRoleRevision = (
  request: RoleRevisionPlanRequest,
): Effect.Effect<RoleRevisionPlan, AccessChangesError> => planRoleRevisionWith(request, 'enforced');

/**
 * The preview's plan: the same cells, the same refusals and the same dangerous list, with the
 * confirmations the editor has not given yet left to `planRoleRevision`.
 */
export const planRoleRevisionPreview = (
  request: RoleRevisionPlanRequest,
): Effect.Effect<RoleRevisionPlan, AccessChangesError> => planRoleRevisionWith(request, 'waived');

/** A role's live holders at one instant, named exactly as the preview shows them (D7b). */
const liveHolders = (roleId: RoleId, assignments: readonly Assignment[], at: Date): readonly AffectedHolder[] => {
  const holders: AffectedHolder[] = [];
  for (const assignment of assignments) {
    if (assignment.roleId === roleId && isActiveAssignment(assignment, at)) {
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

/**
 * The affected set of one role edit, with its token. The digest covers the head revision, every
 * requested cell slot and every affected assignment incarnation, so any change to the role, to the
 * requested cells or to who holds it makes a previous preview stale. It deliberately does not name the
 * successor revision: the preview happens before the write mints it, and the same preview must be the
 * one the save echoes back.
 */
export const previewRoleRevision = (request: {
  readonly assignments: readonly Assignment[];
  readonly at: Date;
  readonly cells: readonly Cell[];
  readonly plan: RoleRevisionPlan;
  readonly role: RoleWithRevision;
  readonly targetRevisionId: RoleRevisionId;
}): RoleRevisionPreview => {
  const holders = liveHolders(request.role.role.id, request.assignments, request.at);
  const agentCount = holders.filter(({ holder }) => isAgentHolder(holder)).length;
  const lines = [
    `role:${request.role.role.id}`,
    `head:${request.role.revision.id}`,
    `added:${request.plan.addedCells.map(contentKey).join('+')}`,
    `removed:${request.plan.removedCells.map(contentKey).join('+')}`,
    ...request.cells.map((cell) => `cell:${contentKey(cell)}`),
    ...holders.map(({ assignmentIncarnationId }) => `holder:${assignmentIncarnationId}`),
  ];
  return {
    affectedHolders: holders,
    agentCount,
    fingerprint: Hex.encode(sha256(utf8ToBytes(lines.join('\n')))),
    holderCount: holders.length,
    humanCount: holders.length - agentCount,
    roleRevisionId: request.targetRevisionId,
  };
};

/** The head revision of a role, and the cells it holds, as the editor reads them. */
export const roleSummaryOf = (role: RoleWithRevision, assignments: readonly Assignment[], at: Date): RoleSummary => {
  const { revision } = role;
  const headBase = {
    catalogSnapshotId: revision.catalogSnapshotId,
    cells: [...revision.cells],
    createdAt: revision.createdAt,
    createdBy: revision.createdBy,
    provenance: revision.provenance,
    revision: revision.revision,
    roleRevisionId: revision.id,
  } as const;
  const head = revision.templateKey === undefined ? headBase : { ...headBase, templateKey: revision.templateKey };
  const summary = {
    cells: [...revision.cells],
    headRevision: head,
    holderCount: liveHolders(role.role.id, assignments, at).length,
    name: role.role.name,
    roleId: role.role.id,
    scope: role.role.legalEntityId === undefined ? ('tenant' as const) : ('company' as const),
  };
  return role.role.legalEntityId === undefined ? summary : { ...summary, legalEntityId: role.role.legalEntityId };
};

/** The role the editor asked for, read from the tenant's own intent at one consistent instant. */
export const findEditableRole = (roles: readonly RoleWithRevision[], roleId: RoleId): Option.Option<RoleWithRevision> =>
  Option.fromUndefinedOr(roles.find(({ role }) => role.id === roleId));

/** The template key of a revision, when the revision was derived from one (provenance, not a lookup). */
export const templateKeyOf = (revision: RoleRevision): Option.Option<RoleTemplateKey> =>
  namesRoleTemplate(revision.provenance) ? Option.fromUndefinedOr(revision.templateKey) : Option.none();

/** The facts one role edit is authorised against, all read by the write itself (O66). */
interface RoleRevisionAuthorityCheck {
  readonly actor: PrincipalId;
  readonly assignments: readonly Assignment[];
  readonly at: Date;
  readonly bases: readonly AccessConfigureBasis[];
  /** The published release, absent when none is published. */
  readonly catalog: CatalogSnapshot | undefined;
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly edit: RoleCellEdit;
  /** The tenant's live members and suspensions, so a grantor whose membership ended counts for nothing. */
  readonly membership: GrantorMembership;
  readonly roles: readonly RoleWithRevision[];
  readonly tenantId: string;
}

/** A holder that is a person; an agent holder is reported apart, because no delegation reaches one (D2). */
const principalOf = (holder: Assignment['holder']): readonly PrincipalId[] =>
  Match.value(holder).pipe(
    Match.tags({ Agent: () => [], Principal: ({ principalId }) => [principalId] }),
    Match.exhaustive,
  );

/**
 * Whether the author may record this edit: the role must be inside one of their configure bases and,
 * for a delegated manager, every added cell, every live holder of the role and its assignment scopes
 * inside the exact envelope, never the manager themselves (P8, D10). Each basis is tried like an
 * adoption tries it, and the first refusal is reported when none accepts.
 */
const roleRevisionAuthorityIssue = (check: RoleRevisionAuthorityCheck): AccessChangesError | undefined => {
  const role = check.roles.find((one) => one.role.id === check.edit.roleId);
  if (role === undefined) {
    return accessChangesError(
      'access_changes_target_invalid',
      `role ${check.edit.roleId} is not a role of this tenant`,
    );
  }
  if (check.catalog?.id !== check.catalogSnapshotId) {
    return accessChangesError(
      'access_changes_preview_stale',
      `the edit was planned against release ${check.catalogSnapshotId}, which is not the published release`,
    );
  }
  const { catalog } = check;
  const grantedCells: GrantedCell[] = [];
  for (const cell of check.edit.addedCells) {
    const entry = entryOf(catalog, cell.capabilityKey);
    if (Option.isNone(entry)) {
      return accessChangesError(
        'access_changes_capability_not_configurable',
        `capability ${cell.capabilityKey} is not part of release ${catalog.id}, so it cannot be granted`,
      );
    }
    grantedCells.push({ cell, entry: entry.value, roleId: role.role.id });
  }
  const held = check.assignments.filter(
    (assignment) => assignment.roleId === role.role.id && isActiveAssignment(assignment, check.at),
  );
  let refused: AccessChangesError | undefined;
  for (const authority of check.bases) {
    const issue = configureAuthorityIssue({
      actor: check.actor,
      affectedAgentHolder: held.some(({ holder }) => isAgentHolder(holder)),
      affectedAssignmentScopeIds: held.map(({ scopeId }) => scopeId),
      affectedHolderPrincipals: held.flatMap(({ holder }) => principalOf(holder)),
      at: check.at,
      authority,
      capabilityKeys: [...new Set(grantedCells.map(({ cell }) => cell.capabilityKey))],
      grantedCells,
      grantorIntent: {
        assignments: check.assignments,
        membership: check.membership,
        revisions: check.roles.map(({ revision }) => revision),
      },
      roles: [role.role],
      tenantId: check.tenantId,
    });
    if (issue === undefined) {
      return undefined;
    }
    refused ??= issue;
  }
  return (
    refused ?? accessChangesError('access_changes_authority_missing', 'this person configures no role of this tenant')
  );
};

/** What the editor saves: the released cells of one role, and the operation that carries them. */
export interface RoleRevisionWrite {
  readonly catalogSnapshotId: CatalogSnapshotId;
  /**
   * The instant Core records the revision at. It is the request's own minted instant, exactly like the
   * gate's `now` (D6): the runtime reads the one Clock at the request boundary and hands it here, so
   * this writer never reads a clock of its own and a test can state the instant it asserts.
   */
  readonly decidedAt: Date;
  readonly edit: RoleCellEdit;
  /** The trusted request scope: its tenant is written and its person is the author (O66). */
  readonly scope: OperationalScope;
}

export interface RoleRevisionWritten {
  readonly projection: TenantProjectionWrite;
  readonly roleRevisionId: RoleRevisionId;
}

/**
 * The one fenced write of a role revision: the store writes the successor revision in the caller's
 * own tenant scope (it re-points every live holder and moves the grant incarnations itself), then the
 * single projection writer takes the tenant fence, journals the operation, writes the difference and
 * verifies the graph. A failure after the store commit is repaired by retrying the same save: its
 * target revision is already the role's head, so the retry records nothing again and only reconciles
 * the tenant, and a reconcile of intent already projected is a no-op instead of a second write.
 */
export const writeRoleRevision = Effect.fn('RoleRevision.writeRoleRevision')(function* writeRoleRevisionEffect(
  request: RoleRevisionWrite,
) {
  const store = yield* AccessChangesStore;
  const loader = yield* TenantIntentLoader;
  const projectionWriter = yield* AccessProjectionWriter;
  const actor = PrincipalIdSchema.make(request.scope.principalId);
  const tenantId = TenantIdSchema.make(request.scope.tenantId);
  // The same reads an adoption decides from: the role and the release from the store, the holders and
  // the author's configure bases from live intent at the instant the revision is recorded (O81).
  const [changes, release, intent, bases] = yield* Effect.all(
    [
      store.loadTenantChanges(request.scope),
      store.loadPublishedCatalog(),
      loader.loadProjection(request.scope),
      loader.loadConfigureBases(request.scope, { actor, at: request.decidedAt, tenantId }),
    ],
    { concurrency: 1 },
  );
  if (findRole(changes.roles, request.edit.roleId)?.revision.id === request.edit.targetRevisionId) {
    // Idempotent, so a retry of a recorded revision repairs a projection the first attempt failed to write.
    const projection = yield* projectionWriter.reconcileTenant({ scope: request.scope });
    return { projection, roleRevisionId: request.edit.targetRevisionId };
  }
  const assignments = intent.scopes.flatMap((entry) => entry.assignments);
  const authorityProblem = roleRevisionAuthorityIssue({
    actor,
    assignments,
    at: request.decidedAt,
    bases,
    catalog: Option.getOrUndefined(release),
    catalogSnapshotId: request.catalogSnapshotId,
    edit: request.edit,
    membership: intent,
    roles: changes.roles,
    tenantId,
  });
  if (authorityProblem !== undefined) {
    return yield* authorityProblem;
  }
  // An edit only a delegation authorizes was checked against the role's holders as they stood; the
  // store re-checks them under the role's lock so an assignment made meanwhile is never reached.
  // Only a permanent basis that covers this very role makes the holder check unnecessary; one that
  // administers another company does not authorize this edit at all.
  const editedRole = findRole(changes.roles, request.edit.roleId)?.role;
  const delegatedOnly = bases.every(
    (basis) =>
      Predicate.isTagged(basis, 'DelegatedManager') ||
      editedRole === undefined ||
      !configureBasisCoversRole(basis, editedRole),
  );
  const recordInput = {
    catalogSnapshotId: request.catalogSnapshotId,
    decidedAt: request.decidedAt,
    edit: request.edit,
    scope: request.scope,
  };
  yield* store.recordRoleRevision(
    delegatedOnly
      ? {
          ...recordInput,
          expectedHolders: assignments.flatMap((assignment) =>
            assignment.roleId === request.edit.roleId && isActiveAssignment(assignment, request.decidedAt)
              ? [assignment.incarnationId]
              : [],
          ),
        }
      : recordInput,
  );
  const projection = yield* projectionWriter.reconcileTenant({ scope: request.scope });
  return { projection, roleRevisionId: request.edit.targetRevisionId };
});

/** What the editor creates: a new role with its first revision, from one explicit pinned template. */
export interface RoleCreation {
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly cells: readonly Cell[];
  /** The request's own minted instant, exactly like the gate's `now` (D6). */
  readonly decidedAt: Date;
  readonly legalEntityId?: LegalEntityId;
  readonly name: string;
  /** The trusted request scope: its tenant is written and its person is the author (O66). */
  readonly scope: OperationalScope;
  readonly targetRevisionId: RoleRevisionId;
  readonly targetRoleId: RoleId;
  /** Absent for a role built from scratch; a template key only names the provenance it came from. */
  readonly templateKey?: RoleTemplateKey;
}

export interface RoleCreated {
  readonly projection: TenantProjectionWrite;
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
}

const labelIssue = (label: string): string | null =>
  label.trim().length === 0 || label.length > 200 ? 'a role name is 1 to 200 characters' : null;

/**
 * The one fenced write of a new role: a role never exists without the revision that expresses it, so
 * both are one store write of one person, pinned to the release the template was read from, and the
 * tenant is reconciled before the caller may report success.
 */
export const writeRoleCreation = Effect.fn('RoleRevision.writeRoleCreation')(function* writeRoleCreationEffect(
  request: RoleCreation,
) {
  const store = yield* AccessChangesStore;
  const projectionWriter = yield* AccessProjectionWriter;
  const nameIssue = labelIssue(request.name);
  if (nameIssue !== null) {
    return yield* accessChangesError('access_changes_identity_missing', nameIssue);
  }
  const at = request.decidedAt;
  const roleBase: Role = {
    createdAt: at,
    createdBy: PrincipalIdSchema.make(request.scope.principalId),
    id: request.targetRoleId,
    name: request.name,
    tenantId: TenantIdSchema.make(request.scope.tenantId),
  };
  const role: Role =
    request.legalEntityId === undefined ? roleBase : { ...roleBase, legalEntityId: request.legalEntityId };
  const revisionBase: RoleRevision = {
    catalogSnapshotId: request.catalogSnapshotId,
    cells: toSortedCells(request.cells),
    createdAt: at,
    createdBy: PrincipalIdSchema.make(request.scope.principalId),
    id: request.targetRevisionId,
    provenance: request.templateKey === undefined ? 'manual' : 'template',
    revision: 1,
    roleId: request.targetRoleId,
    tenantId: TenantIdSchema.make(request.scope.tenantId),
  };
  const revision: RoleRevision =
    request.templateKey === undefined ? revisionBase : { ...revisionBase, templateKey: request.templateKey };
  yield* store.recordRole({ revision, role, scope: request.scope });
  const projection = yield* projectionWriter.reconcileTenant({ scope: request.scope });
  return { projection, roleId: request.targetRoleId, roleRevisionId: request.targetRevisionId };
});

export { AccessChangesStore } from './persistence/store.ts';
export type { AccessChangesState, AccessChangesStoreService } from './persistence/store.ts';

/** The model and identity schemas a BFF needs, so a consumer imports one subpath and nothing else. */
export {
  AssignmentSchema,
  CatalogSnapshotEntrySchema,
  CatalogSnapshotSchema,
  CellSchema,
  HolderSchema,
  RoleRevisionSchema,
  RoleSchema,
} from '../model.ts';
export type { Assignment, CatalogSnapshot, CatalogSnapshotEntry, Cell, Holder, Role, RoleRevision } from '../model.ts';
export {
  AccessScopeIdSchema,
  CatalogSnapshotIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  RoleTemplateKeySchema,
  TenantIdSchema,
} from '../ids.ts';
export type {
  AccessScopeId,
  CatalogSnapshotId,
  LegalEntityId,
  PrincipalId,
  RoleId,
  RoleRevisionId,
  RoleTemplateKey,
  TenantId,
} from '../ids.ts';
export type { RoleCellEdit, RoleWithRevision } from './role-edits.ts';
