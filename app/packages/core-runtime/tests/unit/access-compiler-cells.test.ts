import { Result } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  compileCompanyPreset,
  compileRoleCells,
  compileRoleTemplateCells,
  diffRoleCells,
} from '../../src/access/compiler/cells.ts';
import type { RoleEditorIntent, RoleTemplateIntent } from '../../src/access/compiler/cells.ts';
import { cellSlotKey } from '../../src/access/model.ts';
import { planAccessProjection } from '../../src/access/compiler/plan.ts';
import {
  AGENT,
  CAP_MARGINS,
  CAP_NOTE,
  CAP_PAY,
  SNAPSHOT,
  agentHolder,
  assignment,
  catalog,
  catalogEntry,
  catalogSnapshotId,
  ceiling,
  cell,
  capabilityKey,
  projectionIntent,
  revision,
  targetsSelector,
  templateKey,
} from './access-compiler-fixtures.ts';

const CAP_ARCHIVE = capabilityKey('party.registry.party.archive');
const CAP_LIMIT = capabilityKey('party.registry.party.approve');
const CAP_EXPORT = capabilityKey('party.registry.party.export');
const CAP_FUTURE = capabilityKey('party.registry.party.pay-later');

const baseCatalog = catalog([
  catalogEntry({ key: CAP_NOTE }),
  catalogEntry({ key: CAP_PAY, modes: ['run', 'propose'], selectors: ['all', 'assigned'] }),
  catalogEntry({ key: CAP_MARGINS, modes: ['run', 'propose'], risk: 'sensitive', selectors: ['assigned'] }),
  catalogEntry({ key: CAP_ARCHIVE, placement: { group: 'parties', level: 'manage' }, risk: 'sensitive' }),
  catalogEntry({ key: CAP_EXPORT, kind: 'export', risk: 'sensitive' }),
  catalogEntry({ amountInput: 'payload.amountMinor', key: CAP_LIMIT }),
]);

const editor = (overrides: Partial<RoleEditorIntent> = {}): RoleEditorIntent => ({
  catalog: baseCatalog,
  limits: [],
  rows: [{ group: 'parties', level: 'basic' }],
  switches: [],
  ...overrides,
});

const compile = (overrides: Partial<RoleEditorIntent> = {}) => {
  const compiled = compileRoleCells(editor(overrides));
  if (Result.isFailure(compiled)) {
    throw new Error(`expected cells, got ${compiled.failure.map((error) => error.code).join(', ')}`);
  }
  return compiled.success;
};

const failureCodes = (overrides: Partial<RoleEditorIntent> = {}): readonly string[] => {
  const compiled = compileRoleCells(editor(overrides));
  return Result.isFailure(compiled) ? compiled.failure.map((error) => error.code) : [];
};

it('compiles a level into the routine cells of that group, pinned to the snapshot', () => {
  const compiled = compile();
  expect(compiled.catalogSnapshotId).toBe(SNAPSHOT);
  // `pay` supports `all` and `assigned`, and a row that names neither gets the narrowest one: a level
  // never grants the scope-wide selector by default (D7a).
  expect(compiled.cells.map(cellSlotKey).toSorted()).toEqual([
    `${CAP_NOTE} run all`,
    `${CAP_LIMIT} run all`,
    `${CAP_PAY} propose assigned`,
    `${CAP_PAY} run assigned`,
  ]);
});

it('emits exactly the selector and modes the editor row chose (H7)', () => {
  const wide = compile({ rows: [{ group: 'parties', level: 'basic', selector: 'all' }] });
  expect(wide.cells.map(cellSlotKey).toSorted()).toEqual([
    `${CAP_NOTE} run all`,
    `${CAP_LIMIT} run all`,
    `${CAP_PAY} propose all`,
    `${CAP_PAY} run all`,
  ]);
  const runOnly = compile({ rows: [{ group: 'parties', level: 'basic', modes: ['run'] }] });
  expect(runOnly.cells.map(cellSlotKey).toSorted()).toEqual([
    `${CAP_NOTE} run all`,
    `${CAP_LIMIT} run all`,
    `${CAP_PAY} run assigned`,
  ]);
  // A row that asks for a mode or selector a capability does not declare drops that capability's cell
  // for this row instead of widening it to something the row did not choose.
  const assignedOnly = compile({
    catalog: catalog([catalogEntry({ key: CAP_PAY, selectors: ['all'] })]),
    rows: [{ group: 'parties', level: 'basic', selector: 'assigned' }],
  });
  expect(assignedOnly.cells).toEqual([]);
});

