import { expect, it } from 'effect-rstest';

import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import { previewAdoption } from '../../src/access/changes/preview.ts';
import type { AdoptionPreview } from '../../src/access/changes/preview.ts';
import type { RoleWithRevision } from '../../src/access/changes/role-edits.ts';
import type { CellRevocation, UndoRequest, UndoSelection } from '../../src/access/changes/undo.ts';
import { laterRevocationsOf, planUndo } from '../../src/access/changes/undo.ts';
import type { AccessChangeItemId } from '../../src/access/ids.ts';
import type { Assignment, CatalogSnapshotEntry, Cell, Holder, RoleRevision } from '../../src/access/model.ts';
import { CellSchema, cellSlotKey } from '../../src/access/model.ts';
import {
  agentHolder,
  assignment,
  BATCH,
  cell,
  changeItem,
  decision,
  decodeWith,
  delegatedBasis,
  delegation,
  entry,
  failureOf,
  fixedId,
  grantorHolding,
  instant,
  LEGAL_ENTITY,
  legalEntityScopeRecord,
  MANAGER,
  ownerBasis,
  PERSON,
  principalHolder,
  ROLE,
  role,
  ROLE_ID,
  roleRevision,
  succeeded,
  TENANT,
  tenantMembership,
} from './access-changes-fixtures.ts';

const X = 'test.party.add-note';
const Y = 'test.party.note-two';
const Z = 'test.party.archive';

const xCell = cell(X);
const yCell = cell(Y);
/** Y with an amount ceiling, so two of them are one slot with different content. */
const ceiling = (limitMinor: number): Cell =>
  decodeWith('ceiling cell', CellSchema, { ...yCell, amountCeiling: { currency: 'CZK', limitMinor } });

const firstRevision = roleRevision({ cells: [xCell], id: fixedId(40), revision: 1 });
const adoptedRevision = roleRevision({ cells: [xCell, yCell], id: fixedId(41), revision: 2 });
const editedRevision = roleRevision({ cells: [xCell, yCell, cell(Z)], id: fixedId(42), revision: 3 });
/** The adoption that stripped X from the role. */
const strippedRevision = roleRevision({ cells: [], id: fixedId(44), revision: 2 });

const addedItem = changeItem({ capabilityKey: Y, id: fixedId(70), status: 'adopted' });
const addedAdoption = decision({ id: fixedId(80), itemId: addedItem.id, roleRevisionIds: [fixedId(41)] });

const removedItem = changeItem({ capabilityKey: X, id: fixedId(71), kind: 'removed', status: 'adopted' });
const removedAdoption = decision({ id: fixedId(81), itemId: removedItem.id, roleRevisionIds: [fixedId(44)] });

const roleAt = (revision: RoleRevision): readonly RoleWithRevision[] => [{ revision, role: role() }];

const freshPreview = (assignments: readonly Assignment[], itemId: AccessChangeItemId): AdoptionPreview =>
  previewAdoption({ assignments, at: instant(3), items: [{ itemId, roleIds: [ROLE_ID] }] });

interface UndoInput {
  readonly actor?: Holder;
  readonly assignments?: readonly Assignment[];
  readonly authority?: AccessConfigureBasis;
  readonly entries?: readonly CatalogSnapshotEntry[];
  readonly newRevisionIds?: ReadonlyMap<string, string>;
  readonly preview?: AdoptionPreview;
  readonly revisions: readonly RoleRevision[];
  readonly revocations?: readonly CellRevocation[];
  readonly roles: readonly RoleWithRevision[];
  readonly selections: readonly UndoSelection[];
}

