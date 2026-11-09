import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { hasCompleteGeneratedModuleRead } from '../generated-governed-http-boundary.mts';

// The Catalog Assortment classification reads start their load from an owner-local read dependency, and the
// Assortment configuration/decision/purchase reads start theirs from the read's own typed services projection.
// Both are the generated shape of a native scoped Read; these tests pin the real sources and the tampering
// shapes (foreign receiver, foreign transform, foreign dependency, swapped arguments) that must stay rejected.
const root = path.resolve(import.meta.dirname, '../..');
const excluded = new Set(['.git', '.modern', '.output', 'coverage', 'dist', 'node_modules']);
const sources = new Map<string, string>();
const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excluded.has(entry.name)) {
      collect(file);
    } else if (entry.isFile() && /\.(?:ts|mts|json)$/u.test(file)) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
};
collect('verticals');
collect('packages');

interface OwnerRead {
  readonly moduleId: string;
  readonly name: string;
  readonly owner: string;
}

const catalog = (name: string): OwnerRead => ({ moduleId: 'commerce.catalog', name, owner: 'verticals/catalog' });
const assortment = (name: string): OwnerRead => ({
  moduleId: 'commerce.assortment',
  name,
  owner: 'verticals/assortment',
});

const readFile = (read: OwnerRead): string => `${read.owner}/src/api/${read.name}.read.ts`;
const readSource = (read: OwnerRead): string => sources.get(readFile(read)) ?? '';
const accepts = (read: OwnerRead, source: string, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(
    new Map([...sources, [readFile(read), source]]),
    readFile(read),
    read.owner,
    read.moduleId,
    read.name,
    diagnostics,
  );

const assortmentClassification = catalog('assortment-product-classification-v1');
const assortmentSetComposition = catalog('assortment-set-composition-v1');
const configuration = assortment('configuration');
const configurationLoadCall = 'context.services.configuration.read(input)';
const purchase = assortment('purchase');

it('proves the real owner-dependency and typed-services native scoped Read loads', () => {
  for (const read of [assortmentClassification, assortmentSetComposition, configuration, purchase]) {
    const diagnostics: string[] = [];
    expect(accepts(read, readSource(read), diagnostics), `${readFile(read)}\n${diagnostics.join('\n')}`).toBe(true);
  }
});

for (const [name, read, before, after] of [
  // The pipeline may only start from the owner-local read dependency, not from any other callee.
  [
    'foreign read dependency',
    assortmentClassification,
    'observeOrVerifyAssortmentProductClassificationV1(input.request, tenantId, source)',
    'foreignObserve(input.request, tenantId, source)',
  ],
  // A phase may only project its own typed services, never another receiver.
  ['foreign services receiver', configuration, configurationLoadCall, 'foreign.services.configuration.read(input)'],
  ['undeclared service method', configuration, configurationLoadCall, 'context.services.configuration.forged(input)'],
  ['undeclared service member', configuration, configurationLoadCall, 'context.services.forged.read(input)'],
  // Every pipeline stage must stay a native Effect combinator.
  ['foreign Effect transform', assortmentSetComposition, 'Effect.map((result) =>', 'ForeignEffect.map((result) =>'],
  // The trusted projections keep their positions: the input stays first, the services stay last.
  [
    'swapped services projection',
    assortmentSetComposition,
    'readAssortmentSetCompositionV1(input, context.scope.tenantId, context.services)',
    'readAssortmentSetCompositionV1(context.scope.tenantId, input, context.services)',
  ],
] as const) {
  it(`rejects the native scoped Read load with a ${name}`, () => {
    const original = readSource(read);
    const invalid = original.replace(before, after);
    expect(invalid, `${name}: mutation must change the source`).not.toBe(original);
    expect(parseSync(readFile(read), invalid).errors).toEqual([]);
    expect(accepts(read, invalid), name).toBe(false);
  });
}
