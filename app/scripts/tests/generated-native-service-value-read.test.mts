import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { hasCompleteGeneratedModuleRead } from '../generated-governed-http-boundary.mts';

const root = path.resolve(import.meta.dirname, '../..');
const sources = new Map<string, string>();
const excluded = new Set(['.git', '.modern', '.output', 'coverage', 'dist', 'node_modules']);
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
collect('verticals/tax');
sources.set(
  'packages/core-runtime/package.json',
  readFileSync(path.join(root, 'packages/core-runtime/package.json'), 'utf-8'),
);

const owner = 'verticals/tax';
const read = 'seller-vat-regime-history';
const file = `${owner}/src/api/${read}.read.ts`;
const original = sources.get(file) ?? '';
const historyPipeline = 'context.services.declarations.history.pipe(';
const declarationService = 'seller-vat-regime-declaration.service.ts';
const accepts = (source: string, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(new Map([...sources, [file, source]]), file, owner, 'commerce.tax', read, diagnostics);

it('proves the actual scoped Seller VAT history Effect value and its native Option projection', () => {
  const diagnostics: string[] = [];
  expect(accepts(original, diagnostics), diagnostics.join('\n')).toBe(true);
});

for (const [name, dependency, before, after] of [
  [
    'shadowed record freezer',
    declarationService,
    'const MODULE_KEY =',
    'function shadow(Object: unknown) {}\nconst MODULE_KEY =',
  ],
  ['mutable Effect property', declarationService, 'readonly history:', 'history:'],
  [
    'non-native Effect implementation',
    declarationService,
    'Effect.gen(function* historyEffect()',
    'foreignHistory(function* historyEffect()',
  ],
  [
    'foreign Core transaction type',
    'tax-governance-persistence.ts',
    "import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';",
    "import type { OperationalScope, ReadServiceFactory } from './foreign-runtime.ts';",
  ],
  [
    'unexported transaction type',
    'tax-governance-persistence.ts',
    'export type ScopedTransaction =',
    'type ScopedTransaction =',
  ],
] as const) {
  it(`rejects the scoped Seller VAT history with a ${name}`, () => {
    const dependencyFile = `${owner}/src/services/${dependency}`;
    const dependencySource = sources.get(dependencyFile) ?? '';
    const invalid = dependencySource.replace(before, after);
    expect(invalid).not.toBe(dependencySource);
    expect(
      hasCompleteGeneratedModuleRead(
        new Map([...sources, [dependencyFile, invalid]]),
        file,
        owner,
        'commerce.tax',
        read,
      ),
    ).toBe(false);
  });
}

for (const [name, before, after] of [
  ['foreign receiver', historyPipeline, 'foreign.services.declarations.history.pipe('],
  ['undeclared member', historyPipeline, 'context.services.forged.history.pipe('],
  ['undeclared Effect value', historyPipeline, 'context.services.declarations.forged.pipe('],
  ['foreign Effect transform', 'Effect.flatMap(', 'ForeignEffect.flatMap('],
  ['foreign Option selection', 'Option.match({', 'ForeignOption.match({'],
  ['computed foreign Option selection', 'Option.match({', "ForeignOption['match']({"],
  [
    'foreign scoped factory',
    'sellerVatRegimeDeclarationsForScope(transaction, scope)',
    'foreignDeclarationsForScope(transaction, scope)',
  ],
  [
    'swapped scope and transaction',
    'sellerVatRegimeDeclarationsForScope(transaction, scope)',
    'sellerVatRegimeDeclarationsForScope(scope, transaction)',
  ],
  [
    'non-Effect service factory',
    '(transaction, scope) => Effect.succeed({ declarations: sellerVatRegimeDeclarationsForScope(transaction, scope) })',
    '() => ({ declarations: undefined })',
  ],
  [
    'replaced successful result',
    'onSome: (result) => Effect.succeed({ evidence: { resultCount: result.revisions.length }, result })',
    'onSome: (result) => foreignResult(result)',
  ],
] as const) {
  it(`rejects the scoped Seller VAT history with a ${name}`, () => {
    const invalid = original.replace(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(invalid), name).toBe(false);
  });
}