const undoRequest = (input: UndoInput): UndoRequest => {
  const assignments = input.assignments ?? [];
  const entries = input.entries ?? [entry({ key: X }), entry({ key: Y })];
  const grantor = grantorHolding(entries.map(({ key }) => key));
  return {
    actor: input.actor ?? principalHolder(),
    assignments: [...assignments, grantor.assignment],
    authority: input.authority ?? ownerBasis(),
    batchId: BATCH,
    decidedAt: instant(6),
    decisionIds: new Map(input.selections.map(({ item }, index) => [item.id, fixedId(85 + index)] as const)),
    entries,
    membership: tenantMembership(),
    newRevisionIds: input.newRevisionIds ?? new Map([[ROLE, fixedId(43)]]),
    preview: input.preview ?? freshPreview(assignments, input.selections.at(0)?.item.id ?? addedItem.id),
    revisions: input.revisions,
    revocations: input.revocations ?? [],
    roles: [...input.roles, grantor.role],
    selections: input.selections,
    tenantId: TENANT,
  };
};

it('undoes an adoption by removing exactly the cells it added', () => {
  const plan = succeeded(
    planUndo(
      undoRequest({
        revisions: [firstRevision, adoptedRevision],
        roles: roleAt(adoptedRevision),
        selections: [{ adoption: addedAdoption, item: addedItem }],
      }),
    ),
  );
  expect(plan.roleEdits[0]?.removedCells).toEqual([yCell]);
  expect(plan.roleEdits[0]?.addedCells).toEqual([]);
  expect(plan.roleEdits[0]?.cells).toEqual([xCell]);
  expect(plan.items.map(({ status }) => status)).toEqual(['undone']);
  expect(plan.decisions[0]?.undoesDecisionId).toBe(addedAdoption.id);
  expect(plan.skipped).toEqual([]);
});

it('restores the ceiling an adoption replaced in place', () => {
  const lower = roleRevision({ cells: [xCell, ceiling(1000)], id: fixedId(40), revision: 1 });
  const raised = roleRevision({ cells: [xCell, ceiling(5000)], id: fixedId(41), revision: 2 });
  const plan = succeeded(
    planUndo(
      undoRequest({
        revisions: [lower, raised],
        roles: roleAt(raised),
        selections: [{ adoption: addedAdoption, item: addedItem }],
      }),
    ),
  );
  expect(plan.roleEdits[0]?.removedCells).toEqual([ceiling(5000)]);
  expect(plan.roleEdits[0]?.addedCells).toEqual([ceiling(1000)]);
  expect(plan.roleEdits[0]?.cells).toEqual([xCell, ceiling(1000)]);
  expect(plan.items.map(({ status }) => status)).toEqual(['undone']);
});

it('keeps a later edit that the adoption never made', () => {
  const plan = succeeded(
    planUndo(
      undoRequest({
        revisions: [firstRevision, adoptedRevision, editedRevision],
        roles: roleAt(editedRevision),
        selections: [{ adoption: addedAdoption, item: addedItem }],
      }),
    ),
  );
  expect(plan.roleEdits[0]?.removedCells).toEqual([yCell]);
  expect(plan.roleEdits[0]?.cells).toEqual([xCell, cell(Z)]);
});

it('never restores a capability the catalog no longer publishes', () => {
  const plan = succeeded(
    planUndo(
      undoRequest({
        entries: [entry({ key: Y })],
        revisions: [firstRevision, strippedRevision],
        roles: roleAt(strippedRevision),
        selections: [{ adoption: removedAdoption, item: removedItem }],
      }),
    ),
  );
  expect(plan.roleEdits).toEqual([]);
  expect(plan.skipped.map(({ capabilityKey, reason }) => `${capabilityKey} ${reason}`)).toEqual([
    `${X} capability_not_published`,
  ]);
});

it('restores a stripped capability once the catalog publishes it again', () => {
  const plan = succeeded(
    planUndo(
      undoRequest({
        entries: [entry({ key: X })],
        preview: freshPreview([], removedItem.id),
        revisions: [firstRevision, strippedRevision],
        roles: roleAt(strippedRevision),
        selections: [{ adoption: removedAdoption, item: removedItem }],
      }),
    ),
  );
  expect(plan.roleEdits[0]?.addedCells).toEqual([xCell]);
  expect(plan.roleEdits[0]?.cells).toEqual([xCell]);
  expect(plan.skipped).toEqual([]);
});

