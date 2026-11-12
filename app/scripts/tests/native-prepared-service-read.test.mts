import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { hasCompleteGeneratedModuleRead } from '../generated-governed-http-boundary.mts';

const root = path.resolve(import.meta.dirname, '../..');
const excludedDirectories = new Set([
  '.codex',
  '.git',
  '.modern',
  '.output',
  'coverage',
  'dist',
  'dist-cloudflare',
  'node_modules',
]);

const sources = new Map<string, string>();

const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      collect(file);
    } else if (entry.isFile() && /\.(?:ts|mts|json)$/u.test(file)) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
};

// Every owner whose Read seam this file proves, plus the whole workspace metadata the exported seam
// resolves owner-local imports through.
collect('verticals');
collect('packages');

interface GovernedRead {
  readonly moduleId: string;
  readonly name: string;
  readonly owner: string;
}

const preparedServiceReads: readonly GovernedRead[] = [
  { moduleId: 'crm.activities', name: 'records', owner: 'verticals/crm-activities' },
  { moduleId: 'demo.sales-insights', name: 'records', owner: 'verticals/sales-insights' },
  { moduleId: 'demo.tagging', name: 'records', owner: 'verticals/tagging' },
  { moduleId: 'demo.workforce', name: 'records', owner: 'verticals/workforce' },
];

const readFile = ({ name, owner }: GovernedRead): string => `${owner}/src/api/${name}.read.ts`;
const serviceFile = ({ owner }: GovernedRead): string => `${owner}/src/services/persistence.service.ts`;

