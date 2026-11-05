import { expect, it } from 'effect-rstest';

import { diffCatalogSnapshots } from '../../src/access/changes/catalog-diff.ts';
import { blueprintChangeItems, changeItemIdentityKey, planChangeItems } from '../../src/access/changes/items.ts';
import type { ChangeItemBlueprint } from '../../src/access/changes/items.ts';
import {
  CATALOG,
  OTHER_ROLE,
  ROLE,
  TENANT,
  agentHolder,
  assignment,
  cell,
  entry,
  failureOf,
  fixedId,
  instant,
  roleState,
  snapshot,
  succeeded,
} from './access-changes-fixtures.ts';

const MANAGER_ROLE = fixedId(22);

const entries = [
  entry({ group: 'parties', key: 'test.party.existing', level: 'basic' }),
  entry({ group: 'parties', key: 'test.party.manager', level: 'manage' }),
  entry({ group: 'finance', key: 'test.finance.existing', level: 'manage' }),
  entry({ group: 'parties', key: 'test.party.add-note', level: 'basic' }),
  entry({ group: 'parties', key: 'test.party.archive', level: 'manage' }),
];

const previous = snapshot(entries.slice(0, 3), 1);
const current = snapshot(entries, 2);

const roles = [
  roleState({ cells: [cell('test.party.existing')], revisionId: fixedId(40), roleId: ROLE }),
  roleState({ cells: [cell('test.finance.existing')], revisionId: fixedId(41), roleId: OTHER_ROLE }),
  roleState({ cells: [cell('test.party.manager')], revisionId: fixedId(42), roleId: MANAGER_ROLE }),
];

const drafts = succeeded(diffCatalogSnapshots(previous, current));

it('suggests the roles that already follow the editor row at an equal or broader level', () => {
  const blueprints = succeeded(blueprintChangeItems({ drafts, entries, roles }));
  expect(blueprints.map(({ capabilityKey, kind }) => `${capabilityKey} ${kind}`)).toEqual([
    'test.party.add-note new',
    'test.party.archive new',
  ]);
  // Same group at least the item's level: basic and manage, never the finance row.
  expect(succeeded(blueprintChangeItems({ drafts: drafts.slice(0, 1), entries, roles }))[0]?.suggestedRoleIds).toEqual([
    ROLE,
    MANAGER_ROLE,
  ]);
  // A manage-level capability is not suggested for a role that only reaches basic.
  expect(succeeded(blueprintChangeItems({ drafts: drafts.slice(1), entries, roles }))[0]?.suggestedRoleIds).toEqual([
    MANAGER_ROLE,
  ]);
});

it('suggests the holders of the predecessor for a rename and of a removed capability', () => {
  const renameCurrent = snapshot(
    [entry({ key: 'test.party.new-name', lineage: { renamedFrom: ['test.party.old-name'] } })],
    3,
  );
  const renamed = succeeded(
    blueprintChangeItems({
      drafts: succeeded(diffCatalogSnapshots(snapshot([entry({ key: 'test.party.old-name' })], 4), renameCurrent)),
      entries: renameCurrent.entries,
      roles: [roleState({ cells: [cell('test.party.old-name')] })],
    }),
  );
  expect(renamed[0]?.lineageFrom).toEqual(['test.party.old-name']);
  expect(renamed[0]?.suggestedRoleIds).toEqual([ROLE]);

  const removed = succeeded(
    blueprintChangeItems({
      drafts: succeeded(diffCatalogSnapshots(snapshot([entry({ key: 'test.party.gone' })], 5), snapshot([], 6))),
      entries: [],
      roles: [roleState({ cells: [cell('test.party.gone')], revisionId: fixedId(41) })],
    }),
  );
  expect(removed[0]?.kind).toBe('removed');
  expect(removed[0]?.suggestedRoleIds).toEqual([ROLE]);
});

const itemIds = (blueprints: readonly ChangeItemBlueprint[]): ReadonlyMap<string, string> =>
  new Map(
    blueprints.map(({ capabilityKey, kind }, index) => [
      changeItemIdentityKey(kind, capabilityKey),
      fixedId(70 + index),
    ]),
  );