it('never restores a cell revoked after the adoption', () => {
  const plan = succeeded(
    planUndo(
      undoRequest({
        entries: [entry({ key: X })],
        preview: freshPreview([], removedItem.id),
        revisions: [firstRevision, strippedRevision],
        revocations: [{ revokedAt: instant(5), roleId: ROLE_ID, slot: cellSlotKey(xCell) }],
        roles: roleAt(strippedRevision),
        selections: [{ adoption: removedAdoption, item: removedItem }],
      }),
    ),
  );
  expect(plan.roleEdits).toEqual([]);
  expect(plan.skipped.map(({ reason }) => reason)).toEqual(['cell_revoked_later']);
});

it('never resurrects a ceiling an adoption replaced once a person removed the replacement', () => {
  const lower = roleRevision({ cells: [xCell, ceiling(1000)], id: fixedId(40), revision: 1 });
  const raised = roleRevision({ cells: [xCell, ceiling(5000)], createdAt: instant(3), id: fixedId(41), revision: 2 });
  const revoked = roleRevision({ cells: [xCell], createdAt: instant(4), id: fixedId(42), revision: 3 });
  const revisions = [lower, raised, revoked];
  const selections = [{ adoption: addedAdoption, item: addedItem }];
  const revocations = laterRevocationsOf(revisions, selections);
  expect(revocations).toEqual([{ revokedAt: instant(4), roleId: ROLE_ID, slot: cellSlotKey(yCell) }]);
  const plan = succeeded(planUndo(undoRequest({ revisions, revocations, roles: roleAt(revoked), selections })));
  expect(plan.roleEdits).toEqual([]);
  expect(plan.skipped.map(({ reason }) => reason)).toEqual(['already_removed', 'cell_revoked_later']);
});

it('still restores a replaced ceiling when the history removed nothing after the adoption', () => {
  const lower = roleRevision({ cells: [xCell, ceiling(1000)], id: fixedId(40), revision: 1 });
  const raised = roleRevision({ cells: [xCell, ceiling(5000)], createdAt: instant(3), id: fixedId(41), revision: 2 });
  const edited = roleRevision({
    cells: [xCell, ceiling(5000), cell(Z)],
    createdAt: instant(4),
    id: fixedId(42),
    revision: 3,
  });
  const revisions = [lower, raised, edited];
  const selections = [{ adoption: addedAdoption, item: addedItem }];
  const revocations = laterRevocationsOf(revisions, selections);
  expect(revocations).toEqual([]);
  const plan = succeeded(planUndo(undoRequest({ revisions, revocations, roles: roleAt(edited), selections })));
  expect(plan.roleEdits[0]?.cells).toEqual([xCell, cell(Z), ceiling(1000)]);
  expect(plan.skipped).toEqual([]);
});

it('refuses to undo a decision that was not an adoption of that item', () => {
  const declined = decision({ decision: 'decline', id: fixedId(82), itemId: addedItem.id });
  expect(
    failureOf(
      planUndo(
        undoRequest({
          revisions: [firstRevision, adoptedRevision],
          roles: roleAt(adoptedRevision),
          selections: [{ adoption: declined, item: addedItem }],
        }),
      ),
    ).code,
  ).toBe('access_changes_adoption_not_undoable');
});

it('refuses to undo an item that is not adopted and an agent that tries it', () => {
  const pending = changeItem({ capabilityKey: Y, id: fixedId(72) });
  expect(
    failureOf(
      planUndo(
        undoRequest({
          revisions: [firstRevision, adoptedRevision],
          roles: roleAt(adoptedRevision),
          selections: [{ adoption: addedAdoption, item: pending }],
        }),
      ),
    ).code,
  ).toBe('access_changes_item_unavailable');
  expect(
    failureOf(
      planUndo(
        undoRequest({
          actor: agentHolder(),
          revisions: [firstRevision, adoptedRevision],
          roles: roleAt(adoptedRevision),
          selections: [{ adoption: addedAdoption, item: addedItem }],
        }),
      ),
    ).code,
  ).toBe('access_changes_agent_cannot_decide');
});

