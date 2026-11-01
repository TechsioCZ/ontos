import { expect, it } from 'effect-rstest';
import { Effect } from 'effect';

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
