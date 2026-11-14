import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';

import { withOptional } from '../../decision/optional.ts';
import type { SqlError } from 'effect/sql/SqlError';

import { isDatabaseIntegrityRefusal, isDatabaseUnavailableFailure } from '../../../database/driver-failure.ts';
import { isPostgresUniqueViolation } from '../../../database/postgres-failure.ts';
import { CoreDatabase } from '../../../db/client.ts';
import { installOperationalScope } from '../../../db/scoped-transaction.ts';
import {
  accessAssignments,
  accessCatalogEntries,
  accessCatalogSnapshots,
  accessChangeDecisions,
  accessChangeItems,
  accessRoleRevisions,
  accessRoles,
} from '../../../db/schema.ts';
import type { CoreDatabaseExecutor, CoreDbExecutor, CoreTransaction } from '../../../db/types.ts';
import type { OperationalScope } from '../../../operations/context.ts';
import type { CatalogSnapshotId } from '../../ids.ts';
import { AccessScopeIdSchema, TenantIdSchema } from '../../ids.ts';
import { lockRoles, writeGrantIncarnations } from '../../intent/grant-incarnations.ts';
import type {
  AccessChangeDecision,
  AccessChangeDecisionKind,
  AccessChangeItem,
  AccessChangeItemStatus,
  CatalogSnapshot,
  CatalogSnapshotEntry,
  Cell,
  Role,
  RoleProvenance,
  RoleRevision,
} from '../../model.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  AccessChangeDecisionSchema,
  AccessChangeItemSchema,
  CatalogSnapshotEntrySchema,
  CatalogSnapshotSchema,
  RoleProvenanceSchema,
  RoleRevisionSchema,
  RoleSchema,
  cellSlotKey,
  namesRoleTemplate,
} from '../../model.ts';
import { cellContentKey } from '../role-edits.ts';
import type { RoleCellEdit, RoleWithRevision } from '../role-edits.ts';
import type { AccessChangesStoreError } from './errors/index.ts';
import { storeConflict, storeUnavailable } from './errors/index.ts';
import { isReplayedRole, isReplayedRoleRevision } from './role-replay.ts';
import { AccessChangesStore } from './store.ts';
import type {
  AccessChangesState,
  AccessChangesStoreService,
  CatalogPublication,
  PublishCatalogInput,
  RecordAdoptionInput,
  RecordChangeItemsInput,
  RecordDeclineInput,
  RecordRoleInput,
  RecordRoleRevisionInput,
  RecordUndoInput,
} from './store.ts';

/** The Core executor the store is built over; the caller owns the pool, its scope and its deadlines. */
export interface AccessChangesDatabase {
  readonly executor: CoreDatabaseExecutor;
}

