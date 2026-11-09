import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { hasOriginalReadServiceFactoryProvenance } from '../generated-governed-http-boundary.mts';

const root = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/inventory';
const excludedDirectories = new Set(['.codex', '.git', '.modern', '.output', 'coverage', 'dist', 'node_modules']);
const sources = new Map<string, string>();

const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      collect(file);
    } else if (entry.isFile() && /\.(?:ts|json)$/u.test(file)) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
};

// The owner's own sources plus the workspace metadata every owner-local import is resolved through.
collect(owner);
collect('packages');

const reads = {
  catalogToStockBindingResolution: 'catalog-to-stock-binding-resolution',
  commitmentProtectionVerification: 'commitment-protection-verification',
  currentStockEvidenceForAvailability: 'current-stock-evidence-for-availability',
  inventoryBackendConfigurationCurrent: 'inventory-backend-configuration-current',
  inventoryEffectOutcome: 'inventory-effect-outcome',
  inventoryReconciliationEvidence: 'inventory-reconciliation-evidence',
  inventorySourceConflictDetail: 'inventory-source-conflict-detail',
  stockSharingEligibilityResolution: 'stock-sharing-eligibility-resolution',
} as const;
const inventoryReads: readonly string[] = Object.values(reads);

const readFile = (name: string): string => `${owner}/src/api/${name}.read.ts`;
const persistenceFile = (stem: string): string => `${owner}/src/persistence/${stem}.ts`;
const factoryProven = (name: string, input: ReadonlyMap<string, string> = sources): boolean =>
  hasOriginalReadServiceFactoryProvenance(input, readFile(name), owner);
const changed = (file: string, before: string, after: string): ReadonlyMap<string, string> => {
  const source = sources.get(file) ?? '';
  expect(source, file).toContain(before);
  const mutated = source.replace(before, after);
  expect(parseSync(file, mutated).errors, `${file}: ${before}`).toEqual([]);
  return new Map([...sources, [file, mutated]]);
};

const untrustedScope = 'an untrusted scope argument';
const counterfeitAdapter = 'a counterfeit owner-local adapter';
const commitmentProtectionForScope = 'commitmentProtectionPersistenceForScope(transaction, scope)';

it('observes the original scoped factory provenance of every Inventory Read on its own', () => {
  for (const name of inventoryReads) {
    expect(factoryProven(name), name).toBe(true);
  }
});

it('rejects a scopeless genuine Core scope type on the actual Inventory factories', () => {
  expect(
    factoryProven(
      reads.commitmentProtectionVerification,
      changed(
        persistenceFile('commitment-protection-repository'),
        "operationScope: Pick<OperationalScope, 'tenantId'>,",
        'operationScope: unknown,',
      ),
    ),
  ).toBe(false);
  expect(
    factoryProven(
      reads.stockSharingEligibilityResolution,
      changed(
        persistenceFile('stock-sharing-eligibility-repository'),
        'operationScope: OperationalScope,',
        'operationScope: unknown,',
      ),
    ),
  ).toBe(false);
});

it('rejects a foreign Core scope type on the actual Inventory factories', () => {
  expect(
    factoryProven(
      reads.inventorySourceConflictDetail,
      changed(
        persistenceFile('inventory-source-conflict-repository'),
        "import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';",
        "import type { ReadServiceFactory } from '@app/core-runtime';\nimport type { OperationalScope } from '@app/foreign-runtime';",
      ),
    ),
  ).toBe(false);
});

