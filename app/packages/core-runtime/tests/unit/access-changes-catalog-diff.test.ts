import { expect, it } from 'effect-rstest';

import { diffCatalogSnapshots } from '../../src/access/changes/catalog-diff.ts';
import { entry, failureOf, snapshot, succeeded } from './access-changes-fixtures.ts';

const previous = snapshot(
  [
    entry({ key: 'test.party.keep' }),
    entry({ key: 'test.party.old-name' }),
    entry({ key: 'test.party.split-source' }),
    entry({ key: 'test.party.gone' }),
    entry({ key: 'test.party.risk', risk: 'routine' }),
    entry({ key: 'test.party.stable' }),
  ],
  1,
);

const current = snapshot(
  [
    entry({ key: 'test.party.keep' }),
    entry({ key: 'test.party.new-name', lineage: { renamedFrom: ['test.party.old-name'] } }),
    entry({ key: 'test.party.half-left', lineage: { splitFrom: 'test.party.split-source' } }),
    entry({ key: 'test.party.half-right', lineage: { splitFrom: 'test.party.split-source' } }),
    entry({ key: 'test.party.risk', risk: 'sensitive' }),
    entry({ key: 'test.party.stable' }),
    entry({ key: 'test.party.brand-new' }),
  ],
  2,
);

it('classifies one release as new, renamed, split, removed and risk-changed', () => {
  const drafts = succeeded(diffCatalogSnapshots(previous, current));
  expect(drafts.map(({ capabilityKey, kind }) => `${capabilityKey} ${kind}`)).toEqual([
    'test.party.brand-new new',
    'test.party.gone removed',
    'test.party.half-left split',
    'test.party.half-right split',
    'test.party.new-name renamed',
    'test.party.risk risk_changed',
  ]);
});

it('keeps unchanged capabilities out of Novinky and records the previous risk', () => {
  const drafts = succeeded(diffCatalogSnapshots(previous, current));
  expect(drafts.some(({ capabilityKey }) => capabilityKey === 'test.party.keep')).toBe(false);
  const riskChanged = drafts.find(({ kind }) => kind === 'risk_changed');
  expect(riskChanged?.previousRisk).toBe('routine');
  expect(riskChanged?.entry.risk).toBe('sensitive');
  const brandNew = drafts.find(({ kind }) => kind === 'new');
  expect(brandNew?.lineageFrom).toEqual([]);
  expect(brandNew?.previousRisk).toBeNull();
});

it('names the predecessor of a rename and the parent of a split', () => {
  const drafts = succeeded(diffCatalogSnapshots(previous, current));
  expect(drafts.find(({ kind }) => kind === 'renamed')?.lineageFrom).toEqual(['test.party.old-name']);
  const splits = drafts.filter(({ kind }) => kind === 'split');
  expect(splits.map(({ lineageFrom }) => lineageFrom.join(','))).toEqual([
    'test.party.split-source',
    'test.party.split-source',
  ]);
});

it('reports nothing when a release republishes the identical catalog', () => {
  expect(succeeded(diffCatalogSnapshots(current, current))).toEqual([]);
});

it('treats a lineage parent outside the compared window as a new capability', () => {
  const narrower = snapshot([entry({ key: 'test.party.earlier' })], 3);
  const wider = snapshot([entry({ key: 'test.party.later', lineage: { renamedFrom: ['test.party.earlier'] } })], 4);
  const drafts = succeeded(diffCatalogSnapshots(snapshot([], 5), wider));
  expect(drafts.map(({ kind }) => kind)).toEqual(['new']);
  // The same release compared from the release that declared the predecessor is a rename.
  expect(succeeded(diffCatalogSnapshots(narrower, wider)).map(({ kind }) => kind)).toEqual(['renamed']);
});

it('refuses a rename whose predecessor is still declared', () => {
  const conflicting = snapshot(
    [
      entry({ key: 'test.party.old-name' }),
      entry({ key: 'test.party.new-name', lineage: { renamedFrom: ['test.party.old-name'] } }),
    ],
    6,
  );
  expect(failureOf(diffCatalogSnapshots(snapshot([entry({ key: 'test.party.old-name' })], 7), conflicting)).code).toBe(
    'access_changes_lineage_conflict',
  );
});

it('refuses a rename that reaches two successors and a predecessor that is renamed and split', () => {
  const twoSuccessors = snapshot(
    [
      entry({ key: 'test.party.first', lineage: { renamedFrom: ['test.party.old-name'] } }),
      entry({ key: 'test.party.second', lineage: { renamedFrom: ['test.party.old-name'] } }),
    ],
    8,
  );
  expect(
    failureOf(diffCatalogSnapshots(snapshot([entry({ key: 'test.party.old-name' })], 9), twoSuccessors)).code,
  ).toBe('access_changes_lineage_conflict');
  const renamedAndSplit = snapshot(
    [
      entry({ key: 'test.party.renamed', lineage: { renamedFrom: ['test.party.old-name'] } }),
      entry({ key: 'test.party.half', lineage: { splitFrom: 'test.party.old-name' } }),
    ],
    10,
  );
  expect(
    failureOf(diffCatalogSnapshots(snapshot([entry({ key: 'test.party.old-name' })], 11), renamedAndSplit)).code,
  ).toBe('access_changes_lineage_conflict');
});