const decodeEntry = Schema.decodeUnknownResult(CatalogSnapshotEntrySchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeSnapshot = Schema.decodeUnknownResult(CatalogSnapshotSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeRole = Schema.decodeUnknownResult(RoleSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeRevision = Schema.decodeUnknownResult(RoleRevisionSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeItem = Schema.decodeUnknownResult(AccessChangeItemSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeDecision = Schema.decodeUnknownResult(AccessChangeDecisionSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeProvenance = Schema.decodeUnknownOption(RoleProvenanceSchema);

/**
 * The unique indexes of the tables this store writes. A collision on one of them is the same
 * conflict as a lost compare-and-set: two writers planned from the same revision and only the first
 * can be stored. Core owns the SQLSTATE taxonomy; this store owns only its own constraint names.
 */
const OWNER_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_catalog_entries_pk',
  'access_catalog_snapshot_digest_uk',
  'access_catalog_snapshots_pkey',
  'access_change_decisions_batch_item_uk',
  'access_change_decisions_pkey',
  'access_change_decisions_tenant_id_uk',
  'access_change_items_catalog_key_uk',
  'access_change_items_pkey',
  'access_change_items_tenant_id_uk',
  'access_role_revisions_number_uk',
  'access_role_revisions_pkey',
  'access_role_revisions_role_uk',
  'access_role_revisions_tenant_id_uk',
  'access_roles_pkey',
  'access_roles_tenant_id_uk',
]);

/**
 * A write PostgreSQL refused. A uniqueness collision on one of this store's own indexes is a race the
 * caller repairs by re-reading, exactly like a lost compare-and-set. An integrity refusal — a class-23
 * constraint or an access trigger's `55000` — proves that this row can never be stored, so it is a
 * refusal and never retried. Only a connectivity, capacity or shutdown failure is retryable
 * unavailability, so a driver failure is never reported as a decision about the data.
 */
const sqlFailure = (failure: SqlError | EffectDrizzleQueryError): AccessChangesStoreError => {
  if (isPostgresUniqueViolation(failure, OWNER_UNIQUE_CONSTRAINTS)) {
    return storeConflict('access_changes_record_conflict', 'another writer already stored the record this plan claims');
  }
  if (isDatabaseIntegrityRefusal(failure)) {
    return storeConflict(
      'access_changes_write_refused',
      'PostgreSQL refused this record: it breaks a rule the access tables keep',
    );
  }
  return storeUnavailable(
    isDatabaseUnavailableFailure(failure)
      ? 'The Access changes store is unavailable'
      : 'The Access changes store could not settle the write',
    failure,
  );
};

type StoreFailure = EffectDrizzleQueryError | SqlError | AccessChangesStoreError;

/** Only the driver failures this store understands are named; a bug stays a defect and is never retried. */
const durable = <Value>(effect: Effect.Effect<Value, StoreFailure>): Effect.Effect<Value, AccessChangesStoreError> =>
  effect.pipe(
    Effect.catchTags({
      EffectDrizzleQueryError: (failure) => Effect.fail(sqlFailure(failure)),
      SqlError: (failure) => Effect.fail(sqlFailure(failure)),
    }),
  );

/** The driver may hand a timestamp back as text; the model takes a `Date`, so both land as one. */
const asDate = (value: Date | string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value));

const sameInstant = (left: Date, right: Date): boolean =>
  DateTime.Equivalence(DateTime.makeUnsafe(left), DateTime.makeUnsafe(right));

const unique = <Value>(values: readonly Value[]): readonly Value[] => [...new Set(values)];

/**
 * The columns every write and read of this store touches, named once. A column added to a table later
 * cannot silently join a model the caller decodes.
 */
const roleColumns = {
  createdAt: accessRoles.createdAt,
  createdBy: accessRoles.createdBy,
  legalEntityId: accessRoles.legalEntityId,
  name: accessRoles.name,
  roleId: accessRoles.roleId,
  tenantId: accessRoles.tenantId,
} as const;
const revisionColumns = {
  catalogSnapshotId: accessRoleRevisions.catalogSnapshotId,
  cellsJson: accessRoleRevisions.cellsJson,
  createdAt: accessRoleRevisions.createdAt,
  createdBy: accessRoleRevisions.createdBy,
  provenance: accessRoleRevisions.provenance,
  revision: accessRoleRevisions.revision,
  roleId: accessRoleRevisions.roleId,
  roleRevisionId: accessRoleRevisions.roleRevisionId,
  templateKey: accessRoleRevisions.templateKey,
  tenantId: accessRoleRevisions.tenantId,
} as const;
const itemColumns = {
  capabilityKey: accessChangeItems.capabilityKey,
  catalogSnapshotId: accessChangeItems.catalogSnapshotId,
  createdAt: accessChangeItems.createdAt,
  itemId: accessChangeItems.itemId,
  kind: accessChangeItems.kind,
  lineageFrom: accessChangeItems.lineageFrom,
  risk: accessChangeItems.risk,
  status: accessChangeItems.status,
  suggestedRoleIds: accessChangeItems.suggestedRoleIds,
  tenantId: accessChangeItems.tenantId,
} as const;
const decisionColumns = {
  batchId: accessChangeDecisions.batchId,
  decidedAt: accessChangeDecisions.decidedAt,
  decidedBy: accessChangeDecisions.decidedBy,
  decision: accessChangeDecisions.decision,
  decisionId: accessChangeDecisions.decisionId,
  itemId: accessChangeDecisions.itemId,
  roleRevisionIds: accessChangeDecisions.roleRevisionIds,
  tenantId: accessChangeDecisions.tenantId,
  undoesDecisionId: accessChangeDecisions.undoesDecisionId,
} as const;

interface RoleRow {
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly legalEntityId: string | null;
  readonly name: string;
  readonly roleId: string;
  readonly tenantId: string;
}

interface RevisionRow {
  readonly catalogSnapshotId: string;
  readonly cellsJson: readonly Cell[];
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly provenance: string;
  readonly revision: number;
  readonly roleId: string;
  readonly roleRevisionId: string;
  readonly templateKey: string | null;
  readonly tenantId: string;
}

interface ItemRow {
  readonly capabilityKey: string;
  readonly catalogSnapshotId: string;
  readonly createdAt: Date | string;
  readonly itemId: string;
  readonly kind: string;
  readonly lineageFrom: readonly string[];
  readonly risk: string;
  readonly status: string;
  readonly suggestedRoleIds: readonly string[];
  readonly tenantId: string;
}

interface DecisionRow {
  readonly batchId: string;
  readonly decidedAt: Date | string;
  readonly decidedBy: string;
  readonly decision: string;
  readonly decisionId: string;
  readonly itemId: string;
  readonly roleRevisionIds: readonly string[];
  readonly tenantId: string;
  readonly undoesDecisionId: string | null;
}

interface EntryRow {
  readonly capabilityKey: string;
  readonly entryJson: unknown;
}

/** The model omits an absent column value while the column stores null; both mean "not declared". */
const optionalProperty = <Base extends object, Key extends string, Value>(base: Base, key: Key, value: Value | null) =>
  value === null ? base : { ...base, [key]: value };

interface MessageIssue {
  readonly message: string;
}

/** A row that no longer decodes as the model is intent the store refuses to serve as if it were valid. */
const decodeStored = <Value, Issue extends MessageIssue>(
  result: Result.Result<Value, Issue>,
  subject: string,
): Effect.Effect<Value, AccessChangesStoreError> =>
  Result.match(result, {
    onFailure: (failure) =>
      Effect.fail(
        storeConflict('access_changes_record_conflict', `the stored ${subject} is invalid: ${failure.message}`),
      ),
    onSuccess: (decoded) => Effect.succeed(decoded),
  });

const decodeRoleRow = (row: RoleRow) =>
  decodeStored(
    decodeRole({
      createdAt: asDate(row.createdAt),
      createdBy: row.createdBy,
      id: row.roleId,
      name: row.name,
      tenantId: row.tenantId,
      ...optionalProperty({}, 'legalEntityId', row.legalEntityId),
    }),
    `role ${row.roleId}`,
  );

const decodeRevisionRow = (row: RevisionRow) =>
  decodeStored(
    decodeRevision({
      catalogSnapshotId: row.catalogSnapshotId,
      cells: row.cellsJson,
      createdAt: asDate(row.createdAt),
      createdBy: row.createdBy,
      id: row.roleRevisionId,
      provenance: row.provenance,
      revision: row.revision,
      roleId: row.roleId,
      tenantId: row.tenantId,
      ...optionalProperty({}, 'templateKey', row.templateKey),
    }),
    `role revision ${row.roleRevisionId}`,
  );

const decodeItemRow = (row: ItemRow) =>
  decodeStored(
    decodeItem({
      capabilityKey: row.capabilityKey,
      catalogSnapshotId: row.catalogSnapshotId,
      createdAt: asDate(row.createdAt),
      id: row.itemId,
      kind: row.kind,
      lineageFrom: row.lineageFrom,
      risk: row.risk,
      status: row.status,
      suggestedRoleIds: row.suggestedRoleIds,
      tenantId: row.tenantId,
    }),
    `access change item ${row.itemId}`,
  );

const decodeDecisionRow = (row: DecisionRow) =>
  decodeStored(
    decodeDecision({
      batchId: row.batchId,
      decidedAt: asDate(row.decidedAt),
      decidedBy: row.decidedBy,
      decision: row.decision,
      id: row.decisionId,
      itemId: row.itemId,
      roleRevisionIds: row.roleRevisionIds,
      tenantId: row.tenantId,
      ...optionalProperty({}, 'undoesDecisionId', row.undoesDecisionId),
    }),
    `access change decision ${row.decisionId}`,
  );

const decodeEntryRow = (row: EntryRow) =>
  decodeStored(decodeEntry(row.entryJson), `catalog entry ${row.capabilityKey}`);

/** The release is the entries it carries, so a retry must find exactly the entries it publishes. */
const publishedEntriesIssue = (
  planned: readonly CatalogSnapshotEntry[],
  stored: readonly CatalogSnapshotEntry[],
): string | null => {
  const equivalence = Schema.toEquivalence(CatalogSnapshotEntrySchema);
  const storedByKey = new Map(stored.map((entry) => [entry.key, entry]));
  const divergent = planned.find((entry) => {
    const found = storedByKey.get(entry.key);
    return found === undefined || !equivalence(found, entry);
  });
  if (divergent !== undefined) {
    return `the release stores a different entry for ${divergent.key} than it publishes`;
  }
  const plannedKeys = new Set(planned.map(({ key }) => key));
  const foreign = stored.find(({ key }) => !plannedKeys.has(key));
  return foreign === undefined ? null : `the release already stores entry ${foreign.key}, which it does not publish`;
};

/**
 * A revision is an exact successor: the current cells minus the removed ones plus the added ones, by
 * exact cell content and not by slot. A plan claiming any other cell set would write a revision no
 * decision ever described.
 *
 * A slot the revision already holds is therefore *replaced*, never added twice: a state that changes a
 * policy value without changing the slot (an amount ceiling, R5a-6) names the held cell in
 * `removedCells` and the new content in `addedCells` of the same edit, so the incarnations of that slot
 * move with it. An add of a slot the edit does not also remove stays a conflict, because two cell sets
 * of one slot cannot both be the successor.
 */
const revisionIssue = (source: readonly Cell[], edit: RoleCellEdit): string | null => {
  const sourceBySlot = new Map(source.map((cell) => [cellSlotKey(cell), cell] as const));
  const addedBySlot = new Map(edit.addedCells.map((cell) => [cellSlotKey(cell), cell] as const));
  const removedSlots = new Set(edit.removedCells.map(cellSlotKey));
  const removedMissing = [...removedSlots].find((slot) => !sourceBySlot.has(slot));
  if (removedMissing !== undefined) {
    return `cell ${removedMissing} is not part of role ${edit.roleId}'s current revision`;
  }
  const removedStale = edit.removedCells.find((cell) => {
    const held = sourceBySlot.get(cellSlotKey(cell));
    return held !== undefined && cellContentKey(held) !== cellContentKey(cell);
  });
  if (removedStale !== undefined) {
    return `cell ${cellContentKey(removedStale)} is not the cell role ${edit.roleId} holds in that slot, so the edit ends nothing`;
  }
  const addedPresent = [...addedBySlot.keys()].find((slot) => sourceBySlot.has(slot) && !removedSlots.has(slot));
  if (addedPresent !== undefined) {
    return `cell ${addedPresent} already belongs to role ${edit.roleId}'s current revision, and this edit does not replace it`;
  }
  const expected = new Map<string, string>(
    [...sourceBySlot].flatMap(([slot, cell]) =>
      removedSlots.has(slot) ? [] : [[slot, cellContentKey(cell)] as const],
    ),
  );
  for (const [slot, cell] of addedBySlot) {
    expected.set(slot, cellContentKey(cell));
  }
  const successor = new Map(edit.cells.map((cell) => [cellSlotKey(cell), cellContentKey(cell)] as const));
  return edit.cells.length === expected.size &&
    [...expected].every(([slot, content]) => successor.get(slot) === content)
    ? null
    : `the successor revision of role ${edit.roleId} is not its current revision plus the added minus the removed cells`;
};

/**
 * A role edit is the customer changing their own role, so a revision derived from a template keeps
 * naming that template and every other revision is manual. Provenance is read from the revision the
 * edit was planned against, never invented here.
 */
const derivedProvenance = (source: {
  readonly provenance: string;
  readonly templateKey: string | null;
}): Option.Option<{ readonly provenance: RoleProvenance; readonly templateKey: string | null }> =>
  Option.map(decodeProvenance(source.provenance), (provenance) =>
    namesRoleTemplate(provenance)
      ? { provenance: 'customer_changed' as const, templateKey: source.templateKey }
      : { provenance: 'manual' as const, templateKey: null },
  );

/* ------------------------------------------------------------------------------------------------
 * One transaction's worth of work, named and defined outside the store
 * ---------------------------------------------------------------------------------------------- */

/** One item moves once: pending to adopted or declined, adopted to undone (O54, L3). */
const transitionItem = Effect.fn('AccessChangesStore.transitionItem')(function* transitionItemEffect(
  transaction: CoreTransaction,
  tenantId: string,
  itemId: string,
  from: AccessChangeItemStatus,
  to: AccessChangeItemStatus,
) {
  const updated = yield* transaction
    .update(accessChangeItems)
    .set({ status: to })
    .where(
      and(
        eq(accessChangeItems.tenantId, tenantId),
        eq(accessChangeItems.itemId, itemId),
        eq(accessChangeItems.status, from),
      ),
    )
    .returning({ itemId: accessChangeItems.itemId });
  return updated.length === 1
    ? yield* Effect.void
    : yield* storeConflict(
        'access_changes_item_not_pending',
        `item ${itemId} is no longer ${from} for tenant ${tenantId}, so it never becomes ${to}`,
      );
});

/** The stored revision that currently expresses a role, which the next revision must succeed. */
const currentRevision = Effect.fn('AccessChangesStore.currentRevision')(function* currentRevisionEffect(
  transaction: CoreTransaction,
  tenantId: string,
  roleId: string,
) {
  const rows = yield* transaction
    .select({
      cellsJson: accessRoleRevisions.cellsJson,
      provenance: accessRoleRevisions.provenance,
      revision: accessRoleRevisions.revision,
      roleRevisionId: accessRoleRevisions.roleRevisionId,
      templateKey: accessRoleRevisions.templateKey,
    })
    .from(accessRoleRevisions)
    .where(and(eq(accessRoleRevisions.tenantId, tenantId), eq(accessRoleRevisions.roleId, roleId)))
    .orderBy(desc(accessRoleRevisions.revision))
    .limit(1);
  return rows.at(0);
});

/**
 * A decision references the revisions it was taken with, and an undo references the adoption it
 * undoes. Both are checked against the rows that exist, so the append-only decision log can never
 * claim a revision, or undo an adoption, that this tenant does not have (O54, R2-M8).
 */
const recordDecision = Effect.fn('AccessChangesStore.recordDecision')(function* recordDecisionEffect(
  transaction: CoreTransaction,
  tenantId: string,
  decision: AccessChangeDecision,
) {
  const { undoesDecisionId } = decision;
  if (undoesDecisionId !== undefined) {
    const [adoption] = yield* transaction
      .select({ decision: accessChangeDecisions.decision, itemId: accessChangeDecisions.itemId })
      .from(accessChangeDecisions)
      .where(and(eq(accessChangeDecisions.tenantId, tenantId), eq(accessChangeDecisions.decisionId, undoesDecisionId)));
    if (adoption === undefined || adoption.decision !== 'adopt' || adoption.itemId !== decision.itemId) {
      return yield* storeConflict(
        'access_changes_undo_not_an_adoption',
        `decision ${undoesDecisionId} is not an adoption of item ${decision.itemId} by tenant ${tenantId}`,
      );
    }
    const [previousUndo] = yield* transaction
      .select({ decisionId: accessChangeDecisions.decisionId })
      .from(accessChangeDecisions)
      .where(
        and(eq(accessChangeDecisions.tenantId, tenantId), eq(accessChangeDecisions.undoesDecisionId, undoesDecisionId)),
      );
    if (previousUndo !== undefined) {
      return yield* storeConflict(
        'access_changes_record_conflict',
        `adoption ${undoesDecisionId} is already undone by decision ${previousUndo.decisionId}`,
      );
    }
  }
  yield* transaction.insert(accessChangeDecisions).values({
    batchId: decision.batchId,
    decidedAt: decision.decidedAt,
    decidedBy: decision.decidedBy,
    decision: decision.decision,
    decisionId: decision.id,
    itemId: decision.itemId,
    roleRevisionIds: [...decision.roleRevisionIds],
    tenantId: decision.tenantId,
    undoesDecisionId: undoesDecisionId ?? null,
  });
  return yield* Effect.void;
});

interface RoleRevisionWrite {
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly decidedAt: Date;
  readonly decidedBy: string;
  readonly edit: RoleCellEdit;
  readonly expectedHolders?: readonly string[];
  readonly grantorCover?: readonly { readonly incarnationId: string; readonly roleRevisionId: string }[];
  readonly tenantId: string;
}

/**
 * A role revision is written only over the revision it was planned against, forward only, and never
 * changed afterwards (the tables refuse both an update and a delete). Two concurrent plans therefore
 * cannot both succeed: the second finds the current revision moved, or loses the revision number to
 * the unique index, and re-reads (guarantee 5, D23). The role's exclusive lock comes first, so no new
 * assignment can pin the revision this one succeeds after its holders were moved.
 */
/**
 * A delegated edit commits only while its grantor still holds what it was checked against: the
 * covering grantor assignments are locked for share, so a removal waits for this commit, and one that
 * already committed refuses the edit as stale.
 */
const requireGrantorAssignments = Effect.fn('AccessChangesStore.requireGrantorAssignments')(function* requireGrantor(
  transaction: CoreTransaction,
  tenantId: string,
  cover: readonly { readonly incarnationId: string; readonly roleRevisionId: string }[],
) {
  if (cover.length === 0) {
    return yield* Effect.void;
  }
  const held = yield* transaction
    .select({ incarnationId: accessAssignments.incarnationId, roleRevisionId: accessAssignments.roleRevisionId })
    .from(accessAssignments)
    .where(
      and(
        eq(accessAssignments.tenantId, tenantId),
        inArray(
          accessAssignments.incarnationId,
          cover.map(({ incarnationId }) => incarnationId),
        ),
        eq(accessAssignments.status, 'active'),
      ),
    )
    .for('share');
  // Each covering assignment must still be active and still cover through the same revision.
  const intact = cover.every(({ incarnationId, roleRevisionId }) =>
    held.some((row) => row.incarnationId === incarnationId && row.roleRevisionId === roleRevisionId),
  );
  if (!intact) {
    return yield* storeConflict(
      'access_changes_revision_stale',
      'the grantor no longer holds the authority this delegated edit was checked against',
    );
  }
  return yield* Effect.void;
});

const recordRevision = Effect.fn('AccessChangesStore.recordRevision')(function* recordRevisionEffect(
  transaction: CoreTransaction,
  write: RoleRevisionWrite,
) {
  const { catalogSnapshotId, decidedAt, decidedBy, edit, tenantId } = write;
  yield* lockRoles(transaction, { mode: 'no key update', roleIds: [edit.roleId], tenantId });
  const current = yield* currentRevision(transaction, tenantId, edit.roleId);
  if (current === undefined) {
    return yield* storeConflict(
      'access_changes_role_revision_missing',
      `role ${edit.roleId} of tenant ${tenantId} has no revision to succeed`,
    );
  }
  if (current.roleRevisionId !== edit.sourceRevisionId) {
    return yield* storeConflict(
      'access_changes_revision_stale',
      `role ${edit.roleId} moved from revision ${edit.sourceRevisionId} to ${current.roleRevisionId}`,
    );
  }
  yield* requireGrantorAssignments(transaction, tenantId, write.grantorCover ?? []);
  // Under the lock no assignment can join: a holder the delegated envelope never checked refuses the
  // edit, which the caller re-reads and checks again with that holder in it.
  const { expectedHolders } = write;
  if (expectedHolders !== undefined) {
    const checked = new Set(expectedHolders);
    const live = yield* transaction
      .select({ incarnationId: accessAssignments.incarnationId })
      .from(accessAssignments)
      .where(
        and(
          eq(accessAssignments.tenantId, tenantId),
          eq(accessAssignments.roleId, edit.roleId),
          eq(accessAssignments.status, 'active'),
          // Every row the successor update below moves, including one that starts after the decision:
          // only an assignment that has already ended stays where it is and grants nothing.
          or(isNull(accessAssignments.validUntil), gt(accessAssignments.validUntil, decidedAt)),
        ),
      );
    const unchecked = live.find(({ incarnationId }) => !checked.has(incarnationId));
    if (unchecked !== undefined) {
      return yield* storeConflict(
        'access_changes_revision_stale',
        `role ${edit.roleId} has holder ${unchecked.incarnationId}, which the edit was not checked against`,
      );
    }
  }
  const successorIssue = revisionIssue(current.cellsJson, edit);
  if (successorIssue !== null) {
    return yield* storeConflict('access_changes_record_conflict', successorIssue);
  }
  const derived = derivedProvenance(current);
  if (Option.isNone(derived)) {
    return yield* storeConflict(
      'access_changes_record_conflict',
      `role revision ${current.roleRevisionId} names an unknown provenance "${current.provenance}"`,
    );
  }
  yield* transaction.insert(accessRoleRevisions).values({
    catalogSnapshotId,
    cellsJson: edit.cells,
    createdAt: decidedAt,
    createdBy: decidedBy,
    provenance: derived.value.provenance,
    revision: current.revision + 1,
    roleId: edit.roleId,
    roleRevisionId: edit.targetRevisionId,
    templateKey: derived.value.templateKey,
    tenantId,
  });
  // A role edit re-points every live holder at the successor revision without rewriting the holder
  // (D23, O51(1)), so the cells the revision expresses reach them without a second write per holder.
  yield* transaction
    .update(accessAssignments)
    .set({ roleRevisionId: edit.targetRevisionId })
    .where(
      and(
        eq(accessAssignments.tenantId, tenantId),
        eq(accessAssignments.roleId, edit.roleId),
        eq(accessAssignments.status, 'active'),
      ),
    );
  // The incarnation a decision witnesses must move with the revision: a cell added without one grants
  // nothing and a removed cell without a retirement keeps granting (O52, guarantee 9).
  const bindingScopes = yield* transaction
    .selectDistinct({ scopeId: accessAssignments.scopeId })
    .from(accessAssignments)
    .where(and(eq(accessAssignments.tenantId, tenantId), eq(accessAssignments.roleId, edit.roleId)));
  yield* writeGrantIncarnations(transaction, {
    addedCells: edit.addedCells,
    removedCells: edit.removedCells,
    roleId: edit.roleId,
    scopeIds: bindingScopes.map(({ scopeId }) => AccessScopeIdSchema.make(scopeId)),
    targetRevisionId: edit.targetRevisionId,
    tenantId: TenantIdSchema.make(tenantId),
  });
  return yield* Effect.void;
});

interface DecisionBatch {
  /** The release a written revision is pinned to; required as soon as the batch writes a revision. */
  readonly catalogSnapshotId?: CatalogSnapshotId;
  /** The holders a delegated envelope checked, per edited role; re-checked under each role's lock. */
  readonly checkedHolders?: readonly { readonly incarnationIds: readonly string[]; readonly roleId: string }[];
  readonly decisions: readonly AccessChangeDecision[];
  readonly expected: AccessChangeDecisionKind;
  readonly expectedStatus: AccessChangeItemStatus;
  /** The grantor assignments covering a delegated batch's cells, locked and re-checked as it commits. */
  readonly grantorCover?: readonly { readonly incarnationId: string; readonly roleRevisionId: string }[];
  readonly items: readonly AccessChangeItem[];
  readonly roleEdits: readonly RoleCellEdit[];
}

/**
 * Everything about a plan the store proves without the database: one decider at one instant, one
 * tenant, one kind of decision, one decision per item, and every referenced revision written here.
 * The decider is the scope's own principal, so a plan built for somebody else never writes.
 */
const batchIssue = (
  scope: OperationalScope,
  { catalogSnapshotId, decisions, expected, expectedStatus, items, roleEdits }: DecisionBatch,
): string | null => {
  const first = decisions.at(0);
  if (first === undefined) {
    return 'a decision plan carries at least one decision';
  }
  const tenantIds = [...items.map(({ tenantId }) => tenantId), ...decisions.map(({ tenantId }) => tenantId)];
  const foreignTenant = tenantIds.find((tenantId) => tenantId !== scope.tenantId);
  if (foreignTenant !== undefined) {
    return `the plan writes tenant ${foreignTenant} while the installed scope is tenant ${scope.tenantId}`;
  }
  const foreignDecider = decisions.find(({ decidedBy }) => decidedBy !== scope.principalId);
  if (foreignDecider !== undefined) {
    return `decision ${foreignDecider.id} is taken by ${foreignDecider.decidedBy}, not by the scoped person ${scope.principalId}`;
  }
  const mixedDecider = decisions.find(
    ({ decidedAt, decidedBy }) => decidedBy !== first.decidedBy || !sameInstant(decidedAt, first.decidedAt),
  );
  if (mixedDecider !== undefined) {
    return `decision ${mixedDecider.id} is not the same person at the same instant as the rest of its plan`;
  }
  const wrongKind = decisions.find(({ decision }) => decision !== expected);
  if (wrongKind !== undefined) {
    return `decision ${wrongKind.id} is a ${wrongKind.decision}, not an ${expected}`;
  }
  const wrongStatus = items.find(({ status }) => status !== expectedStatus);
  if (wrongStatus !== undefined) {
    return `item ${wrongStatus.id} is ${wrongStatus.status}, not ${expectedStatus}`;
  }
  const itemIds = unique(items.map(({ id }) => id));
  if (itemIds.length !== items.length) {
    return 'a plan names each item once';
  }
  const decidedItemIds = unique(decisions.map(({ itemId }) => itemId));
  const paired =
    decidedItemIds.length === decisions.length &&
    decidedItemIds.length === itemIds.length &&
    decidedItemIds.every((itemId) => itemIds.some((candidate) => candidate === itemId));
  if (!paired) {
    return 'every item of a plan carries exactly one decision, and no decision names a foreign item';
  }
  const writtenRevisions = new Set<string>(roleEdits.map(({ targetRevisionId }) => targetRevisionId));
  const foreignRevision = decisions
    .flatMap(({ roleRevisionIds }) => roleRevisionIds)
    .find((revisionId) => !writtenRevisions.has(revisionId));
  if (foreignRevision !== undefined) {
    return `revision ${foreignRevision} is referenced by a decision but not written by this plan`;
  }
  if (roleEdits.length > 0 && catalogSnapshotId === undefined) {
    return 'a plan that writes a role revision pins the release it was taken against';
  }
  const mismatchedUndo = decisions.find(({ decision, undoesDecisionId }) =>
    decision === 'undo' ? undoesDecisionId === undefined : undoesDecisionId !== undefined,
  );
  return mismatchedUndo === undefined ? null : `decision ${mismatchedUndo.id} names the wrong undone decision`;
};

/** One decision batch: the items move once, then the revisions it pins, then its decisions. */
const writeDecisionBatchTransaction = Effect.fn('AccessChangesStore.writeDecisionBatchTransaction')(
  function* writeBatch(transaction: CoreTransaction, scope: OperationalScope, batch: DecisionBatch) {
    const decided = batch.decisions.at(0);
    if (decided === undefined) {
      return yield* storeConflict('access_changes_record_conflict', 'a decision plan carries at least one decision');
    }
    // Every role the batch edits is locked before its items, in role id order, so two batches and an
    // assignment that name the same roles always queue in one order instead of deadlocking.
    yield* lockRoles(transaction, {
      mode: 'no key update',
      roleIds: batch.roleEdits.map(({ roleId }) => roleId),
      tenantId: scope.tenantId,
    });
    const from: AccessChangeItemStatus = batch.expectedStatus === 'undone' ? 'adopted' : 'pending';
    yield* Effect.forEach(
      batch.items,
      (item) => transitionItem(transaction, scope.tenantId, item.id, from, batch.expectedStatus),
      { concurrency: 1, discard: true },
    );
    yield* requireGrantorAssignments(transaction, scope.tenantId, batch.grantorCover ?? []);
    const { catalogSnapshotId } = batch;
    if (catalogSnapshotId !== undefined) {
      yield* Effect.forEach(
        batch.roleEdits,
        (edit) => {
          const write = {
            catalogSnapshotId,
            decidedAt: decided.decidedAt,
            decidedBy: decided.decidedBy,
            edit,
            tenantId: scope.tenantId,
          };
          const checked = batch.checkedHolders?.find(({ roleId }) => roleId === edit.roleId);
          // A delegated batch that names no holders for an edited role checked nobody there.
          const expectedHolders = batch.checkedHolders === undefined ? undefined : (checked?.incarnationIds ?? []);
          return recordRevision(transaction, expectedHolders === undefined ? write : { ...write, expectedHolders });
        },
        { concurrency: 1, discard: true },
      );
    }
    yield* Effect.forEach(batch.decisions, (decision) => recordDecision(transaction, scope.tenantId, decision), {
      concurrency: 1,
      discard: true,
    });
    return yield* Effect.void;
  },
);

/** A role with the revision that currently expresses it; a role without one is not intent at all. */
const pairRoleWithRevision = Effect.fnUntraced(function* pairRoleWithRevisionEffect(
  role: Role,
  revisions: readonly RoleRevision[],
) {
  const current = revisions
    .filter(({ roleId }) => roleId === role.id)
    .toSorted((left, right) => right.revision - left.revision)
    .at(0);
  if (current === undefined) {
    return yield* storeConflict(
      'access_changes_role_revision_missing',
      `role ${role.id} of tenant ${role.tenantId} has no revision`,
    );
  }
  const paired: RoleWithRevision = Object.freeze({ revision: current, role });
  return paired;
});

/** One consistent snapshot of a tenant's intent, read in that tenant's own scope. */
const readTenantChanges = Effect.fn('AccessChangesStore.readTenantChanges')(function* readTenantChangesEffect(
  transaction: CoreTransaction,
  scope: OperationalScope,
) {
  const [roleRows, revisionRows, itemRows, decisionRows] = yield* Effect.all(
    [
      transaction
        .select(roleColumns)
        .from(accessRoles)
        .where(eq(accessRoles.tenantId, scope.tenantId))
        .orderBy(asc(accessRoles.roleId)),
      transaction
        .select(revisionColumns)
        .from(accessRoleRevisions)
        .where(eq(accessRoleRevisions.tenantId, scope.tenantId))
        .orderBy(asc(accessRoleRevisions.roleId), asc(accessRoleRevisions.revision)),
      transaction
        .select(itemColumns)
        .from(accessChangeItems)
        .where(eq(accessChangeItems.tenantId, scope.tenantId))
        .orderBy(asc(accessChangeItems.createdAt), asc(accessChangeItems.itemId)),
      transaction
        .select(decisionColumns)
        .from(accessChangeDecisions)
        .where(eq(accessChangeDecisions.tenantId, scope.tenantId))
        .orderBy(asc(accessChangeDecisions.decidedAt), asc(accessChangeDecisions.decisionId)),
    ],
    // One transaction holds one connection, so the four reads are ordered on purpose.
    { concurrency: 1 },
  );
  const [roles, revisions, items, decisions] = yield* Effect.all(
    [
      Effect.forEach(roleRows, decodeRoleRow, { concurrency: 1 }),
      Effect.forEach(revisionRows, decodeRevisionRow, { concurrency: 1 }),
      Effect.forEach(itemRows, decodeItemRow, { concurrency: 1 }),
      Effect.forEach(decisionRows, decodeDecisionRow, { concurrency: 1 }),
    ],
    { concurrency: 1 },
  );
  const rolesWithRevision = yield* Effect.forEach(roles, (role) => pairRoleWithRevision(role, revisions), {
    concurrency: 1,
  });
  const state: AccessChangesState = Object.freeze({
    decisions: Object.freeze(decisions),
    items: Object.freeze(items),
    revisions: Object.freeze(revisions),
    roles: Object.freeze(rolesWithRevision),
  });
  return state;
});

/**
 * The newest published release, with the entries pinned to it. A caller that already holds a
 * transaction reads the release there, so the entries it binds are the entries its own transaction
 * sees (O75); every other caller reads the newest committed release through the pool.
 */
const readPublishedCatalog = Effect.fn('AccessChangesStore.readPublishedCatalog')(function* readPublishedCatalogEffect(
  executor: CoreDbExecutor,
) {
  const snapshotRows = yield* executor
    .select({
      catalogSnapshotId: accessCatalogSnapshots.catalogSnapshotId,
      digest: accessCatalogSnapshots.digest,
      publishedAt: accessCatalogSnapshots.publishedAt,
    })
    .from(accessCatalogSnapshots)
    .orderBy(desc(accessCatalogSnapshots.publishedAt), desc(accessCatalogSnapshots.catalogSnapshotId))
    .limit(1);
  const snapshot = snapshotRows.at(0);
  if (snapshot === undefined) {
    return Option.none<CatalogSnapshot>();
  }
  const entryRows = yield* executor
    .select({ capabilityKey: accessCatalogEntries.capabilityKey, entryJson: accessCatalogEntries.entryJson })
    .from(accessCatalogEntries)
    .where(eq(accessCatalogEntries.catalogSnapshotId, snapshot.catalogSnapshotId))
    .orderBy(asc(accessCatalogEntries.capabilityKey));
  const entries = yield* Effect.forEach(entryRows, decodeEntryRow, { concurrency: 1 });
  return Option.some(
    yield* decodeStored(
      decodeSnapshot({
        digest: snapshot.digest,
        entries,
        id: snapshot.catalogSnapshotId,
        publishedAt: asDate(snapshot.publishedAt),
      }),
      `catalog snapshot ${snapshot.catalogSnapshotId}`,
    ),
  );
});

/**
 * Publishing is all-or-nothing and repaired by retry (D3): the digest is the release identity, so the
 * same digest writes nothing twice and a different snapshot under a known digest is refused.
 * Arbitrate both unique keys before validating the stored identity and entries.
 */
const publishRelease = Effect.fn('AccessChangesStore.publishRelease')(function* publishReleaseEffect(
  transaction: CoreTransaction,
  snapshot: CatalogSnapshot,
) {
  const insertedRows = yield* transaction
    .insert(accessCatalogSnapshots)
    .values({ catalogSnapshotId: snapshot.id, digest: snapshot.digest, publishedAt: snapshot.publishedAt })
    .onConflictDoNothing()
    .returning({ catalogSnapshotId: accessCatalogSnapshots.catalogSnapshotId });
  const inserted = insertedRows.at(0);
  if (inserted === undefined) {
    const [existing] = yield* transaction
      .select({ catalogSnapshotId: accessCatalogSnapshots.catalogSnapshotId })
      .from(accessCatalogSnapshots)
      .where(eq(accessCatalogSnapshots.digest, snapshot.digest));
    if (existing === undefined || existing.catalogSnapshotId !== snapshot.id) {
      return yield* storeConflict(
        'access_changes_catalog_conflict',
        `digest ${snapshot.digest} is already the identity of another release`,
      );
    }
  }
  if (inserted !== undefined && snapshot.entries.length > 0) {
    yield* transaction
      .insert(accessCatalogEntries)
      .values(
        snapshot.entries.map((entry) => ({
          capabilityKey: entry.key,
          catalogSnapshotId: snapshot.id,
          entryJson: entry,
        })),
      )
      .onConflictDoNothing({ target: [accessCatalogEntries.catalogSnapshotId, accessCatalogEntries.capabilityKey] });
  }
  const storedRows = yield* transaction
    .select({ capabilityKey: accessCatalogEntries.capabilityKey, entryJson: accessCatalogEntries.entryJson })
    .from(accessCatalogEntries)
    .where(eq(accessCatalogEntries.catalogSnapshotId, snapshot.id))
    .orderBy(asc(accessCatalogEntries.capabilityKey));
  const stored = yield* Effect.forEach(storedRows, decodeEntryRow, { concurrency: 1 });
  const divergence = publishedEntriesIssue(snapshot.entries, stored);
  if (divergence !== null) {
    return yield* storeConflict('access_changes_catalog_conflict', divergence);
  }
  const publication: CatalogPublication = Object.freeze({
    catalogSnapshotId: snapshot.id,
    inserted: inserted !== undefined,
  });
  return publication;
});

/**
 * A creation whose response was lost, or whose reconciliation failed, is retried with the same IDs. The
 * same role and revision already stored are the same creation and are not written twice; the same IDs
 * holding other content are refused, never left to fail as a raw key violation.
 */
const writeRole = Effect.fn('AccessChangesStore.writeRole')(function* writeRoleEffect(
  transaction: CoreTransaction,
  { revision, role }: Pick<RecordRoleInput, 'revision' | 'role'>,
) {
  const insertedRoles = yield* transaction
    .insert(accessRoles)
    .values({
      createdAt: role.createdAt,
      createdBy: role.createdBy,
      legalEntityId: role.legalEntityId ?? null,
      name: role.name,
      roleId: role.id,
      tenantId: role.tenantId,
    })
    .onConflictDoNothing({ target: accessRoles.roleId })
    .returning({ roleId: accessRoles.roleId });
  if (insertedRoles.length === 0) {
    const [storedRow] = yield* transaction.select(roleColumns).from(accessRoles).where(eq(accessRoles.roleId, role.id));
    const stored = storedRow === undefined ? undefined : yield* decodeRoleRow(storedRow);
    if (stored === undefined || !isReplayedRole(stored, role)) {
      return yield* storeConflict('access_changes_record_conflict', `role ${role.id} is already recorded differently`);
    }
  }
  const insertedRevisions = yield* transaction
    .insert(accessRoleRevisions)
    .values({
      catalogSnapshotId: revision.catalogSnapshotId,
      cellsJson: revision.cells,
      createdAt: revision.createdAt,
      createdBy: revision.createdBy,
      provenance: revision.provenance,
      revision: revision.revision,
      roleId: revision.roleId,
      roleRevisionId: revision.id,
      templateKey: revision.templateKey ?? null,
      tenantId: revision.tenantId,
    })
    .onConflictDoNothing({ target: accessRoleRevisions.roleRevisionId })
    .returning({ roleRevisionId: accessRoleRevisions.roleRevisionId });
  if (insertedRevisions.length === 0) {
    const [storedRow] = yield* transaction
      .select(revisionColumns)
      .from(accessRoleRevisions)
      .where(eq(accessRoleRevisions.roleRevisionId, revision.id));
    const stored = storedRow === undefined ? undefined : yield* decodeRevisionRow(storedRow);
    if (stored === undefined || !isReplayedRoleRevision(stored, revision)) {
      return yield* storeConflict(
        'access_changes_record_conflict',
        `role revision ${revision.id} is already recorded differently`,
      );
    }
  }
  return yield* Effect.void;
});

/**
 * A release creates one pending item per change. The same change in the same release is the same
 * item, so a retried publish finds it instead of creating a second one, and a different identity for
 * the same change is refused (D3, guarantee 2).
 */
const writeChangeItem = Effect.fn('AccessChangesStore.writeChangeItem')(function* writeChangeItemEffect(
  transaction: CoreTransaction,
  item: AccessChangeItem,
) {
  const inserted = yield* transaction
    .insert(accessChangeItems)
    .values({
      capabilityKey: item.capabilityKey,
      catalogSnapshotId: item.catalogSnapshotId,
      createdAt: item.createdAt,
      itemId: item.id,
      kind: item.kind,
      lineageFrom: [...item.lineageFrom],
      risk: item.risk,
      status: item.status,
      suggestedRoleIds: [...item.suggestedRoleIds],
      tenantId: item.tenantId,
    })
    .onConflictDoNothing({
      target: [
        accessChangeItems.tenantId,
        accessChangeItems.catalogSnapshotId,
        accessChangeItems.capabilityKey,
        accessChangeItems.kind,
      ],
    })
    .returning({ itemId: accessChangeItems.itemId });
  if (inserted.length === 1) {
    return yield* Effect.void;
  }
  const [existing] = yield* transaction
    .select({ itemId: accessChangeItems.itemId })
    .from(accessChangeItems)
    .where(
      and(
        eq(accessChangeItems.tenantId, item.tenantId),
        eq(accessChangeItems.catalogSnapshotId, item.catalogSnapshotId),
        eq(accessChangeItems.capabilityKey, item.capabilityKey),
        eq(accessChangeItems.kind, item.kind),
      ),
    );
  return existing?.itemId === item.id
    ? yield* Effect.void
    : yield* storeConflict(
        'access_changes_record_conflict',
        `change ${item.kind}:${item.capabilityKey} of release ${item.catalogSnapshotId} is already item ${existing?.itemId ?? 'unknown'}`,
      );
});

/** Every write of this store runs in one tenant scope and writes only that tenant's rows. */
const tenantIssue = (scope: OperationalScope, tenantIds: readonly string[]): string | null => {
  const foreign = tenantIds.find((tenantId) => tenantId !== scope.tenantId);
  return foreign === undefined
    ? null
    : `the plan writes tenant ${foreign} while the installed scope is tenant ${scope.tenantId}`;
};

export const makeAccessChangesDrizzleStore = (database: AccessChangesDatabase): AccessChangesStoreService => {
  const runScoped = <Value>(
    scope: OperationalScope,
    body: (transaction: CoreTransaction) => Effect.Effect<Value, StoreFailure>,
  ): Effect.Effect<Value, AccessChangesStoreError> =>
    durable(
      database.executor.transaction((transaction) =>
        installOperationalScope(transaction, scope).pipe(
          Effect.mapError((failure) => storeUnavailable('The tenant scope could not be installed', failure)),
          Effect.andThen(() => body(transaction)),
        ),
      ),
    );

  const loadPublishedCatalog: AccessChangesStoreService['loadPublishedCatalog'] = Effect.fn(
    'AccessChangesStore.loadPublishedCatalog',
  )(function* loadPublishedCatalogEffect(transaction?: CoreTransaction) {
    return yield* durable(readPublishedCatalog(transaction ?? database.executor));
  });

  const loadTenantChanges: AccessChangesStoreService['loadTenantChanges'] = Effect.fn(
    'AccessChangesStore.loadTenantChanges',
  )(function* loadTenantChangesEffect(scope: OperationalScope) {
    return yield* runScoped<AccessChangesState>(scope, (transaction) => readTenantChanges(transaction, scope));
  });

  const publishCatalog: AccessChangesStoreService['publishCatalog'] = Effect.fn('AccessChangesStore.publishCatalog')(
    function* publishCatalogEffect({ snapshot }: PublishCatalogInput) {
      return yield* durable(database.executor.transaction((transaction) => publishRelease(transaction, snapshot)));
    },
  );

  const recordRole: AccessChangesStoreService['recordRole'] = Effect.fn('AccessChangesStore.recordRole')(
    function* recordRoleEffect(input: RecordRoleInput) {
      const { revision, role, scope } = input;
      // A role and the revision that first expresses it are one write of one person: the scoped
      // principal authored both, or this is somebody else's intent (R4-L8).
      const scopedIssue =
        tenantIssue(scope, [role.tenantId, revision.tenantId]) ??
        (role.createdBy === scope.principalId
          ? null
          : `role ${role.id} is created by ${role.createdBy}, not by the scoped person ${scope.principalId}`) ??
        (revision.createdBy === scope.principalId
          ? null
          : `revision ${revision.id} of role ${revision.roleId} is created by ${revision.createdBy}, not by the scoped person ${scope.principalId}`);
      if (scopedIssue !== null) {
        return yield* storeConflict('access_changes_scope_mismatch', scopedIssue);
      }
      if (revision.roleId !== role.id || revision.revision !== 1) {
        return yield* storeConflict(
          'access_changes_record_conflict',
          `role ${role.id} is created with its first revision, not revision ${revision.revision} of role ${revision.roleId}`,
        );
      }
      return yield* runScoped(scope, (transaction) => writeRole(transaction, { revision, role }));
    },
  );

  /**
   * The role editor's write: one successor revision over the revision it was planned against, through
   * the same transaction, validation and grant-incarnation move as an adoption, because it is the same
   * writer. The author is the scoped person, never a field of the request.
   */
  const recordRoleRevision: AccessChangesStoreService['recordRoleRevision'] = Effect.fn(
    'AccessChangesStore.recordRoleRevision',
  )(function* recordRoleRevisionEffect(input: RecordRoleRevisionInput) {
    const { catalogSnapshotId, decidedAt, edit, scope } = input;
    const write = {
      catalogSnapshotId,
      decidedAt,
      decidedBy: scope.principalId,
      edit,
      tenantId: scope.tenantId,
    };
    return yield* runScoped(scope, (transaction) =>
      recordRevision(
        transaction,
        withOptional(withOptional(write, 'expectedHolders', input.expectedHolders), 'grantorCover', input.grantorCover),
      ),
    );
  });

  const recordChangeItems: AccessChangesStoreService['recordChangeItems'] = Effect.fn(
    'AccessChangesStore.recordChangeItems',
  )(function* recordChangeItemsEffect({ plan, scope }: RecordChangeItemsInput) {
    const decidedItem = plan.items.find(({ status }) => status !== 'pending');
    const issue =
      tenantIssue(
        scope,
        plan.items.map(({ tenantId }) => tenantId),
      ) ??
      (decidedItem === undefined
        ? null
        : `item ${decidedItem.id} is recorded as ${decidedItem.status}; a release creates pending items only`);
    if (issue !== null) {
      return yield* storeConflict(
        decidedItem === undefined ? 'access_changes_scope_mismatch' : 'access_changes_item_not_pending',
        issue,
      );
    }
    return yield* runScoped(scope, (transaction) =>
      Effect.forEach(plan.items, (item) => writeChangeItem(transaction, item), { concurrency: 1, discard: true }),
    );
  });

  /** A decision batch is stored whole or not at all: the items, the revisions it pins and its decisions. */
  const writeDecisionBatch = (
    scope: OperationalScope,
    batch: DecisionBatch,
  ): Effect.Effect<void, AccessChangesStoreError> => {
    const issue = batchIssue(scope, batch);
    return issue === null
      ? runScoped(scope, (transaction) => writeDecisionBatchTransaction(transaction, scope, batch))
      : Effect.fail(storeConflict('access_changes_record_conflict', issue));
  };

  const recordAdoption: AccessChangesStoreService['recordAdoption'] = Effect.fn('AccessChangesStore.recordAdoption')(
    function* recordAdoptionEffect({ catalogSnapshotId, plan, scope }: RecordAdoptionInput) {
      return yield* writeDecisionBatch(
        scope,
        withOptional(
          withOptional(
            {
              catalogSnapshotId,
              decisions: plan.decisions,
              expected: 'adopt' as const,
              expectedStatus: 'adopted' as const,
              items: plan.items,
              roleEdits: plan.roleEdits,
            },
            'checkedHolders',
            plan.checkedHolders,
          ),
          'grantorCover',
          plan.grantorCover,
        ),
      );
    },
  );

  const recordDecline: AccessChangesStoreService['recordDecline'] = Effect.fn('AccessChangesStore.recordDecline')(
    function* recordDeclineEffect({ plan, scope }: RecordDeclineInput) {
      return yield* writeDecisionBatch(scope, {
        decisions: plan.decisions,
        expected: 'decline',
        expectedStatus: 'declined',
        items: plan.items,
        roleEdits: [],
      });
    },
  );

  const recordUndo: AccessChangesStoreService['recordUndo'] = Effect.fn('AccessChangesStore.recordUndo')(
    function* recordUndoEffect({ catalogSnapshotId, plan, scope }: RecordUndoInput) {
      return yield* writeDecisionBatch(
        scope,
        withOptional(
          withOptional(
            {
              catalogSnapshotId,
              decisions: plan.decisions,
              expected: 'undo' as const,
              expectedStatus: 'undone' as const,
              items: plan.items,
              roleEdits: plan.roleEdits,
            },
            'checkedHolders',
            plan.checkedHolders,
          ),
          'grantorCover',
          plan.grantorCover,
        ),
      );
    },
  );

  return Object.freeze({
    loadPublishedCatalog,
    loadTenantChanges,
    publishCatalog,
    recordAdoption,
    recordChangeItems,
    recordDecline,
    recordRole,
    recordRoleRevision,
    recordUndo,
  });
};

export const AccessChangesStoreLive = Layer.effect(
  AccessChangesStore,
  Effect.gen(function* accessChangesStoreLayer() {
    const database = yield* CoreDatabase;
    return makeAccessChangesDrizzleStore(database);
  }),
);
