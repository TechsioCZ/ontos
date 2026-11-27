import { expect, it } from 'effect-rstest';
import { Effect } from 'effect';

import { hasUniqueExactNamedImport } from '../../generated-module-api-boundary.mts';
import { patchOperationReadImport } from '../governed-contribution/scaffold.mts';
import { formatGeneratedMutationContent, isModuleManifestImport, isModuleRegistrationImport } from '../shared.mts';

it('accepts only canonical owner-local Action, Read and Worker registration imports', () => {
  const read = "import { currentDetailsRead } from './src/api/current-details.read.ts';";
  expect(isModuleManifestImport(read)).toBe(true);
  for (const candidate of [
    read,
    "import { createUnitAction } from './src/actions/create-unit.action.ts';",
    "import { reconcileUnitWorker } from './src/workers/reconcile-unit.worker.ts';",
  ]) {
    expect(isModuleRegistrationImport(candidate)).toBe(true);
  }
  for (const candidate of [
    "import { currentDetailsRead as renamed } from './src/api/current-details.read.ts';",
    "import { currentDetailsRead } from '../foreign/src/api/current-details.read.ts';",
    "import { currentDetailsRead } from './src/api/../private.ts';",
    "import * as privateReads from './src/api/current-details.read.ts';",
    "import { currentDetailsRead } from '@app/foreign/private';",
    "import { handler } from './src/api/current-details.read.ts';",
  ]) {
    expect(isModuleRegistrationImport(candidate)).toBe(false);
    expect(isModuleManifestImport(candidate)).toBe(false);
  }
});

it('accepts grouped owner-local Read imports without aliases or unrelated bindings', () => {
  const readModule = './src/api/current-details.read.ts';
  for (const bindings of [
    '{ currentDetailsRead, currentDetailsSetRead }',
    '{\n  currentDetailsRead,\n  currentDetailsSetRead,\n}',
  ]) {
    const candidate = `import ${bindings} from '${readModule}';`;
    expect(isModuleRegistrationImport(candidate)).toBe(true);
    expect(isModuleManifestImport(candidate)).toBe(true);
  }
  for (const bindings of [
    '{ currentDetailsRead, handler }',
    '{ currentDetailsRead, currentDetailsSetRead as renamed }',
    '{}',
    '{ currentDetailsRead, currentDetailsRead }',
    '{ currentDetailsRead, currentDetailsSetRead, currentDetailsSetRead }',
    '{ type currentDetailsRead, currentDetailsSetRead }',
  ]) {
    const candidate = `import ${bindings} from '${readModule}';`;
    expect(isModuleRegistrationImport(candidate)).toBe(false);
    expect(isModuleManifestImport(candidate)).toBe(false);
  }
  expect(
    isModuleManifestImport(
      "import { currentDetailsRead, currentDetailsSetRead } from '../foreign/src/api/current-details.read.ts';",
    ),
  ).toBe(false);
});

it.effect('formats identifier API keys while preserving required quoted slugs', () =>
  formatGeneratedMutationContent(
    '/workspace/verticals/catalog/vertical.manifest.ts',
    `export const manifest = {\n  publicSurface: {\n    api: {\n      configuration: ConfigurationApi,\n      'decision-explanation': DecisionExplanationApi,\n    },\n  },\n};\n`,
  ).pipe(
    Effect.tap((formatted) =>
      Effect.sync(() => {
        expect(formatted).toContain('configuration: ConfigurationApi,');
        expect(formatted).toContain("'decision-explanation': DecisionExplanationApi,");
      }),
    ),
  ),
);

const readName = 'current-details';
const importSlotStart = '// <generated-module-registration-imports>';
const importSlotEnd = '// </generated-module-registration-imports>';
const readSpecifier = './src/api/current-details.read.ts';
const ownerWithImport = (entry: string): string => `${importSlotStart}\n${entry}\n${importSlotEnd}\n`;

it('rerunning an operation scaffold preserves a grouped Read import byte for byte', () => {
  for (const bindings of [
    '{ currentDetailsRead, currentDetailsSetRead }',
    '{\n  currentDetailsRead,\n  currentDetailsSetRead,\n}',
  ]) {
    const source = ownerWithImport(`import ${bindings} from '${readSpecifier}';`);
    expect(patchOperationReadImport(source, importSlotStart, importSlotEnd, readName)).toBe(source);
  }
  const separate = ownerWithImport(
    `import { currentDetailsRead } from '${readSpecifier}';\nimport { currentDetailsSetRead } from '${readSpecifier}';`,
  );
  expect(patchOperationReadImport(separate, importSlotStart, importSlotEnd, readName)).toBe(separate);
});

it('adds an operation Read to a singleton from the same file without duplicating the import', () => {
  const source = ownerWithImport(`import { currentDetailsSetRead } from '${readSpecifier}';`);
  const patched = patchOperationReadImport(source, importSlotStart, importSlotEnd, readName);
  expect(patched).toBe(
    ownerWithImport(`import { currentDetailsRead, currentDetailsSetRead } from '${readSpecifier}';`),
  );
  expect(patchOperationReadImport(patched, importSlotStart, importSlotEnd, readName)).toBe(patched);
});

it('keeps operation Read import refusals for noncanonical bindings and conflicting identities', () => {
  for (const entry of [
    `import { currentDetailsRead as renamed } from '${readSpecifier}';`,
    `import { currentDetailsRead, currentDetailsSetRead as renamed } from '${readSpecifier}';`,
    `import currentDetailsRead from '${readSpecifier}';`,
    `import currentDetailsRead, { currentDetailsSetRead } from '${readSpecifier}';`,
    `import * as currentDetailsRead from '${readSpecifier}';`,
    `import type { currentDetailsRead } from '${readSpecifier}';`,
    `import { type currentDetailsRead, currentDetailsSetRead } from '${readSpecifier}';`,
    `import { currentDetailsRead, handler } from '${readSpecifier}';`,
    `import { currentDetailsRead, currentDetailsRead } from '${readSpecifier}';`,
    `import { currentDetailsRead } from '../foreign/src/api/current-details.read.ts';`,
    `import { handler } from '${readSpecifier}';`,
    `import { currentDetailsRead } from '${readSpecifier}';\nimport { currentDetailsRead } from '${readSpecifier}';`,
  ]) {
    expect(() => patchOperationReadImport(ownerWithImport(entry), importSlotStart, importSlotEnd, readName)).toThrow();
  }
});

it('recognizes one unaliased value binding within an exact grouped import', () => {
  expect(
    hasUniqueExactNamedImport(
      `import { currentDetailsRead, currentDetailsSetRead } from '${readSpecifier}';`,
      'currentDetailsRead',
      readSpecifier,
    ),
  ).toBe(true);
  for (const bindings of [
    '{ currentDetailsRead as renamed, currentDetailsSetRead }',
    '{ type currentDetailsRead, currentDetailsSetRead }',
    '{ currentDetailsRead, currentDetailsRead }',
    'currentDetailsRead, { currentDetailsSetRead }',
  ]) {
    expect(
      hasUniqueExactNamedImport(`import ${bindings} from '${readSpecifier}';`, 'currentDetailsRead', readSpecifier),
    ).toBe(false);
  }
});
