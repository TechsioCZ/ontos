import { readFileSync } from 'node:fs';

import { Array as EffectArray, Order } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { coreRuntimeValueReExports, focusedEntrypointValueExports } from '../materialize-outbox-worker.mjs';

const workerEntrypointPath = '../../packages/core-runtime/src/outbox/worker-entrypoint.ts';

it('reads live value re-exports from Core, ignoring comments, strings, and type-only ones', () => {
  const source = [
    "export { ContextAccessLive as outboxWorkerContextAccessLive } from '@app/core-runtime';",
    "export { type OutboxRuntime, BusinessPermissionRelationshipMutationLive } from '@app/core-runtime';",
    "export type { AnyOutboxWorkerRegistration } from '@app/core-runtime';",
    "export { defineOutboxWorkerCompletion as completion } from '@app/core-runtime/outbox/worker';",
    "// export { RemovedBinding } from '@app/core-runtime';",
    "/* export { AlsoRemoved } from '@app/core-runtime'; */",
    "console.log(`export { FromString } from '@app/core-runtime'`);",
    "export { other } from '@app/core-runtime/testing/actions';",
    "export { local } from './local.ts';",
  ].join('\n');
  expect(EffectArray.sort(coreRuntimeValueReExports('layer.ts', source), Order.String)).toEqual([
    'BusinessPermissionRelationshipMutationLive',
    'ContextAccessLive',
    'defineOutboxWorkerCompletion',
  ]);
});

it('reads only live value exports of the focused entrypoint', () => {
  const exports = focusedEntrypointValueExports(
    [
      "export { Live, Other as Renamed } from './live.ts';",
      "// export { CommentedOut } from './gone.ts';",
      "export { type OnlyType } from './types.ts';",
      "export type { AlsoType } from './types.ts';",
    ].join('\n'),
  );
  expect(EffectArray.sort([...exports], Order.String)).toEqual(['Live', 'Renamed']);
});

it('routes hosted worker enrollment through its owning subpath, not the focused Core entrypoint', () => {
  const entrypoint = focusedEntrypointValueExports(
    readFileSync(new URL(workerEntrypointPath, import.meta.url), 'utf-8'),
  );
  const workerRoots = [
    'apps/shell-super-app/src/entry.core-system-worker.ts',
    ...['commerce-customer-context', 'price-group-catalog', 'privacy', 'finance-billing', 'inventory'].map(
      (owner) => `verticals/${owner}/src/worker-host/entry.ts`,
    ),
    ...[
      'crm',
      'facility-operations',
      'legal-agreements',
      'property-leasing',
      'property-portfolio',
      'sales-pipeline',
      'work-tasks',
    ].map((owner) => `verticals/${owner}/src/worker-host/layer.ts`),
  ];
  for (const filename of workerRoots) {
    const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf-8');
    const imports = parseSync(filename, source).module.staticImports.flatMap((statement) =>
      statement.entries
        .filter((entry) => !entry.isType)
        .map((entry) => ({ name: entry.importName.name, specifier: statement.moduleRequest.value })),
    );
    expect(
      imports.filter(({ name }) => name === 'defineDatabaseIdentityEnrollment').map(({ specifier }) => specifier),
      filename,
    ).toEqual(['@app/core-runtime/db/database-identity-manifest']);
    for (const { name, specifier } of imports) {
      if (specifier === '@app/core-runtime' || specifier === '@app/core-runtime/outbox/worker') {
        expect(entrypoint.has(name ?? ''), `${filename} imports ${name} from ${specifier}`).toBe(true);
      }
    }
  }
  expect(entrypoint.has('makeDatabaseIdentityEnrollmentLive')).toBe(true);
  expect(entrypoint.has('CoreSearchQueryRuntime')).toBe(true);
  expect(entrypoint.has('CoreSearchProjectionInvalid')).toBe(true);
  expect(entrypoint.has('defineDatabaseIdentityEnrollment')).toBe(false);
});

it('exports every Core value the deployed worker hosts re-export', () => {
  const entrypoint = focusedEntrypointValueExports(
    readFileSync(new URL(workerEntrypointPath, import.meta.url), 'utf-8'),
  );
  const layerPath = '../../verticals/commerce-customer-context/src/worker-host/layer.ts';
  const reExports = coreRuntimeValueReExports('layer.ts', readFileSync(new URL(layerPath, import.meta.url), 'utf-8'));
  // The fixture re-exports the Core values its worker handlers need; the guard keeps it non-trivial.
  expect(reExports).toContain('CorePersistenceLive');
  for (const name of reExports) {
    expect(entrypoint.has(name), name).toBe(true);
  }
  expect(entrypoint.has('AnyOutboxWorkerRegistration')).toBe(false);
});

it('exports the Core values used by the hosted search snapshot projectors', () => {
  const entrypoint = focusedEntrypointValueExports(
    readFileSync(new URL(workerEntrypointPath, import.meta.url), 'utf-8'),
  );
  for (const owner of ['sales-pipeline', 'work-tasks']) {
    const filename = `verticals/${owner}/src/services/search-projection.ts`;
    const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf-8');
    const imports = parseSync(filename, source).module.staticImports.flatMap((statement) =>
      statement.moduleRequest.value === '@app/core-runtime'
        ? statement.entries.filter((entry) => !entry.isType).map((entry) => entry.importName.name ?? '')
        : [],
    );
    expect(imports, filename).toContain('CoreSearchProjectionReplacementSchema');
    for (const name of imports) {
      expect(entrypoint.has(name), `${filename} imports ${name} from the focused worker entrypoint`).toBe(true);
    }
  }
});
