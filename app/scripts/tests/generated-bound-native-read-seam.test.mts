import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { hasCompleteGeneratedModuleRead } from '../generated-governed-http-boundary.mts';

const ownerPath = 'verticals/tax';
const name = 'tax-materiality-comparison';
const readFile = `${ownerPath}/src/api/${name}.read.ts`;
const source = readFileSync(path.resolve(import.meta.dirname, '../..', readFile), 'utf-8');
const accepts = (input: string, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(new Map([[readFile, input]]), readFile, ownerPath, 'commerce.tax', name, diagnostics);

it('proves the actual bound conditional Tax load and unchanged empty native service factory', () => {
  const diagnostics: string[] = [];
  expect(accepts(source, diagnostics), diagnostics.join('\n')).toBe(true);
  expect(diagnostics).toEqual([]);
});

for (const [defect, before, after] of [
  ['foreign Effect receiver', "from 'effect'", "from './foreign-effect.ts'"],
  ['foreign success branch', '? Effect.succeed(', '? foreign.succeed('],
  ['foreign failure branch', ': Effect.fail(', ': foreign.fail('],
  [
    'opaque success wrapper',
    '? Effect.succeed({ evidence: { resultCount: 1 }, result: compareTaxMateriality(input, taxMeaningFingerprint) })',
    '? opaque(Effect.succeed({ evidence: { resultCount: 1 }, result: compareTaxMateriality(input, taxMeaningFingerprint) }))',
  ],
  ['unbound load', '{ load: readTaxMaterialityComparison }', '{ load: foreignLoad }'],
  ['rebound load', 'export const readTaxMaterialityComparison', 'export let readTaxMaterialityComparison'],
] as const) {
  it(`rejects the bound conditional Tax Read with ${defect}`, () => {
    const invalid = source.replace(before, after);
    expect(invalid).not.toBe(source);
    expect(parseSync(readFile, invalid).errors).toEqual([]);
    expect(accepts(invalid)).toBe(false);
  });
}

it('rejects native-looking branches with a shadowed or mutated Effect identity', () => {
  for (const mutation of ['const Effect = foreign;', 'Effect.fail = foreign;', 'function shadow(Effect) {}']) {
    expect(accepts(`${source}\n${mutation}`), mutation).toBe(false);
  }
});