const accepts = (read: GovernedRead, input: ReadonlyMap<string, string> = sources, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(input, readFile(read), read.owner, read.moduleId, read.name, diagnostics);

const withRead = (read: GovernedRead, source: string): ReadonlyMap<string, string> =>
  new Map([...sources, [readFile(read), source]]);

const inventoryModuleId = 'commerce.inventory';
const inventoryOwner = 'verticals/inventory';
const positionSetRead: GovernedRead = {
  moduleId: inventoryModuleId,
  name: 'current-relevant-stock-position-set',
  owner: inventoryOwner,
};

it('proves the real conditional Position-set load through its readonly owner Effect result', () => {
  const diagnostics: string[] = [];
  expect(accepts(positionSetRead, sources, diagnostics), diagnostics.join('\n')).toBe(true);
});

for (const [name, original, replacement] of [
  [
    'foreign context',
    'context.services.observe(input.scope, context.prepared)',
    'foreign.services.observe(input.scope, context.prepared)',
  ],
  ['mutable result contract', 'readonly observe:', 'observe:'],
  [
    'unknown Effect transform',
    'context.prepared).pipe(Effect.mapError(mapPositionSetReadFailure))',
    'context.prepared).pipe(Effect.unknownProperty(mapPositionSetReadFailure))',
  ],
  ['unbound observation', '../persistence/current-relevant-stock-position-set-repository.ts', '../foreign-owner.ts'],
  [
    'caller scope in positionSetServices',
    'observeUnsettledPositionSet(transaction, scope, requested, prepared)',
    'observeUnsettledPositionSet(transaction, input.scope, requested, prepared)',
  ],
  [
    'a foreign scope in the service factory',
    'positionSetServices: ReadServiceFactory<PositionSetServices> = (transaction, scope) =>',
    'positionSetServices: ReadServiceFactory<PositionSetServices> = (transaction, scope) => foreign ??',
  ],
  ['an extra service member', 'Effect.succeed({\n    observe:', 'Effect.succeed({\n    leak: foreign,\n    observe:'],
  ['a changed settled-result branch', "if (prepared.kind === 'RESULT')", "if (prepared.kind !== 'RESULT')"],
  [
    'an observation instead of the settled result',
    'return Option.none<RelevantStockPositionSetObservation>();',
    'return Option.some(foreign);',
  ],
  [
    'a substituted scope in the owner observation',
    'observeRelevantStockPositionSet(transaction, scope, requested)',
    'observeRelevantStockPositionSet(transaction, requested, requested)',
  ],
  [
    'a foreign observation',
    'Option.some(yield* observeRelevantStockPositionSet(',
    'Option.some(yield* foreignObserve(',
  ],
] as const) {
  it(`rejects a conditional Position-set load with ${name}`, () => {
    const source = sources.get(readFile(positionSetRead)) ?? '';
    expect(source).toContain(original);
    expect(accepts(positionSetRead, withRead(positionSetRead, source.replace(original, replacement)))).toBe(false);
  });
}

for (const read of preparedServiceReads) {
  it(`proves the native prepared-service load of ${read.moduleId} ${read.name}`, () => {
    const diagnostics: string[] = [];
    expect(accepts(read, sources, diagnostics), diagnostics.join('\n')).toBe(true);
    expect(diagnostics, diagnostics.join('\n')).toEqual([]);
  });
}

const preparedPredicate = 'context.prepared.predicate';
const unavailableFailure = `new ReadHandlerUnavailable({
          code: 'read_handler_unavailable',
          reason: 'Records are temporarily unavailable',
        })`;

const preparedServiceLoadDefects: readonly (readonly [string, string, string])[] = [
  ['a rebound service alias', 'context.services', 'services'],
  ['a foreign service receiver', 'context.services', 'foreign.services'],
  ['an unknown service method', '.loadRecords(', '.foreignRecords('],
  ['a writer method from the same scoped factory', '.loadRecords(', '.apply('],
  ['a side effect inside the failure mapper', 'Match.value(failure)', 'Match.value((fetch("/leak"), failure))'],
  [
    'a hidden effect inside a failure mapper arm',
    `        ${unavailableFailure},`,
    `        (Effect.runSync(leakEffect), ${unavailableFailure}),`,
  ],
  ['a foreign service factory', 'persistenceService(transaction, { scope })', 'foreignService(transaction, { scope })'],
  ['an input-rooted argument', preparedPredicate, 'input.predicate'],
  ['a loaded argument instead of a prepared one', preparedPredicate, 'context.loaded.predicate'],
  ['a foreign context projection', preparedPredicate, 'other.prepared.predicate'],
  ['a foreign failure mapper', 'Effect.mapError(readFailure)', 'Effect.mapError(foreignFailure)'],
  [
    'an extra pipeline transform',
    '.pipe(Effect.mapError(readFailure))',
    '.pipe(Effect.mapError(readFailure), Effect.asVoid)',
  ],
  ['a foreign Effect import', "from 'effect'", "from './foreign-effect.ts'"],
];

for (const read of preparedServiceReads) {
  const source = sources.get(readFile(read)) ?? '';

  for (const [defect, before, after] of preparedServiceLoadDefects) {
    it(`rejects the ${read.moduleId} ${read.name} prepared-service load with ${defect}`, () => {
      const invalid = source.replaceAll(before, after);
      expect(invalid, before).not.toBe(source);
      expect(parseSync(readFile(read), invalid).errors).toEqual([]);
      expect(accepts(read, withRead(read, invalid))).toBe(false);
    });
  }

  it(`rejects the ${read.moduleId} ${read.name} prepared-service load with a rebound Effect member`, () => {
    const invalid = `${source}\nEffect.mapError = foreign;\n`;
    expect(invalid).not.toBe(source);
    expect(parseSync(readFile(read), invalid).errors).toEqual([]);
    expect(accepts(read, withRead(read, invalid))).toBe(false);
  });

  it(`rejects the ${read.moduleId} ${read.name} prepared-service load when its factory record omits the method`, () => {
    const service = sources.get(serviceFile(read)) ?? '';
    const invalidService = service.replace('return { apply, loadRecords };', 'return { apply };');
    expect(invalidService).not.toBe(service);
    expect(parseSync(serviceFile(read), invalidService).errors).toEqual([]);
    expect(accepts(read, new Map([...sources, [serviceFile(read), invalidService]]))).toBe(false);
  });
}

// G2: the phase-reference roots check classifies projections by their root, so a request field whose
// name matches a context projection (`input.scope`) is data. Whether these two Reads pass the seam is
// owned by their own load families; only the projection classification is asserted here.
const projectionRead: GovernedRead = {
  moduleId: inventoryModuleId,
  name: 'current-relevant-stock-position-set',
  owner: inventoryOwner,
};

const guardedBlockLoadRead: GovernedRead = {
  moduleId: inventoryModuleId,
  name: 'stock-sharing-eligibility-resolution',
  owner: inventoryOwner,
};

for (const read of [projectionRead, guardedBlockLoadRead]) {
  it(`reads the ${read.name} request field as data rather than a foreign context projection`, () => {
    const diagnostics: string[] = [];
    accepts(read, sources, diagnostics);
    expect(diagnostics).not.toContain('phase references: roots');
    expect(diagnostics).not.toContain('bound load: references');
  });
}

it('still rejects a foreign context projection masquerading as the phase context', () => {
  const source = sources.get(readFile(projectionRead)) ?? '';
  const invalid = source.replace('observe(input.scope, context.prepared)', 'observe(input.scope, foreign.prepared)');
  expect(invalid).not.toBe(source);
  expect(parseSync(readFile(projectionRead), invalid).errors).toEqual([]);
  const diagnostics: string[] = [];
  expect(accepts(projectionRead, withRead(projectionRead, invalid), diagnostics)).toBe(false);
  expect(diagnostics).toContain(`${projectionRead.name}: callbacks`);
});
