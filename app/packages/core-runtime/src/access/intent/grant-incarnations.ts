import { and, asc, eq, inArray } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

import { accessGrantIncarnations, accessRoles } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import type { CapabilitySlot } from '../compiler/object-id.ts';
import { capabilitySlot } from '../compiler/object-id.ts';
import type { AccessScopeId, RoleId, RoleRevisionId, TenantId } from '../ids.ts';
import type { AccessMode, Cell } from '../model.ts';

/*
 * The one writer of the grant incarnations a decision reads as its witness (guarantee 9). A role's
 * cells are projected into a role binding, but a decision can only witness a cell through an
 * `access_grant_incarnations` row, so a revision that adds a cell without its incarnation grants
 * nothing and a revision that removes a cell without retiring the incarnation grants too much.
 *
 * Both writers of a role revision use this module: the tenant bootstrap (a new owner role and its
 * first assignment) and the Novinky store (adoption, undo and any other role edit). The identity is
 * revision-free (O51(2), O52): an unchanged cell keeps its incarnation across revisions, so a mandate
 * witness stays valid, while a removed or narrowed cell retires its incarnation and a later re-add is
 * a fresh incarnation no old approval can reach.
 */

/** One incarnation of one exact cell slot of a role in one scope (O52: the identity omits the revision). */
export const grantIncarnationId = (input: {
  readonly cell: Cell;
  readonly roleId: RoleId;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}): string =>
  stableUuid(
    [
      'ontos.access.bootstrap.grant',
      input.tenantId,
      input.scopeId,
      input.roleId,
      input.cell.capabilityKey,
      input.cell.mode,
      capabilitySlot(input.cell),
    ].join(':'),
  );

/** The incarnation a re-add of a previously retired cell slot gets, so the retired id is never reused. */
const restoredIncarnationId = (deterministicId: string, targetRevisionId: RoleRevisionId): string =>
  stableUuid([deterministicId, targetRevisionId].join(':'));

/** The cell key an incarnation is unique by: capability, mode and slot (O51(3), `access_grants_cell_uk`). */
interface GrantIncarnationCellIdentity {
  readonly capabilityKey: string;
  readonly mode: AccessMode;
  readonly slot: CapabilitySlot;
}

const cellSlotIdentity = (cell: GrantIncarnationCellIdentity): string =>
  [cell.capabilityKey, cell.mode, cell.slot].join('|');

/** The stored incarnation rows a move reads: enough to decide keep, retire and re-add. */
export interface GrantIncarnationRow {
  readonly capabilityKey: string;
  readonly grantIncarnationId: string;
  readonly mode: AccessMode;
  readonly slot: CapabilitySlot;
  readonly status: 'active' | 'retired';
}

/** One incarnation to insert, with its exact cell and denormalized identity. */
export interface GrantIncarnationWrite {
  readonly capabilityKey: string;
  readonly cell: Cell;
  readonly grantIncarnationId: string;
  readonly mode: AccessMode;
  readonly roleId: RoleId;
  readonly scopeId: AccessScopeId;
  readonly slot: CapabilitySlot;
  readonly tenantId: TenantId;
}

export interface GrantIncarnationMovePlanInput {
  readonly addedCells: readonly Cell[];
  /** Every incarnation of this role and scope, active or retired. */
  readonly existing: readonly GrantIncarnationRow[];
  readonly removedCells: readonly Cell[];
  readonly roleId: RoleId;
  readonly scopeId: AccessScopeId;
  readonly targetRevisionId: RoleRevisionId;
  readonly tenantId: TenantId;
}

export interface GrantIncarnationMovePlan {
  /** The ids of the live incarnations a removed or narrowed cell ends. */
  readonly retire: readonly string[];
  readonly write: readonly GrantIncarnationWrite[];
}

/**
 * The move one role edit makes to the incarnations of one scope: keep an unchanged cell, retire a
 * removed one, insert the missing ones. It is pure, so the exact keep/add/remove/restore behaviour is
 * unit-tested without a database.
 */
export const planGrantIncarnationMove = (input: GrantIncarnationMovePlanInput): GrantIncarnationMovePlan => {
  const activeByCell = new Map<string, string>();
  const knownIds = new Set<string>();
  for (const row of input.existing) {
    knownIds.add(row.grantIncarnationId);
    if (row.status === 'active') {
      activeByCell.set(cellSlotIdentity(row), row.grantIncarnationId);
    }
  }
  const retire: string[] = [];
  for (const cell of input.removedCells) {
    const identity = cellSlotIdentity({
      capabilityKey: cell.capabilityKey,
      mode: cell.mode,
      slot: capabilitySlot(cell),
    });
    const id = activeByCell.get(identity);
    if (id !== undefined) {
      retire.push(id);
      activeByCell.delete(identity);
    }
  }
  const write: GrantIncarnationWrite[] = [];
  for (const cell of input.addedCells) {
    const slot = capabilitySlot(cell);
    const identity = cellSlotIdentity({ capabilityKey: cell.capabilityKey, mode: cell.mode, slot });
    // An unchanged cell keeps its incarnation (O51(2)): the role edit re-points the revision, never the witness.
    if (activeByCell.has(identity)) {
      continue;
    }
    const deterministicId = grantIncarnationId({
      cell,
      roleId: input.roleId,
      scopeId: input.scopeId,
      tenantId: input.tenantId,
    });
    // A retired incarnation of the same slot is never revived (the database refuses it); a re-add is a
    // fresh id, so no approval that witnessed the old incarnation can reach the new cell.
    const grantIncarnationIdValue = knownIds.has(deterministicId)
      ? restoredIncarnationId(deterministicId, input.targetRevisionId)
      : deterministicId;
    knownIds.add(grantIncarnationIdValue);
    write.push({
      capabilityKey: cell.capabilityKey,
      cell,
      grantIncarnationId: grantIncarnationIdValue,
      mode: cell.mode,
      roleId: input.roleId,
      scopeId: input.scopeId,
      slot,
      tenantId: input.tenantId,
    });
  }
  return { retire, write };
};

