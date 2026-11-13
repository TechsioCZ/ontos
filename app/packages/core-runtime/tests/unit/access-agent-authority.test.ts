import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  agentUsableCapabilities,
  agentUseOfCell,
  consentCeilingOf,
} from '../../src/access/lifecycle/agent-authority.ts';
import { CapabilityKeySchema } from '../../src/access/ids.ts';
import { CatalogSnapshotEntrySchema } from '../../src/access/model.ts';
import type { AccessKind, AccessMode, AccessRisk, CatalogSnapshotEntry, Cell } from '../../src/access/model.ts';

const entry = (key: string, kind: AccessKind, risk: AccessRisk): CatalogSnapshotEntry =>
  Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)({
    key,
    kind,
    modes: kind === 'admin' ? ['run'] : ['run', 'propose', 'approve'],
    moduleKey: key.split('.').slice(0, 2).join('.'),
    placement: { group: 'g', level: 'manage' },
    risk,
    selectors: ['all'],
  });

const cellOf = (key: string, mode: AccessMode): Cell => ({
  capabilityKey: CapabilityKeySchema.make(key),
  mode,
  selector: { _tag: 'all' },
});

const read = entry('work.tasks.read', 'read', 'routine');
const create = entry('work.tasks.create', 'action', 'routine');
const voidInvoice = entry('finance.invoices.void', 'action', 'sensitive');
const exportLedger = entry('finance.ledger.export', 'export', 'sensitive');
const administer = entry('work.tasks.administer', 'admin', 'critical');
const catalog = [read, create, voidInvoice, exportLedger, administer];

describe('what an agent can use of its roles', () => {
  it('uses a routine run itself, a proposal as a proposal, and never approval or administration', () => {
    expect(agentUseOfCell(cellOf('work.tasks.read', 'run'), read)).toBe('direct');
    expect(agentUseOfCell(cellOf('work.tasks.create', 'propose'), create)).toBe('approval');
    expect(agentUseOfCell(cellOf('work.tasks.create', 'approve'), create)).toBeUndefined();
    expect(agentUseOfCell(cellOf('work.tasks.administer', 'run'), administer)).toBeUndefined();
    // A sensitive run is decided on the propose cells: the run cell alone gives an agent nothing.
    expect(agentUseOfCell(cellOf('finance.invoices.void', 'run'), voidInvoice)).toBeUndefined();
    expect(agentUseOfCell(cellOf('finance.invoices.void', 'propose'), voidInvoice)).toBe('approval');
    // A sensitive read is never an agent's.
    expect(agentUseOfCell(cellOf('finance.ledger.export', 'run'), exportLedger)).toBeUndefined();
  });

  it('summarises a role with an administrative cell without that cell, direct before approval', () => {
    const usable = agentUsableCapabilities(
      [
        cellOf('work.tasks.administer', 'run'),
        cellOf('work.tasks.create', 'propose'),
        cellOf('work.tasks.create', 'run'),
        cellOf('work.tasks.read', 'run'),
        cellOf('unknown.capability.read', 'run'),
      ],
      catalog,
    );
    expect(usable.map(({ entry: { key }, use }) => [key, use])).toEqual([
      ['work.tasks.create', 'direct'],
      ['work.tasks.read', 'direct'],
    ]);
  });

  it('keeps only consented modules in the ceiling, and only reading in a module consented for reading', () => {
    const cells = [
      cellOf('work.tasks.read', 'run'),
      cellOf('work.tasks.create', 'run'),
      cellOf('work.tasks.administer', 'run'),
      cellOf('finance.invoices.void', 'propose'),
    ];
    const readOnly = consentCeilingOf({ catalog, cells, modules: [{ access: 'read', moduleId: 'work.tasks' }] });
    expect(readOnly.cells.map(({ capabilityKey, mode }) => `${capabilityKey} ${mode}`)).toEqual([
      'work.tasks.read run',
    ]);
    const everything = consentCeilingOf({ catalog, cells, modules: 'all' });
    expect(everything.cells.map(({ capabilityKey, mode }) => `${capabilityKey} ${mode}`)).toEqual([
      'work.tasks.read run',
      'work.tasks.create run',
      'finance.invoices.void propose',
    ]);
    expect(everything.cells.every(({ selector }) => selector._tag === 'all')).toBe(true);
  });
});