it('lets a switch name its own modes, so an agent profile keeps its routine cells (H7, O48a)', () => {
  // The switch names `propose` only: the sensitive `run` cell of that switch is absent and every
  // routine cell of the profile is still there, which the planner then accepts for an agent.
  const compiled = compile({ switches: [{ capabilityKey: CAP_MARGINS, modes: ['propose'] }] });
  expect(compiled.cells.filter((candidate) => candidate.capabilityKey === CAP_MARGINS).map(cellSlotKey)).toEqual([
    `${CAP_MARGINS} propose assigned`,
  ]);
  expect(compiled.cells.map(cellSlotKey)).toContain(`${CAP_PAY} run assigned`);

  const planned = planAccessProjection(
    projectionIntent(
      {
        assignments: [assignment({ holder: agentHolder(AGENT) })],
        roleRevisions: [revision({ cells: compiled.cells })],
      },
      { catalogEntries: baseCatalog.entries },
    ),
  );
  expect(Result.isSuccess(planned)).toBe(true);
});

it('refuses a switch that names a mode or selector its capability does not declare', () => {
  expect(failureCodes({ switches: [{ capabilityKey: CAP_PAY, modes: ['approve'] }] })).toContain(
    'access_projection_cell_outside_declaration',
  );
  expect(failureCodes({ switches: [{ capabilityKey: CAP_PAY, selector: 'team' }] })).toContain(
    'access_projection_cell_outside_declaration',
  );
  // A capability that is not record-scoped has one cell; naming another selector is refused, naming
  // `all` is the same cell.
  expect(failureCodes({ switches: [{ capabilityKey: CAP_NOTE, selector: 'team' }] })).toContain(
    'access_projection_cell_outside_declaration',
  );
  expect(failureCodes({ switches: [{ capabilityKey: CAP_NOTE, selector: 'all' }] })).toEqual([]);
});

it('never puts a sensitive capability into a level: it needs a named switch', () => {
  expect(compile().cells.some((candidate) => candidate.capabilityKey === CAP_MARGINS)).toBe(false);
  expect(
    compile({ switches: [{ capabilityKey: CAP_MARGINS }] }).cells.map((candidate) => candidate.capabilityKey),
  ).toContain(CAP_MARGINS);
  expect(
    compile({ switches: [{ capabilityKey: CAP_EXPORT }] }).cells.map((candidate) => candidate.capabilityKey),
  ).toContain(CAP_EXPORT);
});

it('does not follow a newer catalog snapshot, so a saved level never grows', () => {
  const extended = catalog([...baseCatalog.entries, catalogEntry({ key: CAP_FUTURE })], catalogSnapshotId(99));
  const pinned = compile();
  const again = compile();
  expect(again.cells).toEqual(pinned.cells);
  expect(pinned.cells.some((candidate) => candidate.capabilityKey === CAP_FUTURE)).toBe(false);
  const newer = compileRoleCells(editor({ catalog: extended }));
  expect(
    Result.isSuccess(newer) && newer.success.cells.some((candidate) => candidate.capabilityKey === CAP_FUTURE),
  ).toBe(true);
  expect(Result.isSuccess(newer) && newer.success.catalogSnapshotId).toBe(catalogSnapshotId(99));
});

it('includes the level ladder up to the chosen level and never a manage row at basic', () => {
  const basic = compile({ rows: [{ group: 'parties', level: 'basic' }] });
  const manage = compile({ rows: [{ group: 'parties', level: 'manage' }] });
  expect(basic.cells.some((candidate) => candidate.capabilityKey === CAP_ARCHIVE)).toBe(false);
  expect(manage.cells.some((candidate) => candidate.capabilityKey === CAP_ARCHIVE)).toBe(false);
  expect(manage.cells.length).toBe(basic.cells.length);
  expect(
    compile({
      rows: [{ group: 'parties', level: 'manage' }],
      switches: [{ capabilityKey: CAP_ARCHIVE }],
    }).cells.some((candidate) => candidate.capabilityKey === CAP_ARCHIVE),
  ).toBe(true);
});

it('applies a money limit to a capability that declares an amount input', () => {
  const compiled = compile({ limits: [{ amountCeiling: ceiling(250_000), capabilityKey: CAP_LIMIT }] });
  const limited = compiled.cells.filter((candidate) => candidate.capabilityKey === CAP_LIMIT);
  expect(limited).toHaveLength(1);
  expect(limited[0]?.amountCeiling).toEqual({ currency: 'CZK', limitMinor: 250_000 });
});