/** The failure channel a move produces: the driver's failures, which each caller names in its own taxonomy. */
export type GrantIncarnationStoreFailure = EffectDrizzleQueryError | SqlError;

/**
 * The rows a move reads and writes, and nothing else of the transaction: a writer that holds only an owner
 * Action's scoped transaction (a portal grant, O75) moves incarnations exactly as a role edit does.
 */
export type GrantIncarnationTransaction = Pick<CoreTransaction, 'insert' | 'select' | 'update'>;

export interface WriteGrantIncarnationsInput {
  readonly addedCells: readonly Cell[];
  readonly removedCells: readonly Cell[];
  readonly roleId: RoleId;
  readonly scopeIds: readonly AccessScopeId[];
  readonly targetRevisionId: RoleRevisionId;
  readonly tenantId: TenantId;
}

const readExisting = (
  transaction: GrantIncarnationTransaction,
  input: { readonly roleId: RoleId; readonly scopeId: AccessScopeId; readonly tenantId: TenantId },
) =>
  transaction
    .select({
      capabilityKey: accessGrantIncarnations.capabilityKey,
      grantIncarnationId: accessGrantIncarnations.grantIncarnationId,
      mode: accessGrantIncarnations.mode,
      slot: accessGrantIncarnations.slot,
      status: accessGrantIncarnations.status,
    })
    .from(accessGrantIncarnations)
    .where(
      and(
        eq(accessGrantIncarnations.tenantId, input.tenantId),
        eq(accessGrantIncarnations.scopeId, input.scopeId),
        eq(accessGrantIncarnations.roleId, input.roleId),
      ),
    );

const applyPlan = Effect.fn('GrantIncarnations.applyPlan')(function* applyGrantIncarnationPlan(
  transaction: GrantIncarnationTransaction,
  input: { readonly roleId: RoleId; readonly scopeId: AccessScopeId; readonly tenantId: TenantId },
  plan: GrantIncarnationMovePlan,
) {
  if (plan.retire.length > 0) {
    yield* transaction
      .update(accessGrantIncarnations)
      .set({ status: 'retired' })
      .where(
        and(
          eq(accessGrantIncarnations.tenantId, input.tenantId),
          eq(accessGrantIncarnations.scopeId, input.scopeId),
          eq(accessGrantIncarnations.roleId, input.roleId),
          eq(accessGrantIncarnations.status, 'active'),
          inArray(accessGrantIncarnations.grantIncarnationId, [...plan.retire]),
        ),
      );
  }
  if (plan.write.length > 0) {
    yield* transaction
      .insert(accessGrantIncarnations)
      .values(plan.write.map(({ cell, ...row }) => ({ ...row, cellJson: cell, status: 'active' as const })))
      .onConflictDoNothing();
  }
  return yield* Effect.void;
});

/**
 * Moves every incarnation of one role edit, in each scope the role is bound. Both role-revision
 * writers call this: the bootstrap passes the first revision's cells as additions, the Novinky store
 * passes the edit's own added and removed cells.
 */
export const writeGrantIncarnations = (
  transaction: GrantIncarnationTransaction,
  input: WriteGrantIncarnationsInput,
): Effect.Effect<void, GrantIncarnationStoreFailure> =>
  Effect.forEach(
    input.scopeIds,
    (scopeId) =>
      Effect.flatMap(
        readExisting(transaction, { roleId: input.roleId, scopeId, tenantId: input.tenantId }),
        (existing) =>
          applyPlan(
            transaction,
            { roleId: input.roleId, scopeId, tenantId: input.tenantId },
            planGrantIncarnationMove({
              addedCells: input.addedCells,
              existing,
              removedCells: input.removedCells,
              roleId: input.roleId,
              scopeId,
              targetRevisionId: input.targetRevisionId,
              tenantId: input.tenantId,
            }),
          ),
      ),
    { concurrency: 1, discard: true },
  );

/**
 * The role rows every writer of a role's holders locks before it reads the role's head, in role id order
 * and before any other row of its transaction. An assignment shares the lock, so holders of one role are
 * added side by side; a revision takes it exclusively (`no key update`, so a foreign key check on the role
 * still passes) and so never commits a successor between an assignment's head check and its insert.
 * Without it the new holder stays pinned to the revision every other holder was just moved off (D23), and
 * no projection of the tenant can resolve the role again.
 */
export const lockRoles = (
  transaction: Pick<CoreTransaction, 'select'>,
  input: {
    readonly mode: 'no key update' | 'share';
    readonly roleIds: readonly string[];
    readonly tenantId: string;
  },
): Effect.Effect<void, GrantIncarnationStoreFailure> =>
  input.roleIds.length === 0
    ? Effect.void
    : transaction
        .select({ roleId: accessRoles.roleId })
        .from(accessRoles)
        .where(and(eq(accessRoles.tenantId, input.tenantId), inArray(accessRoles.roleId, [...new Set(input.roleIds)])))
        .orderBy(asc(accessRoles.roleId))
        .for(input.mode)
        .pipe(Effect.asVoid);