const tamperedFactories: readonly (readonly [string, string, string, string])[] = [
  [
    reads.catalogToStockBindingResolution,
    untrustedScope,
    'inventoryBackendConfigurationPersistenceForScope(transaction, scope).findCurrent',
    'inventoryBackendConfigurationPersistenceForScope(transaction, untrustedScope).findCurrent',
  ],
  [
    reads.catalogToStockBindingResolution,
    'a dropped scope parameter',
    '  transaction,\n  scope,\n) => {',
    '  transaction,\n) => {',
  ],
  [
    reads.commitmentProtectionVerification,
    untrustedScope,
    commitmentProtectionForScope,
    'commitmentProtectionPersistenceForScope(transaction, untrustedScope)',
  ],
  [
    reads.commitmentProtectionVerification,
    'a reordered trusted pair',
    commitmentProtectionForScope,
    'commitmentProtectionPersistenceForScope(scope, transaction)',
  ],
  [
    reads.commitmentProtectionVerification,
    'a foreign factory name',
    commitmentProtectionForScope,
    'foreignPersistenceForScope(transaction, scope)',
  ],
  [
    reads.currentStockEvidenceForAvailability,
    untrustedScope,
    'currentStockEvidenceForAvailabilityDependenciesForScope(transaction, scope)',
    'currentStockEvidenceForAvailabilityDependenciesForScope(transaction, untrustedScope)',
  ],
  [
    reads.inventoryBackendConfigurationCurrent,
    untrustedScope,
    'inventoryBackendConfigurationPersistenceForScope(transaction, scope)',
    'inventoryBackendConfigurationPersistenceForScope(transaction, untrustedScope)',
  ],
  [
    reads.inventoryBackendConfigurationCurrent,
    counterfeitAdapter,
    'makeInventoryBackendConfigurationService(inventoryBackendConfigurationPersistenceForScope(transaction, scope))',
    'makeForeignBackendConfigurationService(inventoryBackendConfigurationPersistenceForScope(transaction, scope))',
  ],
  [
    reads.inventoryEffectOutcome,
    untrustedScope,
    'inventoryEffectLedgerPersistenceForScope(transaction, scope)',
    'inventoryEffectLedgerPersistenceForScope(transaction, untrustedScope)',
  ],
  [
    reads.inventoryReconciliationEvidence,
    counterfeitAdapter,
    'makeInventoryReconciliationEvidenceService({',
    'makeForeignReconciliationEvidenceService({',
  ],
  [
    reads.inventorySourceConflictDetail,
    counterfeitAdapter,
    'makeInventorySourceConflictService({',
    'makeForeignSourceConflictService({',
  ],
  [
    reads.stockSharingEligibilityResolution,
    untrustedScope,
    'stockSharingEligibilityPersistenceForScope(transaction, scope)',
    'stockSharingEligibilityPersistenceForScope(transaction, untrustedScope)',
  ],
];

for (const [name, defect, before, after] of tamperedFactories) {
  it(`rejects ${defect} in the actual ${name} factory`, () => {
    expect(factoryProven(name, changed(readFile(name), before, after))).toBe(false);
  });
}

it('rejects an undeclared member of a genuine scoped repository', () => {
  expect(
    factoryProven(
      reads.catalogToStockBindingResolution,
      changed(
        readFile(reads.catalogToStockBindingResolution),
        'inventoryBackendConfigurationPersistenceForScope(transaction, scope).findCurrent',
        'inventoryBackendConfigurationPersistenceForScope(transaction, scope).forged',
      ),
    ),
  ).toBe(false);
});

it('rejects an unused executable initializer in a scoped factory block', () => {
  expect(
    factoryProven(
      reads.inventoryEffectOutcome,
      changed(
        readFile(reads.inventoryEffectOutcome),
        '  const persistence = inventoryEffectLedgerPersistenceForScope(transaction, scope);',
        '  const ignored = foreignSideEffect(transaction);\n  const persistence = inventoryEffectLedgerPersistenceForScope(transaction, scope);',
      ),
    ),
  ).toBe(false);
});

it('rejects an imported owner adapter that discards its scoped repository', () => {
  const adapterFile = `${owner}/src/services/inventory-backend-configuration.service.ts`;
  const source = sources.get(adapterFile) ?? '';
  const renamed = source.replace(
    'export const makeInventoryBackendConfigurationService = (',
    'export const originalBackendConfigurationService = (',
  );
  expect(renamed).not.toBe(source);
  const forged = `${renamed}\nexport const makeInventoryBackendConfigurationService = (_persistence: InventoryBackendConfigurationPersistence) => ({ findCurrent: () => Effect.succeed(Option.none()) });\n`;
  expect(parseSync(adapterFile, forged).errors).toEqual([]);
  expect(factoryProven(reads.inventoryBackendConfigurationCurrent, new Map([...sources, [adapterFile, forged]]))).toBe(
    false,
  );
});

it('rejects a factory proven against a missing owner source', () => {
  const incomplete = new Map(sources);
  expect(incomplete.delete(persistenceFile('commitment-protection-repository'))).toBe(true);
  expect(factoryProven(reads.commitmentProtectionVerification, incomplete)).toBe(false);
});