it('materials a pending item per change with the affected-holder preview', () => {
  const blueprints = succeeded(blueprintChangeItems({ drafts, entries, roles }));
  const plan = succeeded(
    planChangeItems({
      assignments: [
        assignment({ incarnationId: fixedId(50), roleId: ROLE }),
        assignment({ holder: agentHolder(), incarnationId: fixedId(51), roleId: ROLE }),
        assignment({ incarnationId: fixedId(52), roleId: ROLE, status: 'revoked' }),
        assignment({ incarnationId: fixedId(53), roleId: ROLE, validUntil: instant(2) }),
        assignment({ incarnationId: fixedId(54), roleId: OTHER_ROLE }),
      ],
      blueprints,
      catalogSnapshotId: CATALOG,
      createdAt: instant(3),
      itemIds: itemIds(blueprints),
      tenantId: TENANT,
    }),
  );
  expect(plan.items.map(({ status }) => status)).toEqual(['pending', 'pending']);
  expect(plan.items.map(({ tenantId }) => tenantId)).toEqual([TENANT, TENANT]);
  // A revoked and an expired assignment are not holders, so one person and one agent remain for
  // the first item; the finance role is not suggested, so its holder is not affected.
  expect(plan.preview.humanCount).toBe(1);
  expect(plan.preview.agentCount).toBe(1);
  expect(plan.preview.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
});

it('changes the preview fingerprint when the affected assignments change', () => {
  const blueprints = succeeded(blueprintChangeItems({ drafts, entries, roles }));
  const withPerson = succeeded(
    planChangeItems({
      assignments: [assignment({ incarnationId: fixedId(50), roleId: ROLE })],
      blueprints,
      catalogSnapshotId: CATALOG,
      createdAt: instant(3),
      itemIds: itemIds(blueprints),
      tenantId: TENANT,
    }),
  );
  const withAgent = succeeded(
    planChangeItems({
      assignments: [assignment({ holder: agentHolder(), incarnationId: fixedId(51), roleId: ROLE })],
      blueprints,
      catalogSnapshotId: CATALOG,
      createdAt: instant(3),
      itemIds: itemIds(blueprints),
      tenantId: TENANT,
    }),
  );
  expect(withAgent.preview.fingerprint).not.toBe(withPerson.preview.fingerprint);
});

it('refuses an item it cannot identify', () => {
  const blueprints = succeeded(blueprintChangeItems({ drafts, entries, roles }));
  expect(
    failureOf(
      planChangeItems({
        assignments: [],
        blueprints,
        catalogSnapshotId: CATALOG,
        createdAt: instant(3),
        itemIds: new Map(),
        tenantId: TENANT,
      }),
    ).code,
  ).toBe('access_changes_identity_missing');
});

it('refuses a blueprint whose lineage contradicts its kind', () => {
  const renamedWithoutLineage: ChangeItemBlueprint = {
    capabilityKey: entry({ key: 'test.party.add-note' }).key,
    kind: 'renamed',
    lineageFrom: [],
    risk: 'routine',
    suggestedRoleIds: [],
  };
  const plan = planChangeItems({
    assignments: [],
    blueprints: [renamedWithoutLineage],
    catalogSnapshotId: CATALOG,
    createdAt: instant(3),
    itemIds: new Map([[changeItemIdentityKey('renamed', 'test.party.add-note'), fixedId(70)]]),
    tenantId: TENANT,
  });
  expect(failureOf(plan).code).toBe('access_changes_item_invalid');
});

it('produces no Novinky item for a declaration the module has not published', () => {
  // The unpublished descriptor never reaches the snapshot the diff compares (O1), so the release
  // lists only the capability it actually published.
  const publishedOnly = current.entries.filter(({ key }) => key !== 'test.party.add-note');
  const draftsWithoutIt = succeeded(diffCatalogSnapshots(previous, snapshot(publishedOnly, 7)));
  expect(draftsWithoutIt.map(({ capabilityKey }) => capabilityKey)).toEqual(['test.party.archive']);
});

it('suggests the predecessor holders for a rename reported as a risk change', () => {
  // The rename raises the risk, so it is listed as a risk change with no lineage of its own; the
  // roles that must decide on it are still the ones holding the predecessor.
  const renameCurrent = snapshot(
    [
      entry({
        key: 'test.party.new-name',
        lineage: { renamedFrom: ['test.party.old-name'] },
        risk: 'sensitive',
      }),
    ],
    8,
  );
  const blueprints = succeeded(
    blueprintChangeItems({
      drafts: succeeded(diffCatalogSnapshots(snapshot([entry({ key: 'test.party.old-name' })], 9), renameCurrent)),
      entries: renameCurrent.entries,
      roles: [roleState({ cells: [cell('test.party.old-name')] })],
    }),
  );
  expect(blueprints[0]?.kind).toBe('risk_changed');
  expect(blueprints[0]?.risk).toBe('sensitive');
  expect(blueprints[0]?.suggestedRoleIds).toEqual([ROLE]);
});