it('refuses a limit for a capability without an amount input and for an unknown key', () => {
  expect(failureCodes({ limits: [{ amountCeiling: ceiling(1), capabilityKey: CAP_PAY }] })).toContain(
    'access_projection_limit_without_amount_input',
  );
  expect(
    failureCodes({
      limits: [{ amountCeiling: ceiling(1), capabilityKey: capabilityKey('party.registry.party.nope') }],
    }),
  ).toContain('access_projection_unknown_capability');
  expect(failureCodes({ switches: [{ capabilityKey: capabilityKey('party.registry.party.nope') }] })).toContain(
    'access_projection_unknown_capability',
  );
  expect(failureCodes({ limits: [{ amountCeiling: ceiling(1), capabilityKey: CAP_NOTE }] })).toContain(
    'access_projection_limit_without_amount_input',
  );
});

it('refuses two limits or the same limit on a capability the role leaves out', () => {
  expect(
    failureCodes({
      limits: [
        { amountCeiling: ceiling(1), capabilityKey: CAP_LIMIT },
        { amountCeiling: ceiling(2), capabilityKey: CAP_LIMIT },
      ],
    }),
  ).toContain('access_projection_duplicate_intent');
  expect(
    failureCodes({
      limits: [{ amountCeiling: ceiling(1), capabilityKey: CAP_LIMIT }],
      rows: [{ group: 'warehouse', level: 'basic' }],
    }),
  ).toContain('access_projection_unknown_capability');
});

it('compiles a template and a company preset against one pinned snapshot', () => {
  const template: RoleTemplateIntent = {
    limits: [{ amountCeiling: ceiling(1000), capabilityKey: CAP_LIMIT }],
    rows: [{ group: 'parties', level: 'basic' }],
    switches: [{ capabilityKey: CAP_MARGINS }],
    templateKey: templateKey('sales.salesperson'),
  };
  const compiled = compileRoleTemplateCells(template, baseCatalog);
  expect(Result.isSuccess(compiled) && compiled.success.templateKey).toBe('sales.salesperson');
  expect(Result.isSuccess(compiled) && compiled.success.catalogSnapshotId).toBe(SNAPSHOT);
  const preset = compileCompanyPreset(
    [
      { ...template, name: 'Obchodník' },
      {
        ...template,
        name: 'Auditor',
        switches: [{ capabilityKey: CAP_EXPORT }],
        templateKey: templateKey('sales.auditor'),
      },
    ],
    baseCatalog,
  );
  expect(Result.isSuccess(preset) && preset.success.map((role) => role.name)).toEqual(['Obchodník', 'Auditor']);
  expect(
    Result.isSuccess(preset) &&
      preset.success.every((role) =>
        role.cells.every((candidate) => cellSlotKey(candidate).startsWith('party.registry.')),
      ),
  ).toBe(true);
});

it('reports an added cell and a raised limit as widening, and a removal as narrowing', () => {
  const before = compile();
  const added = diffRoleCells(before.cells, compile({ switches: [{ capabilityKey: CAP_MARGINS }] }).cells);
  expect(added.widens).toBe(true);
  // The switch grants the modes the capability declares: `run` and `propose` of `margins`.
  expect(added.added).toHaveLength(2);
  expect(added.removed).toEqual([]);

  const narrowed = diffRoleCells(before.cells, compile({ rows: [] }).cells);
  expect(narrowed.widens).toBe(false);
  expect(narrowed.removed.length).toBeGreaterThan(0);

  const cheaper = compile({ limits: [{ amountCeiling: ceiling(100), capabilityKey: CAP_LIMIT }] });
  const dearer = compile({ limits: [{ amountCeiling: ceiling(900), capabilityKey: CAP_LIMIT }] });
  expect(diffRoleCells(cheaper.cells, dearer.cells).widens).toBe(true);
  expect(diffRoleCells(dearer.cells, cheaper.cells).widens).toBe(false);
  expect(diffRoleCells(dearer.cells, cheaper.cells).changed).toHaveLength(1);
  expect(diffRoleCells(before.cells, before.cells)).toEqual({ added: [], changed: [], removed: [], widens: false });
});

it('reports a target list that gains a record as widening', () => {
  const before = [cell({ capabilityKey: CAP_PAY, mode: 'run', selector: targetsSelector(['invoice-1']) })];
  const after = [cell({ capabilityKey: CAP_PAY, mode: 'run', selector: targetsSelector(['invoice-1', 'invoice-2']) })];
  expect(diffRoleCells(before, after).widens).toBe(true);
  expect(diffRoleCells(after, before).widens).toBe(false);
  expect(diffRoleCells(before, after).changed[0]?.widens).toBe(true);
});