it('records the risk a like-for-like rename carried over instead of a first appearance', () => {
  const before = snapshot([entry({ key: 'test.party.old' })], 20);
  const after = snapshot([entry({ key: 'test.party.new', lineage: { renamedFrom: ['test.party.old'] } })], 21);
  const [draft] = succeeded(diffCatalogSnapshots(before, after));
  expect(draft?.kind).toBe('renamed');
  expect(draft?.previousRisk).toBe('routine');
  expect(draft?.carriesCells).toBe(true);
});

it('never carries cells across a rename that raises the risk, and says what changed', () => {
  const before = snapshot([entry({ key: 'test.party.old' })], 22);
  const after = snapshot(
    [
      entry({
        key: 'test.party.new',
        lineage: { renamedFrom: ['test.party.old'] },
        modes: ['run', 'propose', 'approve'],
        risk: 'critical',
      }),
    ],
    23,
  );
  const [draft] = succeeded(diffCatalogSnapshots(before, after));
  // A rename that escalates is not a rename that keeps access: it is a change of its own.
  expect(draft?.kind).toBe('risk_changed');
  expect(draft?.carriesCells).toBe(false);
  expect(draft?.previousRisk).toBe('routine');
  expect(draft?.entry.risk).toBe('critical');
  // The catalog keeps the continuity evidence even though the item names no lineage.
  expect(draft?.entry.lineage?.renamedFrom).toEqual(['test.party.old']);
});

it('never carries cells across a rename that widens the surface and keeps a narrowed one', () => {
  // The predecessor reached assigned records only; the successor may reach every record.
  const [wide] = succeeded(
    diffCatalogSnapshots(
      snapshot([entry({ key: 'test.party.old', selectors: ['assigned'] })], 24),
      snapshot(
        [entry({ key: 'test.party.new', lineage: { renamedFrom: ['test.party.old'] }, selectors: ['all'] })],
        25,
      ),
    ),
  );
  expect(wide?.kind).toBe('risk_changed');
  expect(wide?.carriesCells).toBe(false);
  expect(wide?.previousRisk).toBe('routine');

  const [widerModes] = succeeded(
    diffCatalogSnapshots(
      snapshot([entry({ key: 'test.party.old' })], 26),
      snapshot(
        [entry({ key: 'test.party.new', lineage: { renamedFrom: ['test.party.old'] }, modes: ['run', 'propose'] })],
        27,
      ),
    ),
  );
  expect(widerModes?.carriesCells).toBe(false);

  const [narrower] = succeeded(
    diffCatalogSnapshots(
      snapshot([entry({ key: 'test.party.old', selectors: ['all', 'assigned'] })], 28),
      snapshot(
        [entry({ key: 'test.party.new', lineage: { renamedFrom: ['test.party.old'] }, selectors: ['assigned'] })],
        29,
      ),
    ),
  );
  expect(narrower?.kind).toBe('renamed');
  expect(narrower?.carriesCells).toBe(true);

  // A capability that named no selector reached every record, so record-scoping it to `all` is no wider.
  const [scoped] = succeeded(
    diffCatalogSnapshots(
      snapshot([entry({ key: 'test.party.old' })], 32),
      snapshot(
        [entry({ key: 'test.party.new', lineage: { renamedFrom: ['test.party.old'] }, selectors: ['all'] })],
        33,
      ),
    ),
  );
  expect(scoped?.carriesCells).toBe(true);
});

it('reports the risk of a split parent and of a removed capability', () => {
  const drafts = succeeded(
    diffCatalogSnapshots(
      snapshot(
        [
          entry({ key: 'test.party.split-source', risk: 'sensitive' }),
          entry({ key: 'test.party.gone', risk: 'critical' }),
        ],
        30,
      ),
      snapshot(
        [entry({ key: 'test.party.half', lineage: { splitFrom: 'test.party.split-source' }, risk: 'sensitive' })],
        31,
      ),
    ),
  );
  expect(drafts.find(({ kind }) => kind === 'split')?.previousRisk).toBe('sensitive');
  expect(drafts.find(({ kind }) => kind === 'removed')?.previousRisk).toBe('critical');
  // A split waits for review: it never carries the parent's cells.
  expect(drafts.find(({ kind }) => kind === 'split')?.carriesCells).toBe(false);
});
