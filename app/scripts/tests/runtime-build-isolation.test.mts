import path from 'node:path';

import { build } from 'esbuild';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

const appRoot = path.resolve(import.meta.dirname, '../..');
const uiOwners = [
  'crm-activities',
  'crm',
  'facility-operations',
  'finance-billing',
  'legal-agreements',
  'merchandise',
  'property-leasing',
  'property-portfolio',
  'sales-insights',
  'sales-pipeline',
  'tagging',
  'work-tasks',
  'workforce',
];

for (const owner of uiOwners) {
  it.live(`bundles the ${owner} backend without loading its UI registration`, () =>
    Effect.gen(function* backendBuildIsolation() {
      // Match the backend federation codegen's eager CommonJS bundle, including dynamic imports.
      const bundle = yield* Effect.promise(() =>
        build({
          absWorkingDir: path.join(appRoot, 'verticals', owner, 'api'),
          bundle: true,
          entryPoints: ['./effect-api.ts'],
          format: 'cjs',
          logLevel: 'silent',
          metafile: true,
          platform: 'node',
          target: 'node20',
          write: false,
        }),
      );
      const inputs = Object.keys(bundle.metafile.inputs);
      expect(inputs.some((file) => file.endsWith('vertical.runtime-declaration.ts'))).toBe(true);
      expect(inputs.filter((file) => /(?:\.tsx$|\.css$|vertical\.(?:manifest|registration)\.ts$)/u.test(file))).toEqual(
        [],
      );
    }),
  );
}

it.live('bundles the market administration contract for browsers without server authorization or database code', () =>
  Effect.gen(function* marketContractBuildIsolation() {
    const bundle = yield* Effect.promise(() =>
      build({
        absWorkingDir: appRoot,
        bundle: true,
        entryPoints: ['verticals/commerce-market-catalog/shared/apis/market-administration.ts'],
        format: 'esm',
        logLevel: 'silent',
        metafile: true,
        platform: 'browser',
        write: false,
      }),
    );
    expect(
      Object.keys(bundle.metafile.inputs).filter((file) =>
        /(?:@authzed|@grpc|@effect\/sql-pg|core-runtime\/src\/(?:access|db|permissions)\/)/u.test(file),
      ),
    ).toEqual([]);
  }),
);