it('refuses an adoption whose predecessor revision is missing from the history', () => {
  expect(
    failureOf(
      planUndo(
        undoRequest({
          revisions: [adoptedRevision],
          roles: roleAt(adoptedRevision),
          selections: [{ adoption: addedAdoption, item: addedItem }],
        }),
      ),
    ).code,
  ).toBe('access_changes_undo_conflict');
});

it('checks the preview only when the undo widens access', () => {
  const narrowOnly = previewAdoption({
    assignments: [],
    at: instant(3),
    items: [{ itemId: addedItem.id, roleIds: [] }],
  });
  expect(
    succeeded(
      planUndo(
        undoRequest({
          assignments: [assignment({ incarnationId: fixedId(50) })],
          preview: narrowOnly,
          revisions: [firstRevision, adoptedRevision],
          roles: roleAt(adoptedRevision),
          selections: [{ adoption: addedAdoption, item: addedItem }],
        }),
      ),
    ).items[0]?.status,
  ).toBe('undone');
  expect(
    failureOf(
      planUndo(
        undoRequest({
          assignments: [assignment({ holder: principalHolder(PERSON), incarnationId: fixedId(50) })],
          entries: [entry({ key: X })],
          preview: previewAdoption({
            assignments: [],
            at: instant(3),
            items: [{ itemId: removedItem.id, roleIds: [] }],
          }),
          revisions: [firstRevision, strippedRevision],
          roles: roleAt(strippedRevision),
          selections: [{ adoption: removedAdoption, item: removedItem }],
        }),
      ),
    ).code,
  ).toBe('access_changes_preview_stale');
});

it('undoes only the cells of the item it undoes, never another item of the same batch', () => {
  // One batch wrote one revision carrying both items; undoing X must leave B's cell alone.
  const emptyFirstRevision = roleRevision({ cells: [], id: fixedId(45), revision: 1 });
  const batchRevision = roleRevision({ cells: [xCell, yCell], id: fixedId(41), revision: 2 });
  const xItem = changeItem({ capabilityKey: X, id: fixedId(73), status: 'adopted' });
  const plan = succeeded(
    planUndo(
      undoRequest({
        revisions: [emptyFirstRevision, batchRevision],
        roles: roleAt(batchRevision),
        selections: [
          { adoption: decision({ id: fixedId(83), itemId: xItem.id, roleRevisionIds: [fixedId(41)] }), item: xItem },
        ],
      }),
    ),
  );
  expect(plan.roleEdits[0]?.removedCells).toEqual([xCell]);
  expect(plan.roleEdits[0]?.cells).toEqual([yCell]);
});

it('bounds a delegated undo to the delegation scope', () => {
  const envelope = delegation({ capabilityKeys: [X], people: [PERSON], roleIds: [ROLE] });
  const restore = (roles: readonly RoleWithRevision[]) =>
    planUndo(
      undoRequest({
        actor: principalHolder(MANAGER),
        authority: delegatedBasis(envelope, legalEntityScopeRecord({ legalEntityId: LEGAL_ENTITY })),
        entries: [entry({ key: X })],
        revisions: [firstRevision, strippedRevision],
        roles,
        selections: [{ adoption: removedAdoption, item: removedItem }],
      }),
    );
  // A restored cell in a tenant-wide role is outside a legal-entity delegation.
  expect(failureOf(restore(roleAt(strippedRevision))).code).toBe('access_changes_delegation_out_of_envelope');
  // The same restore inside the delegation's own legal entity is allowed.
  expect(
    succeeded(restore([{ revision: strippedRevision, role: role({ legalEntityId: LEGAL_ENTITY }) }])).roleEdits[0]
      ?.addedCells,
  ).toEqual([xCell]);
});
